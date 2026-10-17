import "dotenv/config";
import { Keypair } from "@stellar/stellar-sdk";
import { TESTNET, type MarcConfig } from "marc-stellar-sdk";

export type NetworkId = "testnet" | "futurenet" | "mainnet";

export interface NetworkPreset {
  id: NetworkId;
  label: string;
  rpcUrl: string;
  networkPassphrase: string;
  identityContract: string;
  commerceContract: string;
  usdcToken: string;
  /** True when the network uses real funds (e.g. real USDC). */
  isMainnet: boolean;
}

export const NETWORKS: Record<NetworkId, NetworkPreset> = {
  testnet: {
    id: "testnet",
    label: "Testnet",
    rpcUrl: TESTNET.rpcUrl,
    networkPassphrase: TESTNET.networkPassphrase,
    identityContract: TESTNET.identityContract,
    commerceContract: TESTNET.commerceContract,
    usdcToken: TESTNET.usdcToken,
    isMainnet: false,
  },
  futurenet: {
    id: "futurenet",
    label: "Futurenet",
    rpcUrl: "https://rpc-futurenet.stellar.org",
    networkPassphrase: "Test SDF Future Network ; October 2022",
    identityContract: process.env.FUTURENET_AGENT_IDENTITY_CONTRACT ?? "",
    commerceContract: process.env.FUTURENET_AGENTIC_COMMERCE_CONTRACT ?? "",
    usdcToken: process.env.FUTURENET_USDC_TOKEN_CONTRACT ?? "",
    isMainnet: false,
  },
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    rpcUrl: "https://mainnet.sorobanrpc.com",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    identityContract: process.env.MAINNET_AGENT_IDENTITY_CONTRACT ?? "",
    commerceContract: process.env.MAINNET_AGENTIC_COMMERCE_CONTRACT ?? "",
    usdcToken:
      process.env.MAINNET_USDC_TOKEN_CONTRACT ??
      "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    isMainnet: true,
  },
};

export const DEFAULT_NETWORK_ID: NetworkId = "testnet";

export function isNetworkId(value: unknown): value is NetworkId {
  return value === "testnet" || value === "futurenet" || value === "mainnet";
}

/**
 * Resolve the active network id from an explicit value, the STELLAR_NETWORK
 * env var, or the default (testnet).
 */
export function resolveNetworkId(explicit?: string | null): NetworkId {
  if (isNetworkId(explicit)) return explicit;
  const fromEnv = process.env.STELLAR_NETWORK?.toLowerCase();
  if (isNetworkId(fromEnv)) return fromEnv;
  return DEFAULT_NETWORK_ID;
}

export function getNetworkPreset(networkId?: string | null): NetworkPreset {
  return NETWORKS[resolveNetworkId(networkId)];
}

export const activeNetwork: NetworkPreset = getNetworkPreset();

export const rpcUrls = [
  process.env.STELLAR_RPC_URL,
  ...(process.env.STELLAR_RPC_FALLBACK_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean),
  activeNetwork.rpcUrl,
  TESTNET.rpcUrl,
].filter((url, index, list): url is string => Boolean(url) && list.indexOf(url) === index);

export const cfg: MarcConfig = {
  rpcUrl: rpcUrls[0],
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? activeNetwork.networkPassphrase,
  identityContract: process.env.AGENT_IDENTITY_CONTRACT || activeNetwork.identityContract,
  commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || activeNetwork.commerceContract,
  usdcToken: process.env.USDC_TOKEN_CONTRACT || activeNetwork.usdcToken,
};

/**
 * Build a MarcConfig for a specific network, honoring env-var overrides.
 */
export function getConfigForNetwork(networkId?: string | null): MarcConfig {
  const preset = getNetworkPreset(networkId);
  return {
    rpcUrl: process.env.STELLAR_RPC_URL || preset.rpcUrl,
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? preset.networkPassphrase,
    identityContract: process.env.AGENT_IDENTITY_CONTRACT || preset.identityContract,
    commerceContract: process.env.AGENTIC_COMMERCE_CONTRACT || preset.commerceContract,
    usdcToken: process.env.USDC_TOKEN_CONTRACT || preset.usdcToken,
  };
}

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
