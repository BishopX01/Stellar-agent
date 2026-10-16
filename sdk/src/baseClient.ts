import { Keypair, rpc, TransactionBuilder, BASE_FEE, xdr, Account, Memo } from "@stellar/stellar-sdk";
import type { MarcConfig } from "./types.js";
import type { Signer } from "./signer.js";
import { toSigner } from "./signer.js";
import { maskSecret } from "./format.js";
import {
  ContractError,
  SimulationError,
  TransactionTimeoutError,
  extractContractErrorCode,
  resolveContractErrorExplanation,
} from "./errors.js";

// ---------------------------------------------------------------------------
// #781 — RPC Failover Pool
// ---------------------------------------------------------------------------

/** Health state of a single RPC endpoint tracked by the pool. */
export interface RpcEndpointHealth {
  url: string;
  healthy: boolean;
  consecutiveFailures: number;
  latencyMs: number;
  lastChecked: number;
}

/**
 * Manages a pool of Soroban RPC endpoints with automatic health checking,
 * transparent failover, and exponential-backoff recovery probing.
 *
 * ### Behaviour
 * - Calls are initially sent to the *lowest-latency* healthy endpoint.
 * - On a network error or 5xx, the endpoint's `consecutiveFailures` counter
 *   increments. Once it reaches `maxConsecutiveFailures` (default 3) the
 *   endpoint is marked **unhealthy** and removed from the active rotation.
 * - A background probe interval (default 30 s) re-tests unhealthy endpoints
 *   via `getLatestLedger()`. On success the endpoint is restored.
 * - If *all* endpoints become unhealthy the pool throws an informative error
 *   rather than silently hanging.
 *
 * @example
 * ```typescript
 * const pool = new RpcFailoverPool(
 *   ["https://soroban-testnet.stellar.org", "https://rpc.ankr.com/stellar_testnet"],
 *   { maxConsecutiveFailures: 2, probeIntervalMs: 15_000 },
 * );
 * const server = pool.pick();   // fastest healthy endpoint
 * ```
 */
export class RpcFailoverPool {
  private endpoints: RpcEndpointHealth[];
  private servers: Map<string, rpc.Server>;
  private probeTimer?: ReturnType<typeof setInterval>;
  private readonly maxConsecutiveFailures: number;
  private readonly probeIntervalMs: number;

  constructor(
    urls: string[],
    opts: { maxConsecutiveFailures?: number; probeIntervalMs?: number } = {},
  ) {
    if (urls.length === 0) throw new Error("RpcFailoverPool requires at least one URL");
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 3;
    this.probeIntervalMs = opts.probeIntervalMs ?? 30_000;

    this.endpoints = urls.map((url) => ({
      url,
      healthy: true,
      consecutiveFailures: 0,
      latencyMs: 0,
      lastChecked: 0,
    }));

    this.servers = new Map(
      urls.map((url) => [
        url,
        new rpc.Server(url, { allowHttp: url.startsWith("http://"), timeout: 15_000 }),
      ]),
    );

    // Start background probe loop
    this.probeTimer = setInterval(() => void this.probeUnhealthy(), this.probeIntervalMs);
    // Allow process to exit even if the interval is still active
    if (typeof this.probeTimer.unref === "function") this.probeTimer.unref();
  }

  /**
   * Return the healthiest `rpc.Server` instance — preferring the lowest
   * latency among healthy endpoints. Falls back to *any* endpoint if none
   * are currently marked healthy (rare transient case), throwing only when
   * the pool is empty.
   */
  pick(): rpc.Server {
    const healthy = this.endpoints.filter((e) => e.healthy);
    const candidates = healthy.length > 0 ? healthy : this.endpoints;
    if (candidates.length === 0) throw new Error("RpcFailoverPool: no endpoints available");

    // Prefer the endpoint with the lowest recorded latency (or 0 = untested = prefer first)
    const best = candidates.reduce((a, b) => {
      if (a.latencyMs === 0) return a;
      if (b.latencyMs === 0) return b;
      return a.latencyMs <= b.latencyMs ? a : b;
    });

    return this.servers.get(best.url)!;
  }

  /**
   * Execute `fn` against the best healthy endpoint. On failure, mark that
   * endpoint as degraded and retry against the next candidate until one
   * succeeds or all are exhausted.
   *
   * Each retry uses exponential backoff: 200 ms * 2^attempt (capped at 2 s).
   */
  async call<T>(fn: (server: rpc.Server) => Promise<T>): Promise<T> {
    const healthy = this.endpoints.filter((e) => e.healthy);
    const order = healthy.length > 0 ? healthy : [...this.endpoints];

    let lastErr: unknown;
    for (let i = 0; i < order.length; i++) {
      const ep = order[i]!;
      const server = this.servers.get(ep.url)!;
      const t0 = Date.now();
      try {
        const result = await fn(server);
        ep.latencyMs = Date.now() - t0;
        ep.consecutiveFailures = 0;
        ep.healthy = true;
        ep.lastChecked = Date.now();
        return result;
      } catch (err) {
        lastErr = err;
        ep.consecutiveFailures += 1;
        ep.lastChecked = Date.now();
        if (ep.consecutiveFailures >= this.maxConsecutiveFailures) {
          ep.healthy = false;
        }
        // Exponential backoff before trying the next endpoint
        if (i < order.length - 1) {
          const delay = Math.min(200 * Math.pow(2, i), 2000);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error("RpcFailoverPool: all endpoints failed");
  }

  /** Re-test any unhealthy endpoints and restore them if they respond. */
  private async probeUnhealthy(): Promise<void> {
    const unhealthy = this.endpoints.filter((e) => !e.healthy);
    await Promise.allSettled(
      unhealthy.map(async (ep) => {
        const server = this.servers.get(ep.url)!;
        const t0 = Date.now();
        try {
          await server.getLatestLedger();
          ep.latencyMs = Date.now() - t0;
          ep.consecutiveFailures = 0;
          ep.healthy = true;
          ep.lastChecked = Date.now();
        } catch {
          ep.lastChecked = Date.now();
        }
      }),
    );
  }

  /** Snapshot of all endpoint health states (useful for observability). */
  healthSnapshot(): readonly RpcEndpointHealth[] {
    return this.endpoints.map((e) => ({ ...e }));
  }

  /** Stop the background probe timer. */
  destroy(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
  }
}

// ---------------------------------------------------------------------------

/**
 * Abstract base class for Soroban contract clients.
 *
 * Provides shared transaction submission and simulation logic used by
 * {@link IdentityClient} and {@link CommerceClient}. Handles ScVal
 * encoding/decoding, transaction building, RPC submission, polling for
 * finality, and retry logic with exponential backoff.
 *
 * When `cfg.rpcUrls` is provided the client instantiates an
 * {@link RpcFailoverPool} for transparent multi-endpoint failover (#781).
 * `cfg.rpcUrl` is used as a single-endpoint fallback for backward compatibility.
 *
 * Subclasses must call `super(cfg)` in their constructors and then
 * instantiate their specific `Contract` instances.
 *
 * @example
 * ```typescript
 * // You don't instantiate BaseClient directly — use IdentityClient or CommerceClient:
 * import { IdentityClient, CommerceClient, TESTNET } from "marc-stellar-sdk";
 * const identity = new IdentityClient(TESTNET);
 * const commerce = new CommerceClient(TESTNET);
 * ```
 */
export abstract class BaseClient {
  /** Soroban JSON-RPC server used for simulation and transaction submission. */
  protected server: rpc.Server;
  /** Multi-endpoint failover pool (populated when cfg.rpcUrls is provided). */
  protected rpcPool?: RpcFailoverPool;

  /**
   * @param cfg - SDK configuration including the RPC URL(s), network passphrase,
   *              and deployed contract addresses. When `rpcUrls` is provided a
   *              failover pool is used; otherwise the single `rpcUrl` is used.
   */
  constructor(protected cfg: MarcConfig) {
    const urls = cfg.rpcUrls && cfg.rpcUrls.length > 0
      ? cfg.rpcUrls
      : [cfg.rpcUrl];

    this.rpcPool = new RpcFailoverPool(urls, {
      maxConsecutiveFailures: 3,
      probeIntervalMs: 30_000,
    });

    // `this.server` points to the first URL for legacy internal methods that
    // don't yet use pool.call(). pool.call() overrides this dynamically.
    this.server = new rpc.Server(urls[0]!, {
      allowHttp: urls[0]!.startsWith("http://"),
      timeout: 15000,
    });
  }

  /**
   * Execute an RPC operation through the failover pool.
   * Falls back to `this.server` when the pool is not configured.
   */
  protected async rpcCall<T>(fn: (server: rpc.Server) => Promise<T>): Promise<T> {
    if (this.rpcPool) return this.rpcPool.call(fn);
    return fn(this.server);
  }

  /**
   * Build, sign, submit, and poll a contract-invocation transaction.
   *
   * Fetches the account sequence number, builds the transaction, calls
   * `prepareTransaction` to simulate and attach the Soroban footprint,
   * signs with the provided signer, submits via `sendTransaction`, and
   * polls until the transaction is finalized (SUCCESS or FAILED).
   *
   * Accepts both a `Keypair` (Node/demo flows) and a `WalletSigner`
   * (browser wallet flows) via the `Signer` union type.
   *
   * @param signer - The signer that signs and pays fees for the transaction.
   * @param op - The pre-built Soroban contract operation to include.
   * @param decode - Decoder applied to the transaction's return ScVal.
   * @param txLabel - Short label passed to the `onTx` callback (e.g. `"identity"`, `"commerce"`).
   * @returns The decoded return value of type `T`.
   * @throws {Error} If the transaction is rejected (`ERROR` status), if the on-chain
   *                 execution fails, or on any RPC/network failure.
   */
  protected async invoke<T>(
    signer: Signer,
    op: xdr.Operation,
    decode: (scVal: xdr.ScVal) => T,
    txLabel: string,
    options: { memo?: string } = {},
  ): Promise<T> {
    const walletSigner = toSigner(signer);
    // Use the failover pool for account fetch + prepare + submit
    const account = await this.rpcCall((s) => s.getAccount(walletSigner.publicKey));
    let builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    }).addOperation(op);
    if (options.memo) {
      builder = builder.addMemo(Memo.text(options.memo));
    }
    const tx = builder.setTimeout(30).build();
    const prepared = await this.rpcCall((s) => s.prepareTransaction(tx));
    const signedXdr = await walletSigner.signTransaction(prepared.toXDR(), {
      networkPassphrase: this.cfg.networkPassphrase,
    });
    const signedTx = TransactionBuilder.fromXDR(signedXdr, this.cfg.networkPassphrase);
    const sent = await this.rpcCall((s) => s.sendTransaction(signedTx));
    const contractAddr =
      txLabel === "identity" ? this.cfg.identityContract : this.cfg.commerceContract;

    if (sent.status === "ERROR") {
      const errStr = maskSecret(`submit failed: ${sent.errorResult}`);
      const code = extractContractErrorCode(errStr);
      if (code !== null) {
        throw new ContractError(
          code,
          contractAddr,
          resolveContractErrorExplanation(code, contractAddr, this.cfg.identityContract),
        );
      }
      throw new Error(errStr);
    }

    const startTime = Date.now();
    const timeoutMs = this.cfg.pollTimeoutMs ?? 60000;
    let getResp = await this.rpcCall((s) => s.getTransaction(sent.hash));
    while (getResp.status === "NOT_FOUND") {
      if (Date.now() - startTime >= timeoutMs) {
        throw new TransactionTimeoutError(sent.hash, Date.now() - startTime);
      }
      await new Promise((r) => setTimeout(r, 1000));
      getResp = await this.rpcCall((s) => s.getTransaction(sent.hash));
    }
    if (getResp.status !== "SUCCESS") {
      const failed = getResp as rpc.Api.GetFailedTransactionResponse;
      const detail = failed.resultXdr?.result()?.switch()?.name ?? getResp.status;
      const resultXdrStr = failed.resultXdr ? failed.resultXdr.toXDR("base64") : "";
      const rawDetail = maskSecret(`tx failed: ${detail}`);
      const code = extractContractErrorCode(rawDetail) ?? extractContractErrorCode(resultXdrStr);
      if (code !== null) {
        throw new ContractError(
          code,
          contractAddr,
          resolveContractErrorExplanation(code, contractAddr, this.cfg.identityContract),
        );
      }
      throw new Error(rawDetail);
    }
    this.cfg.onTx?.(sent.hash, txLabel);
    return decode(getResp.returnValue!);
  }

  /**
   * Simulate one contract operation and return the RPC-estimated resource fee.
   */
  protected async estimateOperationFee(op: xdr.Operation): Promise<bigint> {
    const ephemeral = Keypair.random();
    const dummy = new Account(ephemeral.publicKey(), "0");
    const tx = new TransactionBuilder(dummy, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const sim = await this.rpcCall((s) => s.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim)) throw new Error(maskSecret(sim.error));
    const fee = (sim as rpc.Api.SimulateTransactionSuccessResponse).minResourceFee ?? BASE_FEE;
    return BigInt(fee);
  }

  /**
   * Simulate a read-only contract call without submitting a transaction.
   *
   * Uses an ephemeral random keypair so no real account or funds are needed.
   * Retries up to 3 times with exponential backoff (2 s, 4 s) on transient errors.
   * All retry attempts are routed through the RPC failover pool (#781).
   *
   * @param op - The contract operation to simulate (must be a pure read call).
   * @param decode - Decoder applied to the simulation result's `retval` ScVal.
   * @returns The decoded return value of type `T`.
   * @throws {Error} If the simulation returns an error or after 3 failed attempts.
   */
  protected async simulate<T>(op: xdr.Operation, decode: (v: xdr.ScVal) => T): Promise<T> {
    const ephemeral = Keypair.random();
    const dummy = new Account(ephemeral.publicKey(), "0");
    const tx = new TransactionBuilder(dummy, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const sim = await this.rpcCall((s) => s.simulateTransaction(tx));
        if (rpc.Api.isSimulationError(sim)) {
          const errMsg = maskSecret(sim.error);
          const code = extractContractErrorCode(errMsg);
          if (code !== null) {
            throw new ContractError(
              code,
              this.cfg.commerceContract,
              resolveContractErrorExplanation(code, this.cfg.commerceContract, this.cfg.identityContract),
            );
          }
          throw new SimulationError(errMsg, sim, tx.toXDR());
        }
        const result = (sim as rpc.Api.SimulateTransactionSuccessResponse).result;
        if (!result) throw new SimulationError("no simulation result", sim, tx.toXDR());
        return decode(result.retval);
      } catch (err) {
        if (err instanceof ContractError) throw err;
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    // TypeScript requires a return here; the loop always throws or returns above.
    throw new Error("simulate: exhausted retries");
  }

  /**
   * Simulate an optional-return contract call (returns `null` when the contract
   * returns `ScvVoid` or a missing Option).
   */
  protected async simulateOption<T>(
    op: xdr.Operation,
    decode: (v: xdr.ScVal) => T,
  ): Promise<T | null> {
    return this.simulate(op, (v) => {
      if (v.switch() === xdr.ScValType.scvVoid()) return null;
      return decode(v);
    });
  }
}
