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

export const cfg: MarcConfig = {
  rpcUrl: rpcUrls[0],
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
  identityContract: process.env.AGENT_IDENTITY_CONTRACT || TESTNET.identityContract,
  commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || TESTNET.commerceContract,
  usdcToken: process.env.USDC_TOKEN_CONTRACT || TESTNET.usdcToken,
};

export const DEMO_MODE = process.env.DEMO_MODE === "true";

// SEP-0010 (Stellar Web Authentication) configuration.
// The server signing keypair signs challenge transactions; wallets verify the
// home_domain and server signature before prompting the user to sign.
export const homeDomain = process.env.DASHBOARD_HOME_DOMAIN ?? "localhost";

export const serverSigningKeypair = Keypair.fromSecret(
  process.env.DASHBOARD_SIGNING_SECRET || DEMO_BUYER_SECRET,
);

// Secret used to sign/verify dashboard session JWTs (24h expiration).
export const jwtSecret = process.env.DASHBOARD_JWT_SECRET || "demo-dashboard-jwt-secret";

// Challenge transaction validity window (seconds) and JWT lifetime (seconds).
export const challengeTimeoutSeconds = Number(process.env.DASHBOARD_CHALLENGE_TIMEOUT ?? 300);
export const jwtExpiresInSeconds = Number(process.env.DASHBOARD_JWT_EXPIRES_IN ?? 24 * 60 * 60);

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
