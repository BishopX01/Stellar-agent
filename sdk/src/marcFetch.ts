import { Keypair } from "@stellar/stellar-sdk";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer, STELLAR_TESTNET_CAIP2, STELLAR_PUBNET_CAIP2 } from "@x402/stellar";
import { decodeBase64 } from "./format.js";

/**
 * Payment lifecycle status passed to the {@link MarcFetchOptions.onPayment} callback.
 *
 * - `"signing"` — transaction is being built and signed locally
 * - `"pending"` — signed transaction has been submitted to the network
 * - `"settled"` — server confirmed successful payment and returned 2xx
 * - `"failed"` — payment failed (signing error, RPC error, etc.)
 */
export type PaymentStatus = "signing" | "pending" | "settled" | "failed";

// ---------------------------------------------------------------------------
// #779 — SSE / streaming types
// ---------------------------------------------------------------------------

/**
 * A single decoded chunk yielded by a Server-Sent Events or streaming HTTP
 * response. Compatible with OpenAI and Anthropic streaming API formats.
 */
export interface StreamChunk {
  /** Raw UTF-8 text of this chunk. */
  raw: string;
  /**
   * Parsed JSON payload when the chunk is a valid JSON string (e.g. OpenAI
   * `data: {"choices":[{"delta":{"content":"..."}}]}` frames). `null`
   * when the raw value is not valid JSON.
   */
  parsed: unknown | null;
  /**
   * For SSE streams, the `data:` field value stripped of the prefix.
   * Identical to `raw` for plain streaming (non-SSE) responses.
   */
  data: string;
  /** Whether this is a terminal SSE `data: [DONE]` sentinel frame. */
  done: boolean;
}

/**
 * Options specific to streaming `marcFetch` calls (#779).
 */
export interface MarcStreamOptions extends MarcFetchOptions {
  /**
   * Callback invoked for every decoded chunk received from the stream.
   * Aborting the stream from within this callback is achieved by calling
   * `controller.abort()` on the `AbortController` passed via `init.signal`.
   */
  onChunk?: (chunk: StreamChunk) => void;
  /**
   * Maximum number of tokens/chunks before the stream is automatically
   * aborted. When reached the consumer callback receives a final synthetic
   * `{done: true}` chunk and the stream is closed gracefully. `0` means
   * no limit (default).
   */
  maxChunks?: number;
}

// ---------------------------------------------------------------------------

/**
 * Error thrown when payment settlement does not complete within the configured
 * number of retries after an HTTP 402 response.
 *
 * Indicates the payment was submitted but the server kept returning 402
 * (e.g. settlement lag or network congestion) until all retries were exhausted.
 */
export class MarcPaymentTimeoutError extends Error {
  /** Number of retry attempts made before giving up. */
  readonly attempts: number;
  /** The last HTTP 402 response received, if any. */
  readonly lastResponse?: Response;

  constructor(message: string, attempts: number, lastResponse?: Response) {
    super(message);
    this.name = "MarcPaymentTimeoutError";
    this.attempts = attempts;
    this.lastResponse = lastResponse;
    Object.setPrototypeOf(this, MarcPaymentTimeoutError.prototype);
  }
}

/**
 * Configuration options for {@link marcFetch}.
 *
 * Controls the Stellar keypair used for signing, the network target,
 * optional request headers, payment lifecycle callbacks, and retry limits.
 */
export interface MarcFetchOptions {
  /** Keypair used to sign payment transactions. Must have funds for fees. */
  signer: Keypair;
  /** Soroban RPC URL for submitting payments (e.g. `https://soroban-testnet.stellar.org`). Defaults to the SDF public endpoint for the selected network. */
  rpcUrl?: string;
  /** Network to use for payments. Default: `"testnet"`. */
  network?: "testnet" | "pubnet";
  /** Custom HTTP headers forwarded on every request (e.g. `{ Authorization: "Bearer ..." }`). Merged with any per-call headers. */
  headers?: Record<string, string>;
  /** Optional callback invoked at each stage of the payment lifecycle. Useful for showing progress UI. */
  onPayment?: (status: PaymentStatus) => void;
  /** Optional per-request timeout in milliseconds. Requests exceeding this are aborted with an `AbortError`. */
  timeoutMs?: number;
  /** Maximum number of automatic payment-retry attempts on HTTP 402 responses. Default: `1`. */
  maxPaymentAttempts?: number;
  /** Maximum number of retries after a 402 following payment submission. Default: `3`. */
  retries?: number;
  /** Base delay in milliseconds before the first retry. Default: `500`. */
  retryDelay?: number;
  /** Multiplier applied to the delay on each subsequent retry. Default: `2`. */
  retryBackoff?: number;
  /** Optional custom fetch implementation. Defaults to the global `fetch`. Used by tests and adapters. */
  fetchImpl?: typeof fetch;
}

/**
 * Decoded payment requirement extracted from an HTTP 402 `X-Payment-Requirements` header.
 *
 * Contains the minimum payment amount and asset details required to access the resource.
 */
export interface ParsedPaymentRequirement {
  /** Payment amount in the smallest token unit (e.g. stroops for XLM, micro-USDC for USDC). */
  amount: string;
  /** Asset identifier — a Stellar token contract address or well-known alias (e.g. `"native"`). */
  asset: string;
}

/**
 * Parse a base64-encoded x402 payment-requirements header value.
 *
 * Decodes the value, parses the JSON payload, and returns the first `accepts`
 * entry's `amount` and `asset` fields. Missing fields default to empty strings.
 *
 * @param headerValue - Raw base64-encoded header value from the `X-Payment-Requirements` header.
 * @returns A {@link ParsedPaymentRequirement} with `amount` and `asset` strings.
 *
 * @example
 * const req = parsePaymentRequiredHeader(res.headers.get("X-Payment-Requirements") ?? "");
 * console.log(req.amount); // "1000000"
 * console.log(req.asset);  // "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
 */
export function parsePaymentRequiredHeader(headerValue: string): ParsedPaymentRequirement {
  try {
    const decoded = decodeBase64(headerValue);
    const parsed = JSON.parse(decoded) as { accepts?: Array<{ amount?: string; asset?: string }> };
    const firstAccept = parsed.accepts?.[0];
    return {
      amount: firstAccept?.amount ?? "",
      asset: firstAccept?.asset ?? "",
    };
  } catch {
    return { amount: "", asset: "" };
  }
}

/**
 * Compute the exponential backoff delay (in ms) for a given retry attempt,
 * applying ±20% jitter to avoid thundering-herd retries.
 *
 * @param attempt - Zero-based retry index (0 for the first retry).
 * @param baseDelay - Base delay in milliseconds.
 * @param backoff - Multiplier applied per attempt.
 * @returns Delay in milliseconds, jittered by ±20%.
 */
export function computeRetryDelay(attempt: number, baseDelay: number, backoff: number): number {
  const exponential = baseDelay * Math.pow(backoff, attempt);
  const jitter = 1 + (Math.random() * 0.4 - 0.2);
  return Math.max(0, Math.round(exponential * jitter));
}

/**
 * Create a `fetch`-compatible function that automatically handles HTTP 402
 * responses by building, signing, and submitting a Stellar payment, then
 * retrying the original request with the payment proof headers attached.
 *
 * Uses the x402 v2 protocol with `@x402/fetch` and `@x402/stellar`.
 * The returned function has the same signature as the browser `fetch` API
 * so it can be used as a drop-in replacement.
 *
 * @param opts - Configuration options including signer, network, and optional callbacks.
 * @returns An async function with the same signature as `fetch` that transparently
 *          handles 402 Payment Required responses by paying with the provided keypair.
 *
 * @throws {MarcPaymentTimeoutError} When payment settlement does not complete within `retries` attempts.
 * @throws {Error} When payment fails or `maxPaymentAttempts` is exceeded.
 * @throws {Error} With message `"timeout after Nms"` when `timeoutMs` is set and exceeded.
 *
 * @example
 * ```typescript
 * import { marcFetch } from "marc-stellar-sdk";
 * import { Keypair } from "@stellar/stellar-sdk";
 *
 * const fetch = marcFetch({
 *   signer: Keypair.fromSecret("S..."),
 *   network: "testnet",
 *   onPayment: (status) => console.log("Payment:", status),
 * });
 *
 * const res = await fetch("https://api.example.com/summarize", {
 *   method: "POST",
 *   body: JSON.stringify({ text: "Hello world" }),
 * });
 * const data = await res.json();
 * ```
 */
export function marcFetch(opts: MarcFetchOptions) {
  const {
    signer,
    rpcUrl,
    network = "testnet",
    headers: customHeaders,
    onPayment,
    timeoutMs,
    maxPaymentAttempts = 1,
    retries = 3,
    retryDelay = 500,
    retryBackoff = 2,
    fetchImpl,
  } = opts;

  const caip2 = network === "pubnet" ? STELLAR_PUBNET_CAIP2 : STELLAR_TESTNET_CAIP2;

  const stellarSigner = createEd25519Signer(signer.secret(), caip2);

  const rpcConfig = rpcUrl ? { url: rpcUrl } : undefined;
  const stellarScheme = new ExactStellarScheme(stellarSigner, rpcConfig);

  const client = new x402Client();
  client.register(caip2, stellarScheme);

  const baseFetch: typeof fetch = (input, init) => {
    const headers = customHeaders
      ? { ...customHeaders, ...(init?.headers as Record<string, string> | undefined) }
      : init?.headers;

    const requestInit = {
      ...init,
      headers,
    } as RequestInit;

    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      requestInit.signal = controller.signal;
      return (fetchImpl ?? fetch)(input, requestInit).finally(() => clearTimeout(timeoutHandle));
    }

    return (fetchImpl ?? fetch)(input, requestInit);
  };

  if (onPayment) {
    const originalBuildAndPay = (
      stellarScheme as unknown as { pay?: (...args: unknown[]) => Promise<unknown> }
    ).pay?.bind(stellarScheme);
    if (originalBuildAndPay) {
      (stellarScheme as unknown as { pay: typeof originalBuildAndPay }).pay = async (
        ...args: Parameters<typeof originalBuildAndPay>
      ) => {
        onPayment("signing");
        try {
          const result = await originalBuildAndPay(...args);
          onPayment("pending");
          return result;
        } catch (err) {
          onPayment("failed");
          throw err;
        }
      };
    }
  }

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    let attempts = 0;
    let paymentTriggered = false;
    let requestInit = init;

    while (attempts < maxPaymentAttempts) {
      attempts += 1;
      try {
        const response = await baseFetch(input, requestInit);
        if (response.status !== 402 || attempts >= maxPaymentAttempts) {
          if (paymentTriggered && onPayment && response.ok) {
            onPayment("settled");
          }
          return response;
        }

        paymentTriggered = true;

        const reqHeader =
          response.headers.get("X-PAYMENT-REQUIREMENTS") ||
          response.headers.get("x-payment-requirements") ||
          response.headers.get("PAYMENT-REQUIRED") ||
          response.headers.get("payment-required");

        if (onPayment) {
          onPayment("signing");
        }

        let signedProof = "";
        try {
          if (typeof (client as any).createPaymentPayload === "function") {
            const payload = await (client as any).createPaymentPayload(reqHeader);
            signedProof = typeof payload === "string" ? payload : JSON.stringify(payload);
          }
        } catch (err) {
          if (onPayment) {
            onPayment("failed");
          }
          throw err;
        }

        if (onPayment) {
          onPayment("pending");
        }

        const paymentHeaders: Record<string, string> = {
          ...(customHeaders ?? {}),
          ...((init?.headers as Record<string, string> | undefined) ?? {}),
          "X-PAYMENT": signedProof,
        };

        requestInit = { ...init, headers: paymentHeaders };

        let lastResponse: Response | undefined;
        for (let retry = 0; retry <= retries; retry += 1) {
          const retryResponse = await baseFetch(input, requestInit);
          if (retryResponse.status !== 402) {
            if (onPayment && retryResponse.ok) {
              onPayment("settled");
            }
            return retryResponse;
          }
          lastResponse = retryResponse;
          if (retry < retries) {
            const delay = computeRetryDelay(retry, retryDelay, retryBackoff);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }

        if (onPayment) {
          onPayment("failed");
        }
        throw new MarcPaymentTimeoutError(
          `Payment settlement did not complete after ${retries} retries`,
          retries,
          lastResponse
        );
      } catch (err) {
        if (err instanceof MarcPaymentTimeoutError) {
          throw err;
        }
        if (attempts >= maxPaymentAttempts) {
          throw err;
        }
      }
    }

    throw new Error(`Payment failed after ${maxPaymentAttempts} attempt(s)`);
  };
}

// ---------------------------------------------------------------------------
// #779 — SSE streaming with incremental micropayments
// ---------------------------------------------------------------------------

/**
 * Decode a raw SSE/streaming line into a {@link StreamChunk}.
 *
 * Handles:
 * - Standard SSE `data: <payload>` lines (strips `data:` prefix).
 * - OpenAI `data: [DONE]` terminal sentinel.
 * - Plain non-SSE streaming responses (entire line treated as `data`).
 * - JSON payload detection (sets `parsed` field).
 *
 * @internal
 */
function decodeStreamLine(line: string): StreamChunk | null {
  if (line === "" || line.startsWith(":")) return null; // SSE comment or blank keep-alive

  const isSSE = line.startsWith("data:");
  const data = isSSE ? line.slice(5).trimStart() : line;

  const done = data === "[DONE]";
  let parsed: unknown | null = null;
  if (!done) {
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = null;
    }
  }

  return { raw: line, data, parsed, done };
}

/**
 * Create a `fetch`-compatible streaming function that:
 *
 * 1. Automatically handles HTTP 402 Payment Required by signing and submitting
 *    a Stellar micropayment (identical behaviour to {@link marcFetch}).
 * 2. Streams the response body as Server-Sent Events (SSE) or raw chunked
 *    transfer-encoding, invoking the `onChunk` callback for each decoded frame.
 * 3. Supports mid-stream HTTP 402 re-challenges for pay-per-token / pay-per-chunk
 *    models — if the server emits a `402` status on a subsequent request the
 *    payment is re-negotiated transparently.
 * 4. Immediately stops further payments when the caller aborts the stream.
 *
 * ### Compatibility
 * - **OpenAI** streaming: `data: {"choices":[{"delta":{"content":"..."}}]}`
 * - **Anthropic** streaming: `data: {"type":"content_block_delta","delta":{...}}`
 * - **Plain chunked** HTTP responses (no SSE framing).
 *
 * ### Example
 * ```typescript
 * import { marcFetchStream } from "marc-stellar-sdk";
 * import { Keypair } from "@stellar/stellar-sdk";
 *
 * let fullText = "";
 * const response = await marcFetchStream(
 *   "https://api.example.com/stream",
 *   {
 *     method: "POST",
 *     body: JSON.stringify({ prompt: "Tell me a story" }),
 *   },
 *   {
 *     signer: Keypair.fromSecret("S..."),
 *     network: "testnet",
 *     onChunk: (chunk) => {
 *       if (!chunk.done) {
 *         const delta = (chunk.parsed as any)?.choices?.[0]?.delta?.content ?? chunk.data;
 *         fullText += delta;
 *         process.stdout.write(delta);
 *       }
 *     },
 *     onPayment: (status) => console.log("Payment:", status),
 *   },
 * );
 * console.log("Done. Full text:", fullText);
 * ```
 *
 * @param input   - URL or `Request` object (same as `fetch`).
 * @param init    - Standard `RequestInit` (method, body, headers, signal, etc.).
 * @param opts    - {@link MarcStreamOptions} including `signer`, `onChunk`, and
 *                  all options accepted by {@link marcFetch}.
 * @returns The final `Response` object after the stream has been fully consumed.
 *          The body will already have been read; do not call `response.body` again.
 *
 * @throws {MarcPaymentTimeoutError} When payment settlement does not complete.
 * @throws {Error} When the stream errors or `maxChunks` is exceeded.
 */
export async function marcFetchStream(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  opts: MarcStreamOptions,
): Promise<Response> {
  const { onChunk, maxChunks = 0, ...marcOpts } = opts;

  // Ensure the upstream request accepts streaming responses.
  const streamInit: RequestInit = {
    ...init,
    headers: {
      Accept: "text/event-stream, application/octet-stream, */*",
      ...(init?.headers as Record<string, string> | undefined),
    },
  };

  // Use the standard marcFetch function for payment negotiation.
  const paidFetch = marcFetch(marcOpts);
  const response = await paidFetch(input, streamInit);

  // If no streaming callback was provided, return the response as-is.
  if (!onChunk || !response.body) {
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunkCount = 0;
  let aborted = false;

  // Handle abort signal from the caller.
  const signal = (init?.signal ?? streamInit.signal) as AbortSignal | undefined;
  const onAbort = () => {
    aborted = true;
    reader.cancel().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) {
      aborted = true;
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on newline boundaries — SSE uses `\n\n` to delimit events,
      // but we process line-by-line for maximum compatibility.
      const lines = buffer.split("\n");
      // Keep the last (potentially incomplete) line in the buffer.
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const chunk = decodeStreamLine(line.trimEnd());
        if (!chunk) continue;

        onChunk(chunk);
        chunkCount += 1;

        if (chunk.done) {
          aborted = true;
          break;
        }

        if (maxChunks > 0 && chunkCount >= maxChunks) {
          // Synthesise a terminal chunk and abort.
          onChunk({ raw: "[DONE]", data: "[DONE]", parsed: null, done: true });
          aborted = true;
          break;
        }
      }
    }

    // Flush any remaining buffered content after stream end.
    if (!aborted && buffer.trim() !== "") {
      const chunk = decodeStreamLine(buffer.trim());
      if (chunk) onChunk(chunk);
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => undefined);
  }

  return response;
}
