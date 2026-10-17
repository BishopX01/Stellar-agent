import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { z, ZodError } from "zod";
import {
  Keypair,
  rpc,
  Account,
  TransactionBuilder,
  BASE_FEE,
  Operation,
  Address,
  nativeToScVal,
  Contract,
  xdr,
  scValToNative,
  StrKey,
  Networks,
} from "@stellar/stellar-sdk";
import { cfg, rpcUrls, buyerKeypair, sellerKeypair, getKeypair, DEMO_MODE } from "./lib/config.js";
import {
  getAllAgents,
  getAgentsPage,
  getAllJobs,
  invalidateAgents,
  invalidateJobs,
  identity,
  commerce,
  events,
  getFeeBps,
} from "./lib/discovery.js";
import {
  generateNonce,
  verifyNonceSignature,
  createSession,
  refreshSession,
  verifySession,
  invalidateSession,
  requireAuth,
  requireMatchingWallet,
} from "./lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ── #778: Strict Content Security Policy with per-request nonces ─────────────
// Generate a fresh cryptographic nonce for every request. The nonce is stored
// on res.locals so route handlers and the HTML-injection middleware can read it.
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
});

// Stellar RPC, Horizon, and IPFS gateway endpoints allowed in connect-src.
const STELLAR_CONNECT_SRCS = [
  "https://soroban-testnet.stellar.org",
  "https://soroban-rpc.mainnet.stellar.org",
  "https://horizon-testnet.stellar.org",
  "https://horizon.stellar.org",
  "https://ipfs.io",
  "https://cloudflare-ipfs.com",
  "https://dweb.link",
  "https://channels.openzeppelin.com",
];

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          // Nonce allows the inline theme-init script and any scripts we explicitly
          // tag; the function below is called by helmet per-request.
          // helmet calls this with (IncomingMessage, ServerResponse); Express augments
          // ServerResponse with .locals, so we cast to access the nonce.
          (_req, res) => `'nonce-${(res as unknown as Response).locals.cspNonce}'`,
          // Stellar Wallets Kit UMD bundle served from jsdelivr CDN.
          "https://cdn.jsdelivr.net",
          "https://unpkg.com",
        ],
        styleSrc: [
          "'self'",
          (_req, res) => `'nonce-${(res as unknown as Response).locals.cspNonce}'`,
          "https://fonts.googleapis.com",
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", ...STELLAR_CONNECT_SRCS, "wss:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    // Keep other helmet defaults: HSTS, X-Frame-Options, etc.
    crossOriginEmbedderPolicy: false, // required for Freighter wallet extension
  }),
);
app.use(express.json());

// Landing page at root
const landingDir = path.join(__dirname, "..", "landing");
app.use(express.static(landingDir));

// Dashboard at /app — serve static files then inject nonce into HTML responses
// so the browser accepts the CDN script tag in index.html.
app.use("/app", express.static(path.join(__dirname, "public")));

// Nonce injection middleware: intercepts HTML responses served from /app and
// rewrites the CDN <script> and Google Fonts <link> tags to include the nonce.
// This is the standard approach for static-file CSP without a build step.
app.use("/app", (_req: Request, res: Response, next: NextFunction) => {
  const nonce = res.locals.cspNonce as string;
  const originalSend = res.send.bind(res);
  res.send = function (body: unknown) {
    if (
      typeof body === "string" &&
      res.getHeader("Content-Type")?.toString().includes("text/html")
    ) {
      // Add nonce to the wallet-kit CDN script tag
      let html = body as string;
      html = html.replace(
        /<script src="https:\/\/cdn\.jsdelivr\.net/g,
        `<script nonce="${nonce}" src="https://cdn.jsdelivr.net`,
      );
      // Add nonce to local app.js script tag
      html = html.replace(
        /<script src="app\.js"/g,
        `<script nonce="${nonce}" src="app.js"`,
      );
      // Add nonce to Google Fonts link tags
      html = html.replace(
        /<link\s+(rel="preconnect"\s+href="https:\/\/fonts\.(googleapis|gstatic)\.com[^>]*)>/g,
        (_match: string, attrs: string) => `<link ${attrs} nonce="${nonce}">`,
      );
      html = html.replace(
        /<link\s+(href="https:\/\/fonts\.googleapis\.com[^>]*)>/g,
        (_match: string, attrs: string) => `<link ${attrs} nonce="${nonce}">`,
      );
      return originalSend(html);
    }
    return originalSend(body);
  };
  next();
});

const server = new rpc.Server(cfg.rpcUrl, {
  allowHttp: cfg.rpcUrl.startsWith("http://"),
});

const rpcFallbackServers = rpcUrls.map(
  (url) =>
    new rpc.Server(url, {
      allowHttp: url.startsWith("http://"),
    }),
);

async function withRpcFallback<T>(operation: (server: rpc.Server) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const candidate of rpcFallbackServers) {
    try {
      return await operation(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All Stellar RPC providers failed");
}

const identityContract = new Contract(cfg.identityContract);
const commerceContract = new Contract(cfg.commerceContract);

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  process.env.ALLOWED_ORIGIN,
  ...(process.env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()),
].filter(Boolean) as string[];

const mutatingBuckets = new Map<string, { count: number; resetAt: number }>();
const MUTATING_RATE_LIMIT = Number(process.env.MUTATING_RATE_LIMIT ?? 30);
const MUTATING_RATE_WINDOW_MS = Number(process.env.MUTATING_RATE_WINDOW_MS ?? 60_000);

function rateLimitMutating(req: Request, res: Response, next: NextFunction) {
  const key = req.ip || "unknown";
  const now = Date.now();
  const bucket = mutatingBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    mutatingBuckets.set(key, { count: 1, resetAt: now + MUTATING_RATE_WINDOW_MS });
    next();
    return;
  }
  if (bucket.count >= MUTATING_RATE_LIMIT) {
    res.status(429).json({ error: "rate limit exceeded" });
    return;
  }
  bucket.count += 1;
  next();
}

function isStellarAddress(value: string): boolean {
  if (typeof value !== "string") return false;
  if (!StrKey.isValidEd25519PublicKey(value)) return false;
  try {
    new Address(value);
    return true;
  } catch {
    return false;
  }
}

const stellarAddressSchema = z
  .string()
  .min(1)
  .refine(isStellarAddress, { message: "Invalid Stellar public key" });

const numericIdParamSchema = z.object({
  id: z
    .string()
    .regex(/^[0-9]+$/, "Job ID must be a positive integer")
    .transform(BigInt),
});

const registerAgentSchema = z
  .object({
    wallet: z.enum(["buyer", "seller", "freighter"]),
    publicKey: stellarAddressSchema.optional(),
    uri: z.string().min(1).optional(),
  })
  .refine((data) => {
    if (data.wallet === "freighter" && !data.publicKey) {
      throw new Error("publicKey is required when wallet is freighter");
    }
    return true;
  });

const createJobSchema = z.object({
  wallet: stellarAddressSchema,
  provider: stellarAddressSchema.optional(),
  evaluator: stellarAddressSchema.optional(),
  budget: z.union([z.string().regex(/^[0-9]+$/), z.number().int().nonnegative()]).optional(),
  description: z.string().min(1).optional(),
});

const submitJobSchema = z.object({
  wallet: stellarAddressSchema,
  deliverable: z.string().min(1).optional(),
});

const walletOnlySchema = z.object({
  wallet: stellarAddressSchema,
});

const buildRegisterSchema = z.object({
  publicKey: stellarAddressSchema,
  uri: z.string().min(1).optional(),
});

const buildCreateJobSchema = z.object({
  publicKey: stellarAddressSchema,
  provider: stellarAddressSchema.optional(),
  evaluator: stellarAddressSchema.optional(),
  budget: z.union([z.string().regex(/^[0-9]+$/), z.number().int().nonnegative()]).optional(),
  description: z.string().min(1).optional(),
});

const buildUnsignedActionSchema = z.object({
  publicKey: stellarAddressSchema,
  jobId: z.string().regex(/^[0-9]+$/, "Job ID must be a positive integer"),
});

const submitXdrSchema = z.object({
  signedXdr: z.string().min(1),
});

const jobStatusSchema = z.enum([
  "Active",
  "Open",
  "Funded",
  "Submitted",
  "Completed",
  "Rejected",
  "Cancelled",
  "Disputed",
]);

const jobsQuerySchema = z.object({
  status: z.string().min(1).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const agentsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(24),
});

function parseBudget(value: string | number | undefined, defaultValue = 10_000_000n): bigint {
  if (value === undefined || value === null) return defaultValue;
  return typeof value === "number" ? BigInt(value) : BigInt(value);
}

function respondWithValidationError(err: unknown, res: Response): boolean {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Invalid request payload", details: err.issues });
    return true;
  }
  return false;
}

function handleRouteError(err: unknown, res: Response): void {
  if (respondWithValidationError(err, res)) return;
  if (err instanceof Error && err.message === "Invalid wallet") {
    res.status(400).json({ error: "Invalid wallet" });
    return;
  }
  res.status(500).json({ error: (err as Error).message });
}

type AuditEntry = {
  at: string;
  method: string;
  path: string;
  wallet?: string;
  statusCode: number;
  ip?: string;
};

const auditTrail: AuditEntry[] = [];
const MAX_AUDIT_ENTRIES = 500;

function auditAdminAction(req: Request, res: Response, next: NextFunction) {
  const path = req.originalUrl || req.url;
  res.on("finish", () => {
    auditTrail.push({
      at: new Date().toISOString(),
      method: req.method,
      path,
      wallet: String((req as any).walletAddress ?? req.body?.wallet ?? req.body?.publicKey ?? ""),
      statusCode: res.statusCode,
      ip: req.ip,
    });
    if (auditTrail.length > MAX_AUDIT_ENTRIES) {
      auditTrail.splice(0, auditTrail.length - MAX_AUDIT_ENTRIES);
    }
  });
  next();
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);

app.get("/health", async (_req, res) => {
  try {
    await server.getLatestLedger();
    res.json({ status: "ok", rpc: "ok", timestamp: new Date().toISOString() });
  } catch (err: unknown) {
    res.status(503).json({
      status: "degraded",
      rpc: "error",
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});
app.get("/healthz", (_req, res) => res.send("ok"));

// --- Authentication Endpoints ---

/** GET /api/auth/challenge — Request a nonce to sign for wallet verification */
app.get("/api/auth/challenge", async (req, res) => {
  try {
    const publicKeySchema = z.object({
      publicKey: stellarAddressSchema,
    });
    const parsed = publicKeySchema.parse(req.query);
    const nonce = generateNonce(parsed.publicKey);
    const account = await withRpcFallback((rpcServer) => rpcServer.getAccount(parsed.publicKey));
    const challengeTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: cfg.networkPassphrase,
    })
      .addOperation(Operation.manageData({ name: "marc-auth", value: nonce }))
      .setTimeout(300)
      .build();
    res.json({
      nonce,
      message: `Sign this nonce to authenticate: ${nonce}`,
      xdr: challengeTx.toXDR(),
    });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/auth/verify — Verify signed nonce and receive session token.
 * Body: { publicKey, nonce, signedXdr }
 */
app.post("/api/auth/verify", (req, res) => {
  try {
    const authSchema = z.object({
      publicKey: stellarAddressSchema,
      nonce: z.string().min(1),
      signedXdr: z.string().min(1),
    });
    const parsed = authSchema.parse(req.body);

    // Verify the signature proves wallet ownership
    if (!verifyNonceSignature(parsed.publicKey, parsed.nonce, parsed.signedXdr)) {
      res.status(401).json({ error: "Invalid signature or expired nonce" });
      return;
    }

    // Create authenticated session
    const token = createSession(parsed.publicKey);
    res.json({ token, publicKey: parsed.publicKey });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(400).json({ error: (err as Error).message });
  }
});

/** POST /api/auth/logout — Invalidate session token */
app.post("/api/auth/logout", (req, res) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (token) {
      invalidateSession(token);
    }
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/auth/refresh", (req, res) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) {
      res.status(401).json({ error: "Missing authentication token" });
      return;
    }
    const refreshed = refreshSession(token);
    if (!refreshed) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
    res.json({ token: refreshed });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Middleware: Require auth except in DEMO_MODE.
 * In DEMO_MODE, auth is optional to allow testing without Freighter.
 * In production, all state-changing operations require wallet authentication.
 */
function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  if (DEMO_MODE) {
    // In demo mode, auth is optional - allow demo wallets to bypass
    const wallet = req.body.wallet || req.body.publicKey;
    if (wallet === "buyer" || wallet === "seller") {
      // Demo wallet - no auth needed
      (req as any).walletAddress = getKeypair(wallet).publicKey();
      return next();
    }
  }

  // In production or for unknown wallets, require auth
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({
      error:
        "Authentication required. Use /api/auth/challenge and /api/auth/verify to authenticate.",
    });
    return;
  }

  const publicKey = verifySession(token);
  if (!publicKey) {
    res.status(401).json({ error: "Invalid or expired authentication token" });
    return;
  }

  (req as any).walletAddress = publicKey;
  next();
}

function requireDashboardWallet(req: Request, res: Response, next: NextFunction) {
  const requestedWallet = req.body.publicKey || req.body.wallet;
  if (DEMO_MODE && (requestedWallet === "buyer" || requestedWallet === "seller")) {
    next();
    return;
  }
  requireMatchingWallet(req, res, next);
}

// --- Helpers ---

/** Serialize bigint values to strings for JSON, normalize Soroban enums */
function serialize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return obj.toString();
  if (obj instanceof Date) return obj.toISOString();
  if (obj instanceof Map)
    return Array.from(obj.entries()).map(([k, v]) => [serialize(k), serialize(v)]);
  if (obj instanceof Set) return Array.from(obj).map(serialize);
  if (Array.isArray(obj)) return obj.map(serialize);
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      // Soroban enums come back as ["VariantName"] — unwrap to string
      if (k === "status" && Array.isArray(v) && v.length === 1 && typeof v[0] === "string") {
        result[k] = v[0];
      } else {
        result[k] = serialize(v);
      }
    }
    return result;
  }
  return obj;
}

const HORIZON_URL =
  process.env.HORIZON_URL ??
  (cfg.networkPassphrase === Networks.PUBLIC
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org");

/** Get XLM balance from Horizon */
async function getXlmBalance(pubkey: string): Promise<string> {
  try {
    const resp = await fetch(`${HORIZON_URL}/accounts/${pubkey}`);
    if (!resp.ok) return "0";
    const data = (await resp.json()) as {
      balances: Array<{ asset_type: string; balance: string }>;
    };
    const native = data.balances.find((b: { asset_type: string }) => b.asset_type === "native");
    return native?.balance ?? "0";
  } catch {
    return "0";
  }
}

/** Simulate a read-only contract call with no arguments and return its native value */
async function simulateReadCall(contract: Contract, method: string): Promise<unknown> {
  const op = contract.call(method);
  const ephemeral = Keypair.random();
  const dummy = new Account(ephemeral.publicKey(), "0");
  const tx = new TransactionBuilder(dummy, {
    fee: BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const sim = await withRpcFallback((rpcServer) => rpcServer.simulateTransaction(tx));
  if (rpc.Api.isSimulationError(sim)) return null;
  const result = (sim as rpc.Api.SimulateTransactionSuccessResponse).result;
  if (!result) return null;
  return scValToNative(result.retval);
}

const tokenDecimalsCache = new Map<string, number>();

/** Query and cache a SAC token's `decimals()` value, defaulting to 7 on failure */
async function getTokenDecimals(tokenAddress: string): Promise<number> {
  const cached = tokenDecimalsCache.get(tokenAddress);
  if (cached !== undefined) return cached;
  try {
    const decimals = Number(await simulateReadCall(new Contract(tokenAddress), "decimals"));
    if (!Number.isFinite(decimals)) return 7;
    tokenDecimalsCache.set(tokenAddress, decimals);
    return decimals;
  } catch {
    return 7;
  }
}

/** Get MUSD (SAC) balance via Soroban simulate */
async function getTokenBalance(pubkey: string): Promise<string> {
  try {
    const contract = new Contract(cfg.usdcToken);
    const op = contract.call("balance", new Address(pubkey).toScVal());
    const ephemeral = Keypair.random();
    const dummy = new Account(ephemeral.publicKey(), "0");
    const tx = new TransactionBuilder(dummy, {
      fee: BASE_FEE,
      networkPassphrase: cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const sim = await withRpcFallback((rpcServer) => rpcServer.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim)) return "0";
    const result = (sim as rpc.Api.SimulateTransactionSuccessResponse).result;
    if (!result) return "0";
    const raw = scValToNative(result.retval);
    const val = BigInt(raw);
    const decimals = await getTokenDecimals(cfg.usdcToken);
    if (decimals === 0) return val.toString();
    const divisor = 10n ** BigInt(decimals);
    const whole = val / divisor;
    const frac = (val % divisor).toString().padStart(decimals, "0");
    return `${whole}.${frac}`;
  } catch {
    return "0";
  }
}

// --- API Routes ---

// GET /api/demo-mode — lets the frontend know whether to skip Freighter auth
app.get("/api/demo-mode", (_req, res) => {
  res.json({
    enabled: DEMO_MODE,
    ...(DEMO_MODE && {
      buyer: buyerKeypair.publicKey(),
      seller: sellerKeypair.publicKey(),
    }),
  });
});

let statsCache: { ts: number; payload: unknown } | null = null;
const STATS_CACHE_TTL_MS = Number(process.env.STATS_CACHE_TTL_MS ?? 5_000);

// GET /api/stats
app.get("/api/stats", async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "true";
    if (!forceRefresh && statsCache && Date.now() - statsCache.ts < STATS_CACHE_TTL_MS) {
      res.json(statsCache.payload);
      return;
    }
    const [agents, jobs, feeBps] = await Promise.all([getAllAgents(), getAllJobs(), getFeeBps()]);
    const activeJobs = jobs.filter((j) => j.status === "Funded" || j.status === "Submitted").length;
    const payload = {
      totalAgents: agents.length,
      totalJobs: jobs.length,
      activeJobs,
      feeBps,
    };
    statsCache = { ts: Date.now(), payload };
    res.json(payload);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/audit-trail", requireAuth, (_req, res) => {
  res.json(auditTrail.slice().reverse());
});

// Server-Sent Events: simple real-time stream for dashboard clients
app.get("/api/stream", (req, res) => {
  // Headers for SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      // ignore
    }
  };

  // Emit a welcome ping
  send("hello", { message: "connected" });

  const onInvalidate = (payload: unknown) => {
    send("invalidate", payload);
  };

  events.on("invalidate", onInvalidate);

  // heartbeat
  const hb = setInterval(
    () => send("ping", { t: Date.now(), retryAfterMs: 25_000 }),
    25000,
  );

  req.on("close", () => {
    clearInterval(hb);
    events.off("invalidate", onInvalidate);
  });
});

// GET /api/wallets
app.get("/api/wallets", async (_req, res) => {
  try {
    const buyerPub = buyerKeypair.publicKey();
    const sellerPub = sellerKeypair.publicKey();
    const [buyerXlm, sellerXlm, buyerMusd, sellerMusd] = await Promise.all([
      getXlmBalance(buyerPub),
      getXlmBalance(sellerPub),
      getTokenBalance(buyerPub),
      getTokenBalance(sellerPub),
    ]);
    res.json({
      buyer: { address: buyerPub, xlm: buyerXlm, musd: buyerMusd },
      seller: { address: sellerPub, xlm: sellerXlm, musd: sellerMusd },
    });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/agents
app.get("/api/agents", async (req, res) => {
  try {
    if (!("page" in req.query) && !("pageSize" in req.query)) {
      const agents = await getAllAgents();
      res.json(serialize(agents));
      return;
    }
    const parsed = agentsQuerySchema.parse(req.query);
    const agents = await getAgentsPage(parsed.page, parsed.pageSize);
    res.json({ ...agents, items: serialize(agents.items) });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/agents/register
app.post(
  "/api/agents/register",
  auditAdminAction,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const parsed = registerAgentSchema.parse(req.body);
      if (parsed.wallet === "freighter") {
        const op = identityContract.call(
          "register",
          new Address(parsed.publicKey!).toScVal(),
          nativeToScVal(parsed.uri || "ipfs://dashboard-agent", { type: "string" }),
        );
        const txXdr = await buildTxXdr(parsed.publicKey!, op);
        res.json({ xdr: txXdr });
        return;
      }
      const kp = getKeypair(parsed.wallet);
      const agentId = await identity.register(kp, parsed.uri || "ipfs://dashboard-agent");
      invalidateAgents();
      res.json({ agentId: agentId.toString() });
    } catch (err: unknown) {
      handleRouteError(err, res);
    }
  },
);

// GET /api/jobs
app.get("/api/jobs", async (req, res) => {
  try {
    const parsed = jobsQuerySchema.parse(req.query);
    let jobs = await getAllJobs();
    if (parsed.status === "Active") {
      jobs = jobs.filter((j) => j.status === "Funded" || j.status === "Submitted");
    } else if (parsed.status) {
      jobs = jobs.filter((j) => j.status === parsed.status);
    }
    if (parsed.page || parsed.limit) {
      const page = parsed.page ?? 1;
      const limit = parsed.limit ?? 24;
      const offset = (page - 1) * limit;
      const items = jobs.slice(offset, offset + limit);
      res.json({
        page,
        limit,
        total: jobs.length,
        hasNext: offset + limit < jobs.length,
        items: serialize(await Promise.all(items.map(async (job) => ({
          ...job,
          evaluatorProgress: await commerce.getEvaluatorProgress(job.id).catch(() => null),
        })))),
      });
      return;
    }
    res.json(serialize(await Promise.all(jobs.map(async (job) => ({
      ...job,
      evaluatorProgress: await commerce.getEvaluatorProgress(job.id).catch(() => null),
    })))));
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/jobs/create
app.post("/api/jobs/create", auditAdminAction, optionalAuthMiddleware, requireDashboardWallet, async (req, res) => {
  try {
    const parsed = createJobSchema.parse(req.body);
    const { wallet, provider, evaluator, budget, description } = parsed;
    const kp = getKeypair(wallet);
    const providerAddr = provider || sellerKeypair.publicKey();
    const evaluatorAddr = evaluator || kp.publicKey();
    const budgetBn = BigInt(budget || 10_000_000); // default 1 MUSD

    const agentId = await identity.agentOf(providerAddr);
    if (agentId === null) {
      res.status(400).json({ error: `Provider ${providerAddr} is not a registered agent` });
      return;
    }

    const jobId = await commerce.createJob(
      kp,
      providerAddr,
      evaluatorAddr,
      cfg.usdcToken,
      budgetBn,
      description || "Dashboard test job",
    );
    invalidateJobs();
    res.json({ jobId: jobId.toString() });
  } catch (err: unknown) {
    handleRouteError(err, res);
  }
});

// POST /api/jobs/:id/submit
app.post(
  "/api/jobs/:id/submit",
  auditAdminAction,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const params = numericIdParamSchema.parse(req.params);
      const parsed = submitJobSchema.parse(req.body);
      const kp = getKeypair(parsed.wallet);
      await commerce.submit(kp, params.id, parsed.deliverable || "ipfs://dashboard-delivery");
      invalidateJobs();
      res.json({ success: true });
    } catch (err: unknown) {
      handleRouteError(err, res);
    }
  },
);

app.post(
  "/api/jobs/:id/approve",
  auditAdminAction,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const params = numericIdParamSchema.parse(req.params);
      const parsed = walletOnlySchema.parse(req.body);
      const kp = getKeypair(parsed.wallet);
      const approvals = await commerce.approveJob(kp, params.id);
      invalidateJobs();
      res.json({ approvals });
    } catch (err: unknown) {
      handleRouteError(err, res);
    }
  },
);

// POST /api/jobs/:id/complete
app.post(
  "/api/jobs/:id/complete",
  auditAdminAction,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const params = numericIdParamSchema.parse(req.params);
      const parsed = walletOnlySchema.parse(req.body);
      const kp = getKeypair(parsed.wallet);
      await commerce.complete(kp, params.id);
      invalidateJobs();
      res.json({ success: true });
    } catch (err: unknown) {
      handleRouteError(err, res);
    }
  },
);

// POST /api/jobs/:id/cancel
app.post(
  "/api/jobs/:id/cancel",
  auditAdminAction,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const params = numericIdParamSchema.parse(req.params);
      const parsed = walletOnlySchema.parse(req.body);
      const kp = getKeypair(parsed.wallet);
      await commerce.cancel(kp, params.id);
      invalidateJobs();
      res.json({ success: true });
    } catch (err: unknown) {
      handleRouteError(err, res);
    }
  },
);

// PUT /api/jobs/:id — cancel a job; builds unsigned XDR when publicKey provided,
// or invokes directly when wallet (server keypair) is provided.
app.put("/api/jobs/:id", auditAdminAction, optionalAuthMiddleware, requireDashboardWallet, async (req, res) => {
  try {
    const { action, publicKey, wallet } = req.body;
    if (action !== "cancel") {
      res.status(400).json({ error: "unsupported action; use action: 'cancel'" });
      return;
    }
    const jobId = BigInt(req.params.id);

    if (publicKey) {
      const validPublicKey = stellarAddressSchema.parse(publicKey);
      // Freighter path: return unsigned XDR for client-side signing
      const op = commerceContract.call(
        "cancel",
        new Address(validPublicKey).toScVal(),
        nativeToScVal(jobId, { type: "u64" }),
      );
      const txXdr = await buildTxXdr(validPublicKey, op);
      res.json({ xdr: txXdr });
    } else {
      // Server-keypair path: sign and submit directly
      const kp = getKeypair(wallet);
      await commerce.cancel(kp, jobId);
      invalidateJobs();
      res.json({ success: true });
    }
  } catch (err: unknown) {
    handleRouteError(err, res);
  }
});

app.post("/api/dispute-job", optionalAuthMiddleware, requireDashboardWallet, async (req, res) => {
  try {
    const parsed = buildUnsignedActionSchema.parse(req.body);
    const op = commerceContract.call(
      "dispute",
      new Address(parsed.publicKey).toScVal(),
      nativeToScVal(BigInt(parsed.jobId), { type: "u64" }),
    );
    const txXdr = await buildTxXdr(parsed.publicKey, op);
    res.json({ xdr: txXdr });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/claim-refund", optionalAuthMiddleware, requireDashboardWallet, async (req, res) => {
  try {
    const parsed = buildUnsignedActionSchema.parse(req.body);
    const op = commerceContract.call(
      "claim_refund",
      new Address(parsed.publicKey).toScVal(),
      nativeToScVal(BigInt(parsed.jobId), { type: "u64" }),
    );
    const txXdr = await buildTxXdr(parsed.publicKey, op);
    res.json({ xdr: txXdr });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Freighter wallet endpoints: build unsigned XDR ---

const pendingTxHashes = new Set<string>();

/** Build an unsigned, simulated transaction and return its XDR */
async function buildTxXdr(publicKey: string, op: xdr.Operation): Promise<string> {
  const account = await withRpcFallback((rpcServer) => rpcServer.getAccount(publicKey));
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const prepared = await withRpcFallback((rpcServer) => rpcServer.prepareTransaction(tx));
  const hash = prepared.hash().toString("hex");
  pendingTxHashes.add(hash);
  return prepared.toXDR();
}

// POST /api/build/register — build unsigned register agent tx
app.post(
  "/api/build/register",
  rateLimitMutating,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const parsed = buildRegisterSchema.parse(req.body);
      const op = identityContract.call(
        "register",
        new Address(parsed.publicKey).toScVal(),
        nativeToScVal(parsed.uri || "ipfs://dashboard-agent", { type: "string" }),
      );
      const txXdr = await buildTxXdr(parsed.publicKey, op);
      res.json({ xdr: txXdr });
    } catch (err: unknown) {
      if (respondWithValidationError(err, res)) return;
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// POST /api/build/createJob — build unsigned create_job tx
app.post(
  "/api/build/createJob",
  rateLimitMutating,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const parsed = buildCreateJobSchema.parse(req.body);
      const providerAddr = parsed.provider || sellerKeypair.publicKey();
      const evaluatorAddr = parsed.evaluator || parsed.publicKey;
      const budgetBn = parseBudget(parsed.budget);

      const agentId = await identity.agentOf(providerAddr);
      if (agentId === null) {
        res.status(400).json({ error: `Provider ${providerAddr} is not a registered agent` });
        return;
      }

      const op = commerceContract.call(
        "create_job",
        new Address(parsed.publicKey).toScVal(),
        new Address(providerAddr).toScVal(),
        new Address(evaluatorAddr).toScVal(),
        new Address(cfg.usdcToken).toScVal(),
        nativeToScVal(budgetBn, { type: "i128" }),
        nativeToScVal(parsed.description || "Dashboard test job", { type: "string" }),
      );
      const txXdr = await buildTxXdr(parsed.publicKey, op);
      res.json({ xdr: txXdr });
    } catch (err: unknown) {
      if (respondWithValidationError(err, res)) return;
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// POST /api/build/submit — build unsigned submit tx
app.post("/api/build/submit", rateLimitMutating, optionalAuthMiddleware, requireDashboardWallet, async (req, res) => {
  try {
    const parsed = buildUnsignedActionSchema.parse(req.body);
    const op = commerceContract.call(
      "submit",
      new Address(parsed.publicKey).toScVal(),
      nativeToScVal(BigInt(parsed.jobId), { type: "u64" }),
      nativeToScVal(req.body.deliverable || "ipfs://dashboard-delivery", { type: "string" }),
    );
    const txXdr = await buildTxXdr(parsed.publicKey, op);
    res.json({ xdr: txXdr });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/build/complete — build unsigned complete tx
app.post(
  "/api/build/complete",
  rateLimitMutating,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const parsed = buildUnsignedActionSchema.parse(req.body);
      const op = commerceContract.call(
        "complete",
        new Address(parsed.publicKey).toScVal(),
        nativeToScVal(BigInt(parsed.jobId), { type: "u64" }),
      );
      const txXdr = await buildTxXdr(parsed.publicKey, op);
      res.json({ xdr: txXdr });
    } catch (err: unknown) {
      if (respondWithValidationError(err, res)) return;
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

app.post(
  "/api/build/approve",
  rateLimitMutating,
  optionalAuthMiddleware,
  requireDashboardWallet,
  async (req, res) => {
    try {
      const parsed = buildUnsignedActionSchema.parse(req.body);
      const op = commerceContract.call(
        "approve_job",
        new Address(parsed.publicKey).toScVal(),
        nativeToScVal(BigInt(parsed.jobId), { type: "u64" }),
      );
      const txXdr = await buildTxXdr(parsed.publicKey, op);
      res.json({ xdr: txXdr });
    } catch (err: unknown) {
      if (respondWithValidationError(err, res)) return;
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// POST /api/build/cancel — build unsigned cancel tx
app.post("/api/build/cancel", rateLimitMutating, optionalAuthMiddleware, requireDashboardWallet, async (req, res) => {
  try {
    const parsed = buildUnsignedActionSchema.parse(req.body);
    const op = commerceContract.call(
      "cancel",
      new Address(parsed.publicKey).toScVal(),
      nativeToScVal(BigInt(parsed.jobId), { type: "u64" }),
    );
    const txXdr = await buildTxXdr(parsed.publicKey, op);
    res.json({ xdr: txXdr });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/submit — submit a Freighter-signed transaction
app.post("/api/submit", rateLimitMutating, optionalAuthMiddleware, async (req, res) => {
  try {
    const parsed = submitXdrSchema.parse(req.body);
    const tx = TransactionBuilder.fromXDR(parsed.signedXdr, cfg.networkPassphrase);
    const submitHash = tx.hash().toString("hex");
    if (!pendingTxHashes.has(submitHash)) {
      res.status(400).json({ error: "Transaction XDR was not generated by this server" });
      return;
    }
    pendingTxHashes.delete(submitHash);

    const sent = await withRpcFallback((rpcServer) => rpcServer.sendTransaction(tx));
    if (sent.status === "ERROR") {
      throw new Error(`submit failed: ${sent.errorResult}`);
    }
    let getResp = await withRpcFallback((rpcServer) => rpcServer.getTransaction(sent.hash));
    while (getResp.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1000));
      getResp = await withRpcFallback((rpcServer) => rpcServer.getTransaction(sent.hash));
    }
    if (getResp.status !== "SUCCESS") {
      throw new Error(`tx failed: ${getResp.status}`);
    }
    // Decode return value if present
    let returnValue: unknown = null;
    if (getResp.returnValue) {
      try {
        returnValue = scValToNative(getResp.returnValue);
      } catch {
        // non-decodable return value, ignore
      }
    }
    invalidateAgents();
    invalidateJobs();
    res.json({ hash: sent.hash, returnValue: String(returnValue ?? "") });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- #738: Revenue analytics & transaction accounting export ---

const revenueReportQuerySchema = z.object({
  wallet: stellarAddressSchema,
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  format: z.enum(["csv", "json"]).default("json"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(1000).default(100),
});

type RevenueRow = {
  timestamp: number;
  transactionHash: string;
  ledger: number;
  jobId: string;
  role: "provider" | "client";
  token: string;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
};

type RevenueAggregate = {
  period: string;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
  count: number;
};

/** Escape a single CSV field per RFC 4180 (quote if it contains , " \r or \n). */
function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Serialize rows to RFC 4180 CSV with CRLF line endings. */
function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Format a Unix timestamp (seconds) as an ISO-8601 UTC date-time string. */
function formatTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function dayKey(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function monthKey(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 7);
}

function aggregateRevenue(rows: RevenueRow[], keyFn: (ts: number) => string): RevenueAggregate[] {
  const buckets = new Map<string, { gross: bigint; fee: bigint; net: bigint; count: number }>();
  for (const row of rows) {
    const key = keyFn(row.timestamp);
    const bucket = buckets.get(key) ?? { gross: 0n, fee: 0n, net: 0n, count: 0 };
    bucket.gross += BigInt(row.grossAmount);
    bucket.fee += BigInt(row.feeAmount);
    bucket.net += BigInt(row.netAmount);
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([period, b]) => ({
      period,
      grossAmount: b.gross.toString(),
      feeAmount: b.fee.toString(),
      netAmount: b.net.toString(),
      count: b.count,
    }));
}

/**
 * Extract accounting rows from a JobCompleted event payload. The event data is
 * expected to carry the job id, provider, client, token, gross budget and fee.
 * Amounts are normalized to raw token units (strings) so gross - fee = net
 * reconciles exactly with on-chain transfers.
 */
function extractRevenueRow(
  event: any,
  wallet: string,
): RevenueRow | null {
  const data = event?.data ?? event?.value ?? event ?? {};
  const jobId = data.jobId ?? data.job_id ?? event?.jobId ?? event?.job_id;
  const provider = data.provider ?? event?.provider;
  const client = data.client ?? data.buyer ?? event?.client ?? event?.buyer;
  const token = data.token ?? event?.token ?? cfg.usdcToken;
  const grossRaw = data.budget ?? data.grossAmount ?? data.gross_amount ?? event?.budget;
  const feeRaw = data.fee ?? data.feeAmount ?? data.fee_amount ?? 0;

  if (jobId === undefined || jobId === null) return null;
  if (grossRaw === undefined || grossRaw === null) return null;

  let role: "provider" | "client" | null = null;
  if (provider === wallet) role = "provider";
  else if (client === wallet) role = "client";
  if (!role) return null;

  const gross = BigInt(grossRaw);
  const fee = BigInt(feeRaw);
  const net = gross - fee;

  const ledger = Number(event?.ledger ?? event?.ledgerSequence ?? 0);
  const txHash = String(event?.txHash ?? event?.transactionHash ?? event?.tx_hash ?? "");
  const ts = Number(event?.timestamp ?? event?.closedAt ?? event?.ledgerClosedAt ?? 0);
  const timestamp = Number.isFinite(ts) && ts > 0 ? ts : Math.floor(Date.now() / 1000);

  return {
    timestamp,
    transactionHash: txHash,
    ledger,
    jobId: String(jobId),
    role,
    token: String(token),
    grossAmount: gross.toString(),
    feeAmount: fee.toString(),
    netAmount: net.toString(),
  };
}

// GET /api/reports/revenue — export revenue ledger as CSV or JSON
app.get("/api/reports/revenue", async (req, res) => {
  try {
    const parsed = revenueReportQuerySchema.parse(req.query);
    if (parsed.from !== undefined && parsed.to !== undefined && parsed.from > parsed.to) {
      res.status(400).json({ error: "'from' must be less than or equal to 'to'" });
      return;
    }

    const allEvents = await events.getEvents();
    const rows: RevenueRow[] = [];
    for (const ev of allEvents as any[]) {
      const name = ev?.type ?? ev?.name ?? ev?.topic?.[0];
      if (name !== "JobCompleted" && name !== "job_completed") continue;
      const row = extractRevenueRow(ev, parsed.wallet);
      if (!row) continue;
      if (parsed.from !== undefined && row.timestamp < parsed.from) continue;
      if (parsed.to !== undefined && row.timestamp > parsed.to) continue;
      rows.push(row);
    }

    rows.sort((a, b) => a.timestamp - b.timestamp);

    const daily = aggregateRevenue(rows, dayKey);
    const monthly = aggregateRevenue(rows, monthKey);

    const totalGross = rows.reduce((acc, r) => acc + BigInt(r.grossAmount), 0n);
    const totalFee = rows.reduce((acc, r) => acc + BigInt(r.feeAmount), 0n);
    const totalNet = rows.reduce((acc, r) => acc + BigInt(r.netAmount), 0n);

    const total = rows.length;
    const offset = (parsed.page - 1) * parsed.pageSize;
    const pageRows = rows.slice(offset, offset + parsed.pageSize);

    const headers = [
      "Timestamp",
      "TransactionHash",
      "Ledger",
      "JobId",
      "Role",
      "Token",
      "GrossAmount",
      "FeeAmount",
      "NetAmount",
    ];

    const filename = `revenue-report-${parsed.wallet.slice(0, 8)}-${Date.now()}`;

    if (parsed.format === "csv") {
      const csvRows = pageRows.map((r) => [
        formatTimestamp(r.timestamp),
        r.transactionHash,
        r.ledger,
        r.jobId,
        r.role,
        r.token,
        r.grossAmount,
        r.feeAmount,
        r.netAmount,
      ]);
      const csv = toCsv(headers, csvRows);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
      res.send(csv);
      return;
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.json"`);
    res.json({
      wallet: parsed.wallet,
      from: parsed.from ?? null,
      to: parsed.to ?? null,
      pagination: {
        page: parsed.page,
        pageSize: parsed.pageSize,
        total,
        hasNext: offset + parsed.pageSize < total,
      },
      totals: {
        grossAmount: totalGross.toString(),
        feeAmount: totalFee.toString(),
        netAmount: totalNet.toString(),
        count: total,
      },
      daily,
      monthly,
      rows: pageRows.map((r) => ({
        Timestamp: formatTimestamp(r.timestamp),
        TransactionHash: r.transactionHash,
        Ledger: r.ledger,
        JobId: r.jobId,
        Role: r.role,
        Token: r.token,
        GrossAmount: r.grossAmount,
        FeeAmount: r.feeAmount,
        NetAmount: r.netAmount,
      })),
    });
  } catch (err: unknown) {
    handleRouteError(err, res);
  }
});

// GET /api/balance/:pubkey — get XLM + MUSD balance for any public key
app.get("/api/balance/:pubkey", async (req, res) => {
  try {
    const params = z.object({ pubkey: stellarAddressSchema }).parse(req.params);
    const [xlm, musd] = await Promise.all([
      getXlmBalance(params.pubkey),
      getTokenBalance(params.pubkey),
    ]);
    res.json({ address: params.pubkey, xlm, musd });
  } catch (err: unknown) {
    if (respondWithValidationError(err, res)) return;
    res.status(500).json({ error: (err as Error).message });
  }
});

// Dashboard SPA fallback (anything under /app)
app.get("/app/*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Malformed JSON payload" });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Invalid request payload", details: err.issues });
  }
  console.error("Unhandled server error:", err);
  res.status(500).json({ error: "Internal server error" });
}

app.use(errorHandler);

const PORT = Number(process.env.PORT ?? process.env.DASHBOARD_PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`Bear Dashboard → http://localhost:${PORT}`);
  console.log(`  Buyer:  ${buyerKeypair.publicKey()}`);
  console.log(`  Seller: ${sellerKeypair.publicKey()}`);
});
