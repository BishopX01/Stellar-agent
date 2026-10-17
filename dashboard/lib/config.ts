import "dotenv/config";
import { Keypair } from "@stellar/stellar-sdk";
import { TESTNET, type MarcConfig } from "marc-stellar-sdk";

export const rpcUrls = [
  process.env.STELLAR_RPC_URL,
  ...(process.env.STELLAR_RPC_FALLBACK_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean),
  TESTNET.rpcUrl,
].filter((url, index, list): url is string => Boolean(url) && list.indexOf(url) === index);

export interface RpcHealthResult {
  url: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface RpcHealthReport {
  ok: boolean;
  checkedAt: string;
  results: RpcHealthResult[];
}

const RPC_HEALTH_TIMEOUT_MS = 5_000;

async function probeRpc(url: string): Promise<RpcHealthResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return { url, ok: false, latencyMs, error: `HTTP ${response.status}` };
    }
    const payload = (await response.json().catch(() => null)) as
      | { result?: { status?: string }; error?: { message?: string } }
      | null;
    if (payload?.error) {
      return { url, ok: false, latencyMs, error: payload.error.message ?? "RPC error" };
    }
    const status = payload?.result?.status;
    const ok = status === undefined || status === "healthy";
    return { url, ok, latencyMs, error: ok ? undefined : `status: ${status}` };
  } catch (error) {
    return {
      url,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes every configured RPC node (primary first, then fallbacks) and reports
 * availability so the dashboard can surface offline/degraded states.
 */
export async function checkRpcHealth(): Promise<RpcHealthReport> {
  const results = await Promise.all(rpcUrls.map((url) => probeRpc(url)));
  return {
    ok: results.some((result) => result.ok),
    checkedAt: new Date().toISOString(),
    results,
  };
}

export const cfg: MarcConfig = {
  rpcUrl: rpcUrls[0],
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
  identityContract: process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
  commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || TESTNET.commerceContract,
  usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
};

export const DEMO_MODE = process.env.DEMO_MODE === "true";

// In DEMO_MODE, use fixed test keypairs so no secrets are required.
// These are well-known Stellar testnet keys safe for local demos only.
const DEMO_BUYER_SECRET = "SDKXSHMO3BR6P7BRH6KNZ7RWHKK4PDACKTUTIHM7J56T55RHT53QHFBX";
const DEMO_SELLER_SECRET = "SDY6VEDUDJ6JD77NU7KQCQGNP3KCXN57RPUGDDYQBNGAWD2VE5P4RAVF";

export const buyerKeypair = DEMO_MODE
  ? Keypair.fromSecret(DEMO_BUYER_SECRET)
  : Keypair.fromSecret(process.env.BUYER_SECRET!);

export const sellerKeypair = DEMO_MODE
  ? Keypair.fromSecret(DEMO_SELLER_SECRET)
  : Keypair.fromSecret(process.env.SELLER_SECRET!);

export function getKeypair(wallet: string): Keypair {
  if (wallet === "buyer") return buyerKeypair;
  if (wallet === "seller") return sellerKeypair;
  throw new Error("Invalid wallet");
}
