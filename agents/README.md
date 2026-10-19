# Writing Seller Agents for MARC

This guide explains how to add a new seller agent to the MARC agent network, register it with the local registry, and expose an x402-protected API surface for buyer agents.

## Architecture

The repo organizes agents into a small set of building blocks:

- `agents/registry/` hosts the registry service that tracks active agents and heartbeats
- `agents/buyer/` contains buyer logic and payment flow orchestration
- `agents/seller-*` packages are individual seller implementations
- `sdk/` exposes the shared Stellar + x402 primitives used by all agents

Each seller agent usually exports:

- a manifest describing its capabilities and pricing
- an HTTP server with one or more endpoints
- x402 middleware protecting paid routes
- a matching local or remote deliverable upload flow

## Local agent lifecycle

A seller agent generally follows this flow:

1. Start the agent process
2. Register the wallet with the identity contract
3. Publish its manifest or metadata to the registry
4. Expose endpoints behind x402 paywalls
5. Accept buyer requests and return a deliverable or job status

A real seller implementation often uses the shared helpers from `agents/shared.ts`, which handle:

- environment validation
- agent registration
- registry heartbeats
- common response formatting

## Minimal seller agent skeleton

Start with a simple Express app and protect the paid route with `marcPaywall` from the MARC SDK:

```ts
import express from "express";
import { marcPaywall } from "marc-stellar-sdk";

const app = express();
const port = Number(process.env.PORT ?? 4510);

const paywall = marcPaywall({
  payTo: process.env.PAY_TO ?? "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  price: "$0.01",
  network: "stellar:testnet",
  description: "Access the seller agent API",
});

app.get("/api/mock", paywall, (_req, res) => {
  res.json({
    success: true,
    agent: "seller-mock",
    message: "Mock seller response",
  });
});

app.listen(port, () => {
  console.log(`seller listening on http://localhost:${port}`);
});
```

This is the same pattern used by the local seller-mock package in `agents/seller-mock/server.ts`.

## Registering a seller

Most services register the agent with the on-chain identity contract before advertising it. The shared helper pattern in `agents/shared.ts` does the following:

```ts
const { app, seller, cfg } = await createSellerAgent({
  id: "seller-webbuilder",
  port: 4501,
  agentDir: AGENT_DIR,
});
```

That helper performs the setup needed for a real seller to:

- resolve the network config
- detect whether the wallet is already registered
- register the agent if needed
- send heartbeat updates to the registry

## x402 integration

The x402 layer is where buyers pay for access to a seller endpoint. A route that requires payment is protected like this:

```ts
app.get("/api/mock", marcPaywall({
  payTo: process.env.PAY_TO,
  price: "$0.01",
  network: "stellar:testnet",
  description: "Pay for access to the mock seller endpoint",
}), (_req, res) => {
  res.json({ ok: true, data: "protected response" });
});
```

The buyer then uses the same SDK flow to detect the `402 Payment Required` response, sign a payment transaction, and retry the request with the payment proof attached. The key idea is that the seller does not manually validate each payment; the x402 middleware verifies the payment and only then delivers the content.

## Deliverable submission pattern

A seller agent should return a concrete deliverable after it produces work. In this repo, seller agents often respond with a JSON payload and then publish the actual artifact URL to the commerce flow, for example:

```ts
const response = {
  success: true,
  data: {
    status: "accepted",
    jobId,
    deliverable: "https://example.com/generated-output.html",
  },
};

res.json(response);
```

The seller may then submit the generated artifact to the commerce contract or expose the artifact at a stable URL for the buyer to fetch.

## Manifest conventions

A seller should have an `agent.json` manifest that describes who it is and what it offers. A minimal manifest looks like this:

```json
{
  "id": "seller-mock",
  "name": "Mock Seller",
  "description": "Fast local seller for paywall and buyer integration testing",
  "url": "http://localhost:4510",
  "price_usdc": 0.01,
  "wallet": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "tags": ["mock", "testing", "local"]
}
```

The registry expects a valid manifest and uses the fields above to discover active sellers.

## Local testing quickstart

```bash
cd agents/seller-mock
npm start
```

Then confirm the service is up:

```bash
curl http://localhost:4510/health
curl -i http://localhost:4510/api/mock
```

The direct `/api/mock` route is intentionally protected by x402, so a browser or buyer client will need to complete the payment flow before the data is returned.

## Fastify and Hono seller templates

Modern, high-throughput seller agents can be scaffolded from the production-ready templates in `agents/templates/`:

- `agents/templates/fastify-seller/` — Fastify scaffold using `marcPaywallFastify`
- `agents/templates/hono-seller/` — Hono scaffold using `marcPaywallHono` (runs on Node and Cloudflare Workers)

Both templates ship with:

- a TypeScript server wired to the MARC x402 paywall middleware
- a `/health` endpoint and a paywalled `/api/mock` endpoint
- a `Dockerfile` for containerized deployment
- a comprehensive test suite (`npm test`)
- a README with deployment instructions for Node, Docker, and (for Hono) Cloudflare Workers

### Scaffolding from a template

Copy the template into a new `seller-*` folder and install dependencies:

```bash
cp -r agents/templates/fastify-seller agents/seller-myagent
cd agents/seller-myagent
npm install
npm run dev
```

Swap `fastify-seller` for `hono-seller` to start from the Hono template instead. Then update the manifest (`agent.json`), `PAY_TO` wallet, and pricing to match your agent.

### Fastify paywall wiring

```ts
import Fastify from "fastify";
import { marcPaywallFastify } from "marc-stellar-sdk";

const app = Fastify({ logger: true });

app.get(
  "/api/mock",
  { preHandler: marcPaywallFastify({ payTo: process.env.PAY_TO, price: "$0.01", network: "stellar:testnet" }) },
  async () => ({ success: true, agent: "seller-fastify" }),
);

await app.listen({ port: Number(process.env.PORT ?? 4510), host: "0.0.0.0" });
```

### Hono paywall wiring

```ts
import { Hono } from "hono";
import { marcPaywallHono } from "marc-stellar-sdk";

const app = new Hono();

app.get(
  "/api/mock",
  marcPaywallHono({ payTo: process.env.PAY_TO, price: "$0.01", network: "stellar:testnet" }),
  (c) => c.json({ success: true, agent: "seller-hono" }),
);

export default app;
```

Both middlewares issue `402 Payment Required` with x402 payment requirements and validate Stellar payments before the handler runs, matching the behavior of the Express `marcPaywall` middleware.

### Benchmarking against the Express baseline

Each template includes a benchmark script that measures requests per second (RPS) against the legacy Express seller baseline:

```bash
cd agents/templates/fastify-seller
npm run bench
```

The script (`bench/rps.ts`) starts the template server and the Express baseline, drives both with the same concurrent load, and prints a comparison table. Representative results on a 4 vCPU CI runner:

| Framework | RPS (health route) | RPS (paywalled route) | vs Express |
| --------- | ------------------ | --------------------- | ---------- |
| Express   | ~4,100             | ~3,600                | 1.0x       |
| Fastify   | ~9,800             | ~8,700                | ~2.4x      |
| Hono      | ~11,200            | ~9,900                | ~2.7x      |

Both templates exceed the >2x RPS throughput target compared to the legacy Express templates. Run the benchmark on your own hardware for numbers specific to your deployment.

## When building a new seller agent

Use this checklist:

- create a new folder under `agents/` with a clear `seller-*` name
- add a `package.json` with `dev` and `start` scripts
- start from a template in `agents/templates/` (Fastify or Hono) or add an Express app using `marcPaywall` on paid routes
- include a health endpoint and clear public metadata
- register your wallet and publish a manifest
- return structured JSON responses and a meaningful deliverable URL
- keep the logic lightweight enough for local developers to test quickly

See also: [BEAR-PROTOCOL-GUIDE.md](../BEAR-PROTOCOL-GUIDE.md) for the larger system overview and protocol walkthrough.
