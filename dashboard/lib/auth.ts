import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import {
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  Utils,
} from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// SEP-0010 (Stellar Web Authentication) configuration
// ---------------------------------------------------------------------------

/** The home domain advertised in the challenge transaction (e.g. "marc.finance"). */
const HOME_DOMAIN = process.env.STELLAR_HOME_DOMAIN || "localhost";

/** Network passphrase used to build/verify challenge transactions. */
const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK === "PUBLIC"
    ? Networks.PUBLIC
    : process.env.STELLAR_NETWORK === "FUTURENET"
      ? Networks.FUTURENET
      : Networks.TESTNET;

/** How long a challenge transaction remains valid (SEP-0010 time bounds). */
const CHALLENGE_EXPIRY_SECONDS = 5 * 60; // 5 minutes

/** Maximum allowed clock skew when verifying challenge time bounds. */
const MAX_CLOCK_SKEW_SECONDS = 300; // 5 minutes

/** JWT session lifetime: 24 hours. */
const JWT_EXPIRY_SECONDS = 24 * 60 * 60;

const JWT_SECRET: string =
  process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");

if (!process.env.JWT_SECRET) {
  // eslint-disable-next-line no-console
  console.warn(
    "[auth] JWT_SECRET is not set; using an ephemeral secret. Sessions will not survive restarts.",
  );
}

/**
 * Server signing keypair used to sign SEP-0010 challenge transactions.
 * In production this should be a stable key whose public key is published
 * in the stellar.toml SIGNING_KEY field for the home domain.
 */
const serverKeypair: Keypair = process.env.STELLAR_SERVER_SECRET
  ? Keypair.fromSecret(process.env.STELLAR_SERVER_SECRET)
  : Keypair.random();

// ---------------------------------------------------------------------------
// Challenge store (replay protection)
// ---------------------------------------------------------------------------

interface StoredChallenge {
  /** Full challenge transaction XDR (signed by the server). */
  xdr: string;
  /** The account the challenge was issued to. */
  account: string;
  /** When the challenge was issued (ms since epoch). */
  timestamp: number;
}

const challengeStore = new Map<string, StoredChallenge>();

function cleanupExpiredChallenges(now = Date.now()): void {
  const maxAgeMs = (CHALLENGE_EXPIRY_SECONDS + MAX_CLOCK_SKEW_SECONDS) * 1000;
  for (const [account, challenge] of challengeStore.entries()) {
    if (now - challenge.timestamp > maxAgeMs) {
      challengeStore.delete(account);
    }
  }
}

/**
 * Build a SEP-0010 challenge transaction for the given account.
 *
 * The challenge includes:
 *  - a `manageData` operation with name `<home_domain> auth` and a random nonce
 *  - time bounds (minTime / maxTime) limiting validity
 *  - a sequence number of 0 (required by SEP-0010)
 *  - the server's signature
 *
 * @param publicKey - The client account requesting authentication
 * @returns The base64-encoded challenge transaction envelope XDR
 */
export function buildChallenge(publicKey: string): string {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    throw new Error("Invalid Stellar public key");
  }

  cleanupExpiredChallenges();

  const challengeXdr = Utils.buildChallengeTx(
    serverKeypair,
    publicKey,
    HOME_DOMAIN,
    CHALLENGE_EXPIRY_SECONDS,
    NETWORK_PASSPHRASE,
    HOME_DOMAIN,
  );

  challengeStore.set(publicKey, {
    xdr: challengeXdr,
    account: publicKey,
    timestamp: Date.now(),
  });

  return challengeXdr;
}

/**
 * Verify a client-signed SEP-0010 challenge transaction.
 *
 * Uses `Utils.verifyChallengeTx` which validates:
 *  - the transaction structure and manageData operation
 *  - the home domain and server signing key
 *  - time bounds (expiry) and sequence number (replay protection)
 *  - the client's signature
 *
 * On success the challenge is consumed so it cannot be replayed.
 *
 * @param signedXdr - The base64-encoded signed challenge transaction XDR
 * @returns The authenticated client public key, or null if invalid
 */
export function verifyChallenge(signedXdr: string): string | null {
  try {
    cleanupExpiredChallenges();

    const clientPublicKey = Utils.verifyChallengeTx(
      signedXdr,
      serverKeypair.publicKey(),
      NETWORK_PASSPHRASE,
      HOME_DOMAIN,
      HOME_DOMAIN,
      MAX_CLOCK_SKEW_SECONDS,
    );

    if (!clientPublicKey) {
      return null;
    }

    // Ensure this challenge was actually issued by us and hasn't been used.
    const stored = challengeStore.get(clientPublicKey);
    if (!stored || stored.xdr !== signedXdr) {
      return null;
    }

    // Consume the challenge to prevent replay.
    challengeStore.delete(clientPublicKey);

    return clientPublicKey;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JWT session tokens
// ---------------------------------------------------------------------------

export interface SessionClaims {
  /** The authenticated Stellar account (G...). */
  publicKey: string;
  /** Issued-at (seconds since epoch). */
  iat: number;
  /** Expiration (seconds since epoch). */
  exp: number;
}

/**
 * Issue a signed JWT session token (24-hour expiry) for an authenticated wallet.
 */
export function createSession(publicKey: string): string {
  return jwt.sign({ publicKey }, JWT_SECRET, {
    expiresIn: JWT_EXPIRY_SECONDS,
    algorithm: "HS256",
  });
}

/**
 * Verify a JWT session token and return the authenticated public key.
 * Returns null if the token is malformed, has an invalid signature, or is expired.
 */
export function verifySession(token: string): string | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
    }) as SessionClaims;

    if (!decoded || typeof decoded.publicKey !== "string") {
      return null;
    }

    if (!StrKey.isValidEd25519PublicKey(decoded.publicKey)) {
      return null;
    }

    return decoded.publicKey;
  } catch {
    return null;
  }
}

/**
 * Invalidate a session token.
 *
 * JWTs are stateless, so this is a no-op retained for API compatibility.
 * Clients should discard the token; short-lived tokens limit exposure.
 */
export function invalidateSession(_token: string): void {
  // Stateless JWT: nothing to revoke server-side.
}

/**
 * Refresh a session token by issuing a new JWT for the same wallet.
 */
export function refreshSession(token: string): string | null {
  const publicKey = verifySession(token);
  if (!publicKey) return null;
  return createSession(publicKey);
}

/**
 * Middleware: Require a valid JWT session token.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "Missing authentication token" });
    return;
  }

  const publicKey = verifySession(token);
  if (!publicKey) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  // Attach public key to request for later use
  (req as any).walletAddress = publicKey;
  next();
}

/**
 * Middleware: Verify that the wallet in the request matches the authenticated session.
 * Only allows authenticated users to act on their own wallets.
 */
export function requireMatchingWallet(req: Request, res: Response, next: NextFunction): void {
  const walletAddress = (req as any).walletAddress;
  if (!walletAddress) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const requestedWallet = req.body.publicKey || req.body.wallet;
  if (requestedWallet && requestedWallet !== walletAddress) {
    res.status(403).json({ error: "Cannot act on behalf of another wallet" });
    return;
  }

  next();
}
