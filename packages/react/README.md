# @bear-protocol/react

Idiomatic React hooks for integrating [Bear Protocol](https://github.com/bear-protocol) into React applications. This package wraps `marc-stellar-sdk` (`IdentityClient`, `CommerceClient`, and `marcFetch`) so you can drop async state, loading indicators, and error handling into your components without boilerplate.

## Installation

```bash
npm install @bear-protocol/react marc-stellar-sdk react
```

`react` (>= 18) is a peer dependency.

## Setup

Wrap your app in the provider so the hooks can reach the configured clients:

```tsx
import { BearProvider } from '@bear-protocol/react'

function App() {
  return (
    <BearProvider network="testnet">
      <YourApp />
    </BearProvider>
  )
}
```

## Hooks

### `useAgent(id, options?)`

Read-only hook wrapping `IdentityClient.getAgent()`. Returns the agent record along with `loading` and `error` state.

Requests are cached in memory and deduplicated: mounting many components with the same `id` triggers a single RPC call, and cached data is returned immediately (stale-while-revalidate) while fresh data is fetched in the background.

Options:

| Option   | Type     | Default | Description                                                        |
| -------- | -------- | ------- | ------------------------------------------------------------------ |
| `ttlMs`  | `number` | `60000` | How long cached data is considered fresh before revalidating.      |

```tsx
import { useAgent } from '@bear-protocol/react'

function AgentCard({ agentId }: { agentId: string }) {
  const { agent, loading, error } = useAgent(agentId, { ttlMs: 30_000 })

  if (loading) return <Spinner />
  if (error) return <ErrorBanner error={error} />
  if (!agent) return null

  return <h2>{agent.name}</h2>
}
```

### `useJob(id)`

Read-only hook wrapping `CommerceClient.getJob()`.

```tsx
import { useJob } from '@bear-protocol/react'

function JobStatus({ jobId }: { jobId: string }) {
  const { job, loading, error } = useJob(jobId)

  if (loading) return <Spinner />
  if (error) return <ErrorBanner error={error} />

  return <span>Status: {job?.status}</span>
}
```

### `useCreateJob()`

Mutation hook for creating jobs. Exposes `createJob`, a `pending` flag, and an `error`. Supports optimistic UI by letting you pass an optimistic job that is reconciled once the request resolves.

```tsx
import { useCreateJob } from '@bear-protocol/react'

function NewJobButton() {
  const { createJob, pending, error } = useCreateJob()

  return (
    <button
      disabled={pending}
      onClick={() =>
        createJob(
          { agentId: 'agent-1', budget: '10' },
          { optimistic: { id: 'temp', status: 'pending' } },
        )
      }
    >
      {pending ? 'Creating…' : 'Create job'}
    </button>
  )
}
```

### `useFreighter()`

Manages Freighter wallet connection state.

```tsx
import { useFreighter } from '@bear-protocol/react'

function ConnectButton() {
  const { connected, address, connect, disconnect } = useFreighter()

  if (connected) {
    return (
      <button onClick={disconnect}>
        {address?.slice(0, 6)}…{address?.slice(-4)}
      </button>
    )
  }

  return <button onClick={connect}>Connect Freighter</button>
}
```

### `useMarcFetch(keypair)`

Wraps `marcFetch` and surfaces x402 payment status so you can render paywall UI while a request is being paid for.

```tsx
import { useMarcFetch } from '@bear-protocol/react'

function PaidResource({ keypair }: { keypair: Keypair }) {
  const { fetch, isPaying, error } = useMarcFetch(keypair)

  const load = async () => {
    const res = await fetch('https://api.bear-protocol.xyz/premium')
    return res.json()
  }

  return (
    <button onClick={load} disabled={isPaying}>
      {isPaying ? 'Processing payment…' : 'Load premium data'}
    </button>
  )
}
```

## Types

The package ships exhaustive TypeScript types for every hook and component, with `isolatedModules` and `declarationMap` enabled. Hook option and result interfaces (`UseAgentOptions`, `UseAgentResult`, `UseJobResult`, `UseCommerceResult`, …) and component prop interfaces are exported from the package root, and essential core types (`Agent`, `Job`, `JobStatus`, `MarcConfig`, …) are re-exported directly from `marc-stellar-sdk` so you don't need to import from both packages.

```tsx
import type { Agent, Job, JobStatus, UseAgentOptions } from '@bear-protocol/react'
```

## Storybook

An interactive Storybook showcase documents every component and hook with live controls, dark/light theme toggles, and copy-pasteable code snippets for each story.

```bash
npm run storybook        # start the local dev server (http://localhost:6006)
npm run build-storybook  # build the static documentation site into storybook-static/
```

The static site is built and deployed to GitHub Pages from CI. Once deployed it is available at:

https://bear-protocol.github.io/bear-protocol/

## Development

```bash
npm install
npm test        # Jest + React Testing Library
npm run storybook
```

## License

MIT
