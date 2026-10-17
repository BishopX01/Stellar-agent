import { z } from "zod";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

/**
 * Validate a Stellar StrKey Ed25519 secret key (starts with "S").
 */
export const StellarSecretKeySchema = z.string().refine(
  (value) => {
    try {
      Keypair.fromSecret(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid Stellar secret key (expected StrKey Ed25519 secret starting with 'S')" },
);

/**
 * Validate a Stellar StrKey Ed25519 public key (starts with "G").
 */
export const StellarPublicKeySchema = z.string().refine(
  (value) => {
    try {
      return StrKey.isValidEd25519PublicKey(value);
    } catch {
      return false;
    }
  },
  { message: "Invalid Stellar public key (expected StrKey Ed25519 public key starting with 'G')" },
);

export const ContractAddressesSchema = z.object({
  AGENT_IDENTITY_CONTRACT: StellarPublicKeySchema,
  AGENTIC_COMMERCE_CONTRACT: StellarPublicKeySchema,
  USDC_TOKEN_CONTRACT: StellarPublicKeySchema,
});

export type ContractAddresses = z.infer<typeof ContractAddressesSchema>;

export const AgentConfigSchema = z.object({
  STELLAR_RPC_URL: z.string().url({ message: "STELLAR_RPC_URL must be a valid URL" }),
  STELLAR_NETWORK_PASSPHRASE: z
    .string()
    .min(1, { message: "STELLAR_NETWORK_PASSPHRASE must not be empty" }),
  SECRET_KEY: StellarSecretKeySchema,
  CONTRACT_ADDRESSES: ContractAddressesSchema,
  PORT: z.coerce
    .number({ invalid_type_error: "PORT must be a number" })
    .int({ message: "PORT must be an integer" })
    .positive({ message: "PORT must be a positive integer" })
    .max(65535, { message: "PORT must be <= 65535" }),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * Format Zod issues into a readable terminal table.
 */
export function formatConfigIssues(issues: z.ZodIssue[]): string {
  const rows = issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
  const pathWidth = Math.max(4, ...rows.map((r) => r.path.length));
  const msgWidth = Math.max(7, ...rows.map((r) => r.message.length));
  const line = `+-${"-".repeat(pathWidth)}-+-${"-".repeat(msgWidth)}-+`;
  const formatRow = (path: string, message: string) =>
    `| ${path.padEnd(pathWidth)} | ${message.padEnd(msgWidth)} |`;
  const out = [
    line,
    formatRow("Path", "Message"),
    line,
    ...rows.map((r) => formatRow(r.path, r.message)),
    line,
  ];
  return out.join("\n");
}

/**
 * Validate a raw environment object against AgentConfigSchema.
 * Throws a readable error (with a terminal table) on failure.
 */
export function validateAgentConfig(
  env: Record<string, string | undefined> = process.env,
): AgentConfig {
  const result = AgentConfigSchema.safeParse({
    STELLAR_RPC_URL: env.STELLAR_RPC_URL,
    STELLAR_NETWORK_PASSPHRASE: env.STELLAR_NETWORK_PASSPHRASE,
    SECRET_KEY: env.SECRET_KEY,
    CONTRACT_ADDRESSES: {
      AGENT_IDENTITY_CONTRACT: env.AGENT_IDENTITY_CONTRACT,
      AGENTIC_COMMERCE_CONTRACT: env.AGENTIC_COMMERCE_CONTRACT,
      USDC_TOKEN_CONTRACT: env.USDC_TOKEN_CONTRACT,
    },
    PORT: env.PORT,
  });
  if (!result.success) {
    throw new Error(
      `Invalid agent configuration:\n${formatConfigIssues(result.error.issues)}`,
    );
  }
  return result.data;
}

/**
 * Strictly typed agent configuration, validated at boot.
 */
export const agentConfig: AgentConfig = validateAgentConfig(process.env);

export const AGENT_LLM_PROVIDER = process.env.AGENT_LLM_PROVIDER ?? "openai";
export const AGENT_LLM_MODEL =
  process.env.AGENT_LLM_MODEL ??
  (AGENT_LLM_PROVIDER === "anthropic" ? "claude-3-5-sonnet-latest" : "gpt-4o");

export const CAPABILITY_TAGS = [
  "code-generation",
  "code-review",
  "data-analysis",
  "translation",
  "summarization",
  "image-generation",
  "web-scraping",
  "smart-contract-audit",
] as const;

export type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

export const TaskClassificationSchema = z.object({
  capabilities: z.array(z.enum(CAPABILITY_TAGS)).min(1),
  summary: z.string(),
  maxPrice: z.number().nonnegative().optional(),
});

export type TaskClassification = z.infer<typeof TaskClassificationSchema>;

export const ProviderSelectionSchema = z.object({
  jobId: z.string(),
  provider: z.string(),
  cost: z.number().nonnegative(),
  result: z.unknown().optional(),
});

export type ProviderSelection = z.infer<typeof ProviderSelectionSchema>;

export interface RegistryAgent {
  id: string;
  capabilities: CapabilityTag[];
  reputation: number;
  price: number;
}

interface LlmMessage {
  role: "system" | "user";
  content: string;
}

async function callOpenAi(messages: LlmMessage[]): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: AGENT_LLM_MODEL,
      messages,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI request failed: ${res.status}`);
  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return data.choices[0].message.content;
}

async function callAnthropic(messages: LlmMessage[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const system = messages.find((m) => m.role === "system")?.content;
  const userMessages = messages.filter((m) => m.role === "user");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: AGENT_LLM_MODEL,
      max_tokens: 1024,
      system,
      messages: userMessages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic request failed: ${res.status}`);
  const data = (await res.json()) as { content: { text: string }[] };
  return data.content[0].text;
}

async function callLlm(messages: LlmMessage[]): Promise<string> {
  return AGENT_LLM_PROVIDER === "anthropic"
    ? callAnthropic(messages)
    : callOpenAi(messages);
}

function extractJson(raw: string): unknown {
  const match = raw.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : raw);
}

/**
 * Classify a natural-language task into capability tags using the configured LLM.
 */
export async function classifyTask(prompt: string): Promise<TaskClassification> {
  const raw = await callLlm([
    {
      role: "system",
      content:
        "You classify buyer tasks. Respond with JSON only: " +
        `{"capabilities": string[], "summary": string, "maxPrice"?: number}. ` +
        `Allowed capabilities: ${CAPABILITY_TAGS.join(", ")}.`,
    },
    { role: "user", content: prompt },
  ]);
  return TaskClassificationSchema.parse(extractJson(raw));
}

/**
 * Find registry agents that cover every requested capability.
 */
export function findMatchingAgents(
  agents: RegistryAgent[],
  capabilities: CapabilityTag[],
): RegistryAgent[] {
  return agents.filter((agent) =>
    capabilities.every((cap) => agent.capabilities.includes(cap)),
  );
}

/**
 * Select the best provider by reputation score and price.
 */
export function selectProvider(
  agents: RegistryAgent[],
  maxPrice?: number,
): RegistryAgent | undefined {
  const candidates =
    maxPrice === undefined ? agents : agents.filter((a) => a.price <= maxPrice);
  return candidates.sort((a, b) => {
    if (b.reputation !== a.reputation) return b.reputation - a.reputation;
    return a.price - b.price;
  })[0];
}

export interface EscrowJob {
  id: string;
  provider: string;
  cost: number;
  status: "pending" | "completed" | "failed";
  result?: unknown;
}

export interface BuyerAgentDeps {
  listAgents: () => Promise<RegistryAgent[]>;
  createEscrowJob: (input: {
    provider: string;
    cost: number;
    capabilities: CapabilityTag[];
  }) => Promise<EscrowJob>;
  getJob: (jobId: string) => Promise<EscrowJob>;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the full buyer flow: classify -> registry lookup -> select -> escrow -> poll.
 */
export async function runBuyerAgent(
  prompt: string,
  deps: BuyerAgentDeps,
): Promise<ProviderSelection> {
  const classification = await classifyTask(prompt);
  const agents = await deps.listAgents();
  const matches = findMatchingAgents(agents, classification.capabilities);
  const provider = selectProvider(matches, classification.maxPrice);
  if (!provider) {
    throw new Error(
      `No provider found for capabilities: ${classification.capabilities.join(", ")}`,
    );
  }

  const pollIntervalMs = deps.pollIntervalMs ?? 2000;
  const timeoutMs = deps.timeoutMs ?? 60000;
  const deadline = Date.now() + timeoutMs;

  let job = await deps.createEscrowJob({
    provider: provider.id,
    cost: provider.price,
    capabilities: classification.capabilities,
  });

  while (Date.now() < deadline) {
    job = await deps.getJob(job.id);
    if (job.status === "completed") {
      return ProviderSelectionSchema.parse({
        jobId: job.id,
        provider: provider.id,
        cost: job.cost,
        result: job.result,
      });
    }
    if (job.status === "failed") break;
    await sleep(pollIntervalMs);
  }

  throw new Error(`Provider ${provider.id} failed to complete job ${job.id} in time`);
}
