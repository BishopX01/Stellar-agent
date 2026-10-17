import "dotenv/config";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { TESTNET, type MarcConfig } from "marc-stellar-sdk";
import { z } from "zod";

// In DEMO_MODE, use fixed test keypairs so no secrets are required.
// These are well-known Stellar testnet keys safe for local demos only.
const DEMO_BUYER_SECRET = "SDKXSHMO3BR6P7BRH6KNZ7RWHKK4PDACKTUTIHM7J56T55RHT53QHFBX";
const DEMO_SELLER_SECRET = "SDY6VEDUDJ6JD77NU7KQCQGNP3KCXN57RPUGDDYQBNGAWD2VE5P4RAVF";

const DEMO_MODE = process.env.DEMO_MODE === "true";

const secretKeySchema = z
  .string()
  .refine((value) => StrKey.isValidEd25519SecretSeed(value), {
    message: "must be a valid Stellar Ed25519 secret key (StrKey, starts with 'S')",
  });

const publicKeySchema = z
  .string()
  .refine((value) => StrKey.isValidEd25519PublicKey(value), {
    message: "must be a valid Stellar Ed25519 public key (StrKey, starts with 'G')",
  });

const rpcUrlSchema = z
  .string()
  .url({ message: "must be a valid URL" })
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: "must use the http or https protocol",
  });

const portSchema = z.coerce
  .number({ message: "must be a number" })
  .int({ message: "must be an integer" })
  .min(1, { message: "must be >= 1" })
  .max(65535, { message: "must be <= 65535" });

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

export const AgentConfigSchema = z
  .object({
    STELLAR_RPC_URL: rpcUrlSchema,
    STELLAR_RPC_FALLBACK_URLS: optionalString,
    STELLAR_NETWORK_PASSPHRASE: optionalString,
    SECRET_KEY: secretKeySchema.optional(),
    BUYER_SECRET: secretKeySchema.optional(),
    SELLER_SECRET: secretKeySchema.optional(),
    AGENT_IDENTITY_CONTRACT: publicKeySchema.optional(),
    AGENTIC_COMMERCE_CONTRACT: publicKeySchema.optional(),
    USDC_TOKEN_CONTRACT: publicKeySchema.optional(),
    PORT: portSchema.optional(),
    DEMO_MODE: z
      .string()
      .optional()
      .transform((value) => value === "true"),
  })
  .superRefine((value, ctx) => {
    if (value.DEMO_MODE) return;
    if (!value.BUYER_SECRET && !value.SECRET_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["BUYER_SECRET"],
        message: "is required unless DEMO_MODE=true or SECRET_KEY is set",
      });
    }
    if (!value.SELLER_SECRET && !value.SECRET_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SELLER_SECRET"],
        message: "is required unless DEMO_MODE=true or SECRET_KEY is set",
      });
    }
  });

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

function formatIssues(issues: z.ZodIssue[]): string {
  const rows = issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return { field, message: issue.message };
  });
  const fieldWidth = Math.max("VARIABLE".length, ...rows.map((row) => row.field.length));
  const messageWidth = Math.max("ERROR".length, ...rows.map((row) => row.message.length));
  const line = `+-${"-".repeat(fieldWidth)}-+-${"-".repeat(messageWidth)}-+`;
  const formatRow = (field: string, message: string) =>
    `| ${field.padEnd(fieldWidth)} | ${message.padEnd(messageWidth)} |`;
  return [
    line,
    formatRow("VARIABLE", "ERROR"),
    line,
    ...rows.map((row) => formatRow(row.field, row.message)),
    line,
  ].join("\n");
}

function loadConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const result = AgentConfigSchema.safeParse(env);
  if (!result.success) {
    const table = formatIssues(result.error.issues);
    throw new Error(`Invalid environment configuration:\n${table}`);
  }
  return result.data;
}

const env = loadConfig(process.env);

export const rpcUrls: string[] = [
  env.STELLAR_RPC_URL,
  ...(env.STELLAR_RPC_FALLBACK_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean),
  TESTNET.rpcUrl,
].filter((url, index, list) => Boolean(url) && list.indexOf(url) === index);

export const cfg: MarcConfig = {
  rpcUrl: rpcUrls[0],
  networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
  identityContract: env.AGENT_IDENTITY_CONTRACT ?? TESTNET.identityContract,
  commerceContract: env.AGENTIC_COMMERCE_CONTRACT ?? TESTNET.commerceContract,
  usdcToken: env.USDC_TOKEN_CONTRACT ?? TESTNET.usdcToken,
};

export const PORT: number | undefined = env.PORT;

export { DEMO_MODE };

export const buyerKeypair = DEMO_MODE
  ? Keypair.fromSecret(DEMO_BUYER_SECRET)
  : Keypair.fromSecret(env.BUYER_SECRET ?? env.SECRET_KEY ?? "");

export const sellerKeypair = DEMO_MODE
  ? Keypair.fromSecret(DEMO_SELLER_SECRET)
  : Keypair.fromSecret(env.SELLER_SECRET ?? env.SECRET_KEY ?? "");

export function getKeypair(wallet: string): Keypair {
  if (wallet === "buyer") return buyerKeypair;
  if (wallet === "seller") return sellerKeypair;
  throw new Error("Invalid wallet");
}
