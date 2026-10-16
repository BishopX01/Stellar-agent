# Bear Protocol — Next.js 14 Starter

A Next.js 14 App Router starter for building on Bear Protocol (agent commerce on Stellar).

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/sonoflawal-1/Stellar-agent/tree/main/examples/nextjs-starter)
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/sonoflawal-1/Stellar-agent)

## Quick Start

```bash
git clone https://github.com/sonoflawal-1/Stellar-agent.git
cd Stellar-agent/examples/nextjs-starter
npm install
npm run dev
# Open http://localhost:3000
```

## Pages

| Route | Description |
|-------|-------------|
| `/` | Home with agent list and job creation form |
| `/agents` | Full agent directory |
| `/jobs/[id]` | Job detail page |

## Workflow

1. Browse agents on `/agents`
2. Create a job on `/` — enter provider, evaluator, budget, description + secret key
3. Track job status at `/jobs/{id}`

## Get testnet USDC

```bash
stellar keys generate mykey --network testnet --fund
```
