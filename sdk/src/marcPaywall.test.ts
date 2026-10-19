import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { marcPaywall } from "./marcPaywall.js";

// marcPaywall() eagerly kicks off a background request to the facilitator's
// /supported endpoint (x402ResourceServer's syncFacilitatorOnStart default).
// Stub fetch so that call resolves locally instead of hitting the real
// network and leaking an unhandled rejection once the test has finished.
const originalFetch = globalThis.fetch;

function stubFacilitatorFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/supported")) {
      return new Response(
        JSON.stringify({
          kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
          extensions: [],
          signers: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function fakeResponse() {
  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  let ended = false;
  const res = {
    headers,
    get statusCode() {
      return statusCode;
    },
    get ended() {
      return ended;
    },
    setHeader(key: string, value: string) {
      headers[key] = value;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    end() {
      ended = true;
    },
  };
  return res;
}

// Give the stubbed background facilitator fetch a turn to settle before the
// test (and its fetch stub) tears down.
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

// A syntactically valid base64 blob standing in for a signed payment XDR. The
// paywall only needs to be able to derive a stable hash from it for the
// deduplication tests below.
function fakePaymentHeader(seed: string): string {
  return Buffer.from(`signed-payment-xdr:${seed}`).toString("base64");
}

function paymentRequest(header: string) {
  return {
    method: "POST",
    headers: { "x-payment": header },
    body: {},
  };
}

// Drive the handler and resolve once it either calls next() (payment accepted)
// or writes a response (rejected / cached replay).
function invoke(
  handler: unknown,
  req: unknown,
): Promise<{ statusCode?: number; ended: boolean; nextCalled: boolean; res: ReturnType<typeof fakeResponse> }> {
  return new Promise((resolve) => {
    const res = fakeResponse();
    let nextCalled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (handler as any)(req, res, () => {
      nextCalled = true;
      resolve({ statusCode: res.statusCode, ended: res.ended, nextCalled, res });
    });
    // Poll for the response path (rejections never call next()).
    const timer = setInterval(() => {
      if (res.ended) {
        clearInterval(timer);
        resolve({ statusCode: res.statusCode, ended: res.ended, nextCalled, res });
      }
    }, 1);
  });
}

test("marcPaywall returns an Express-style request handler", async () => {
  stubFacilitatorFetch();
  try {
    const handler = marcPaywall({ payTo: Keypair.random().publicKey(), price: "$0.01" });
    assert.equal(typeof handler, "function");
    await flush();
  } finally {
    restoreFetch();
  }
});

test("marcPaywall short-circuits CORS preflight requests without invoking the payment check", async () => {
  stubFacilitatorFetch();
  try {
    const handler = marcPaywall({ payTo: Keypair.random().publicKey(), price: "$0.01" });
    const req = { method: "OPTIONS", headers: { origin: "https://buyer.example" } };
    const res = fakeResponse();
    let nextCalled = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (handler as any)(req, res, () => {
      nextCalled = true;
    });

    assert.equal(res.statusCode, 204);
    assert.equal(res.ended, true);
    assert.equal(nextCalled, false);
    assert.equal(res.headers["Access-Control-Allow-Origin"], "https://buyer.example");
    assert.equal(
      res.headers["Access-Control-Allow-Methods"],
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    assert.equal(
      res.headers["Access-Control-Allow-Headers"],
      "Content-Type, Authorization, X-Payment, X-Payment-Response",
    );
    await flush();
  } finally {
    restoreFetch();
  }
});

test("marcPaywall falls back to a wildcard CORS origin when none is sent", async () => {
  stubFacilitatorFetch();
  try {
    const handler = marcPaywall({ payTo: Keypair.random().publicKey(), price: "$0.01" });
    const req = { method: "OPTIONS", headers: {} };
    const res = fakeResponse();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (handler as any)(req, res, () => {});

    assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
    await flush();
  } finally {
    restoreFetch();
  }
});

test("marcPaywall extracts a stable transaction hash from the X-Payment header", async () => {
  stubFacilitatorFetch();
  try {
    const handler = marcPaywall({ payTo: Keypair.random().publicKey(), price: "$0.01" });
    const header = fakePaymentHeader("stable-hash");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extract = (handler as any).extractTransactionHash;
    assert.equal(typeof extract, "function", "handler should expose extractTransactionHash");

    const first = extract(header);
    const second = extract(header);
    assert.equal(typeof first, "string");
    assert.ok(first.length > 0);
    assert.equal(first, second, "same header must yield the same tx hash");
    assert.notEqual(first, extract(fakePaymentHeader("different-hash")));
    await flush();
  } finally {
    restoreFetch();
  }
});

test("marcPaywall rejects a concurrent replay of an in-flight payment with 409", async () => {
  stubFacilitatorFetch();
  try {
    const handler = marcPaywall({ payTo: Keypair.random().publicKey(), price: "$0.01" });
    const header = fakePaymentHeader("concurrent-replay");

    // First request claims the tx hash and is left PROCESSING (facilitator
    // verification is stubbed to hang), so the second must be rejected.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = invoke(handler, paymentRequest(header));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = await invoke(handler, paymentRequest(header));

    assert.equal(second.statusCode, 409);
    assert.equal(second.ended, true);
    assert.equal(second.nextCalled, false);

    // Let the first settle so the test can tear down cleanly.
    await Promise.race([first, flush()]);
    await flush();
  } finally {
    restoreFetch();
  }
});

test("marcPaywall re-delivers the cached response for a retried settled payment", async () => {
  stubFacilitatorFetch();
  try {
    const handler = marcPaywall({ payTo: Keypair.random().publicKey(), price: "$0.01" });
    const header = fakePaymentHeader("settled-retry");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = await invoke(handler, paymentRequest(header));
    assert.equal(first.nextCalled, true, "first request should be accepted");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const retry = await invoke(handler, paymentRequest(header));
    assert.equal(retry.nextCalled, false, "retry must not re-execute the handler");
    assert.equal(retry.ended, true, "retry must receive a cached response");
    assert.equal(retry.statusCode, first.statusCode);
    await flush();
  } finally {
    restoreFetch();
  }
});

test("marcPaywall expires settled transactions after one hour", async () => {
  stubFacilitatorFetch();
  try {
    const handler = marcPaywall({ payTo: Keypair.random().publicKey(), price: "$0.01" });
    const header = fakePaymentHeader("expiry");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = await invoke(handler, paymentRequest(header));
    assert.equal(first.nextCalled, true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = (handler as any).paymentCache;
    assert.ok(cache, "handler should expose its payment cache");
    const txHash = (handler as any).extractTransactionHash(header);
    const entry = cache.get(txHash);
    assert.ok(entry, "settled tx should be cached");
    assert.equal(entry.status, "SETTLED");

    // Simulate the passage of more than one hour.
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 60 * 60 * 1000 + 1;
      assert.equal(cache.get(txHash), undefined, "settled entry should expire after 1h");
    } finally {
      Date.now = originalNow;
    }
    await flush();
  } finally {
    restoreFetch();
  }
});
