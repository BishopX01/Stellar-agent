# PowerShell script to define and generate all 100 issues
$ErrorActionPreference = "Stop"

$issues = @()

function Add-Issue {
    param(
        [int]$Number,
        [string]$Title,
        [string]$Category,
        [string]$Labels,
        [string]$Difficulty,
        [string]$Skills,
        [string]$Summary,
        [string]$Motivation,
        [string]$Implementation,
        [string[]]$AcceptanceCriteria
    )

    $criteriaMd = ($AcceptanceCriteria | ForEach-Object { "- [ ] $_" }) -join "`n"

    $body = @"
## Summary

$Summary

## Motivation & Code Context

$Motivation

## Proposed Architecture & Implementation

$Implementation

## Acceptance Criteria

$criteriaMd

**Category:** $Category  
**Labels:** $Labels  
**Difficulty:** $Difficulty  
**Skills:** $Skills
"@

    $global:issues += [PSCustomObject]@{
        number = $Number
        title = $Title
        category = $Category
        labels = $Labels
        difficulty = $Difficulty
        skills = $Skills
        body = $body
    }
}

# ==========================================
# CATEGORY 1: SMART CONTRACTS (Soroban / Rust)
# ==========================================

Add-Issue -Number 1 `
  -Title "feat(contracts): implement milestone-based progressive escrow releases in agentic-commerce" `
  -Category "Smart Contracts" `
  -Labels "contracts,enhancement,Stellar Wave" `
  -Difficulty "Hard" `
  -Skills "Rust, Soroban, TypeScript" `
  -Summary "Extend the agentic-commerce contract (contracts/agentic-commerce/src/lib.rs) to support multi-stage milestone releases for high-value agent jobs, allowing clients to fund a total budget split across sequential deliverables with independent verification." `
  -Motivation "In contracts/agentic-commerce/src/lib.rs:L70-L90, the Job struct currently only tracks a monolithic budget, released, and a single deliverable. For long-running autonomous workflows, locking large budgets with all-or-nothing payout presents significant counterparty risk for both clients and provider agents." `
  -Implementation "1. Define Milestone struct with index, amount, description, deliverable, and approved status.`n2. Store milestones in persistent storage under DataKey::Milestones(job_id).`n3. Implement create_milestone_job, submit_milestone, approve_milestone, and cancel_uncompleted_milestones entry points.`n4. Update CommerceClient in sdk/src/commerce.ts." `
  -AcceptanceCriteria @(
    "Milestone struct and storage schema implemented in agentic-commerce.",
    "Invariant check: sum of milestone amounts must exactly equal total job budget.",
    "Evaluator approval transfers proportional funds and fee per milestone.",
    "Comprehensive unit tests in test.rs covering 3-milestone happy path and premature cancellation.",
    "TypeScript SDK typings and method signatures exported in sdk/src/types.ts."
  )

Add-Issue -Number 2 `
  -Title "feat(contracts): add multi-token whitelist and decimal normalization in agentic-commerce" `
  -Category "Smart Contracts" `
  -Labels "contracts,enhancement,Stellar Wave" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Stellar Asset Contract" `
  -Summary "Implement an approved asset whitelist and decimal normalization mechanism in contracts/agentic-commerce/src/lib.rs to safely support multiple Stellar Asset Contracts (USDC, EURC, XLM) beyond a single hardcoded token address." `
  -Motivation "In contracts/agentic-commerce/src/lib.rs:L75, any token Address can currently be passed to create_job(). Without a whitelist or asset validation, malicious callers can pass fake token contracts that mimic SAC interfaces to forge escrow balances, or use tokens with non-standard decimal precision causing calculation errors in fee_bps." `
  -Implementation "1. Introduce DataKey::AllowedTokens mapping and Admin entry points add_token(env, token: Address) and remove_token(env, token: Address).`n2. In create_job(), verify that env.storage().instance().has(&DataKey::AllowedToken(token.clone())), reverting with Error::UnsupportedToken if not whitelisted.`n3. Query the token's decimal precision via Soroban token client (env.invoke_contract) during registration and store normalization factor.`n4. Emit TokenWhitelisted and TokenRemoved contract events." `
  -AcceptanceCriteria @(
    "AllowedTokens storage mapping and admin management entry points implemented.",
    "create_job() panics with Error::UnsupportedToken when non-whitelisted token address is used.",
    "Decimal normalization handles 7-decimal Stellar assets and custom precision assets.",
    "Unit tests verify non-admin cannot modify token whitelist.",
    "SDK updated to export whitelisted token addresses."
  )

Add-Issue -Number 3 `
  -Title "feat(contracts): implement decentralized dispute arbitration with staking and slashing" `
  -Category "Smart Contracts" `
  -Labels "contracts,security,enhancement" `
  -Difficulty "Hard" `
  -Skills "Rust, Soroban, Cryptoeconomics" `
  -Summary "Create a decentralized arbitration mechanism in contracts/agentic-commerce/src/lib.rs where disputed jobs can be escalated to an elected arbitrator pool with economic stake at risk." `
  -Motivation "Currently in contracts/agentic-commerce/src/lib.rs:L62-L65, the Disputed status can only be resolved by the existing evaluator calling complete() or client calling cancel(). If the evaluator becomes unresponsive or compromised, disputed escrow funds remain locked indefinitely." `
  -Implementation "1. Define ArbitratorPool struct with required stake_amount and response_timeout.`n2. Add dispute_with_arbitration(env, caller, job_id, dispute_fee) entry point that locks dispute fee and assigns arbitrator.`n3. Implement resolve_dispute(env, arbitrator, job_id, client_pct, provider_pct) distributing escrowed funds according to arbitration ruling.`n4. Implement slash_arbitrator(env, admin, arbitrator) for proven malicious verdicts." `
  -AcceptanceCriteria @(
    "Arbitration entry points implemented with role-based auth checks.",
    "Escrow funds distributed according to arbitrator split percentage.",
    "Dispute timeout fallback allows mutual refund if arbitrator fails to rule within 7 days.",
    "Unit tests verify correct balance transfers to client, provider, and arbitrator fee.",
    "SDK CommerceClient updated with disputeWithArbitration() and resolveDispute()."
  )

Add-Issue -Number 4 `
  -Title "feat(contracts): add WebAuthn passkey and delegate key authorization in agent-identity" `
  -Category "Smart Contracts" `
  -Labels "contracts,security,Stellar Wave" `
  -Difficulty "Hard" `
  -Skills "Rust, Soroban, WebAuthn, Cryptography" `
  -Summary "Support Secp256r1 WebAuthn passkeys and ephemeral session delegates in contracts/agent-identity/src/lib.rs, enabling hardware-bound agent keys and time-limited signing delegates." `
  -Motivation "Currently in contracts/agent-identity/src/lib.rs:L128, owner.require_auth() strictly requires native Ed25519 wallet signatures. Autonomous AI agents running on cloud workers cannot safely store master private keys, requiring scoped session keys that can execute tasks without risking master wallet drain." `
  -Implementation "1. Implement Delegate struct with delegate_address, valid_until, and permissions bitmask.`n2. Add add_delegate(env, owner, delegate: Address, ttl: u64, permissions: u32) and revoke_delegate(env, owner, delegate: Address).`n3. Implement __check_auth hook verifying both native Ed25519 and Secp256r1 passkey signatures via env.crypto().secp256r1_verify.`n4. Emit DelegateGranted and DelegateRevoked contract events." `
  -AcceptanceCriteria @(
    "Delegates stored under DataKey::Delegates(agent_id, delegate_address).",
    "Time-bounded expiration enforced using env.ledger().timestamp().",
    "Secp256r1 passkey signature verification unit tests pass in Soroban test environment.",
    "Expired delegates fail authorization with Error::DelegateExpired.",
    "SDK IdentityClient updated to support session delegate signing."
  )

Add-Issue -Number 5 `
  -Title "perf(contracts): implement automated storage rent TTL extension and archive restoration policies" `
  -Category "Smart Contracts" `
  -Labels "contracts,performance,infrastructure" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Storage Rent" `
  -Summary "Establish proactive storage rent TTL management across contracts/agent-identity and contracts/agentic-commerce to prevent state eviction on high-volume Soroban ledgers." `
  -Motivation "In contracts/agent-identity/src/lib.rs:L9-L14, constant LEDGER_BUMP is set to 518,400 ledgers (~30 days). However, in agentic-commerce, several persistent storage keys (Job, Evaluators, Channels) do not consistently invoke env.storage().persistent().extend_ttl() upon read operations, creating risk of state archiving during inactive periods." `
  -Implementation "1. Create a shared helper extend_key_ttl(env: &Env, key: &DataKey, threshold: u32, bump: u32) across both crates.`n2. Apply proactive TTL extensions in get_job(), get_agent(), and voucher verification paths.`n3. Add restore_job_state(env, job_id) entry point permitting callers to bump archived jobs back into active storage.`n4. Add benchmarks measuring gas cost with and without TTL extensions." `
  -AcceptanceCriteria @(
    "All persistent storage keys extended upon state-changing and read operations.",
    "No storage eviction occurs during simulated 60-day test environment ledger advancement.",
    "Unit tests verify restore_job_state() successfully unarchives expired keys.",
    "Gas consumption benchmarks documented in contracts/README.md."
  )

Add-Issue -Number 6 `
  -Title "feat(contracts): implement atomic batch job creation and parallel escrow funding" `
  -Category "Smart Contracts" `
  -Labels "contracts,enhancement,Stellar Wave" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Optimization" `
  -Summary "Add batch_create_jobs entry point to contracts/agentic-commerce/src/lib.rs allowing agent orchestrators to escrow funds for multiple specialized worker agents in a single atomic transaction." `
  -Motivation "Autonomous agent workflows frequently dispatch tasks to a swarm of sub-agents (e.g. namer, researcher, copywriter). Currently, the client must submit N distinct create_job transactions, incurring N base fees, sequential ledger waits, and partial failure states where some jobs are funded while others fail." `
  -Implementation "1. Define JobRequest struct containing provider, evaluator, token, budget, and description.`n2. Add batch_create_jobs(env, client, requests: Vec<JobRequest>) -> Vec<u64>.`n3. Consolidate token transfers into a single bulk transfer per token contract where possible, or sequential atomic transfers that revert entirely on failure.`n4. Emit BatchJobsCreated event containing array of assigned job IDs." `
  -AcceptanceCriteria @(
    "batch_create_jobs accepts up to 10 jobs per invocation without exceeding CPU budget.",
    "Atomic rollback: if any single job creation fails (e.g. insufficient token allowance), the entire batch reverts.",
    "Single token transfer from client to escrow contract for the total aggregated budget.",
    "Unit tests in test.rs verify batch creation with 5 concurrent worker agents.",
    "CommerceClient.batchCreateJobs() implemented in SDK."
  )

Add-Issue -Number 7 `
  -Title "feat(contracts): add cooperative mutual closure for payment channels without dispute delay" `
  -Category "Smart Contracts" `
  -Labels "contracts,enhancement,sdk" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Payment Channels" `
  -Summary "Implement cooperative mutual closure in contracts/agentic-commerce/src/lib.rs for payment channels, allowing payer and provider to instantly settle and release funds when both signatures agree." `
  -Motivation "Currently in contracts/agentic-commerce/src/lib.rs:L113-L125 and L1040-L1090, closing a payment channel requires initiating close_channel followed by an on-chain dispute waiting window (closing_at) before funds can be withdrawn. In friendly API interactions where client and provider agree on final balances, waiting 24 hours creates unnecessary capital lockup." `
  -Implementation "1. Add mutual_close_channel(env, channel_id: u64, final_amount: i128, provider_sig: soroban_sdk::BytesN<64>) entry point.`n2. Verify payer authorization via payer.require_auth().`n3. Verify provider cryptographic signature over the tuple (channel_id, final_amount, 'MUTUAL_CLOSE').`n4. Immediately transfer final_amount to provider and (deposit - final_amount) back to payer, deleting the channel state.`n5. Emit ChannelMutuallyClosed event." `
  -AcceptanceCriteria @(
    "Channel settles instantly in the same ledger when both parties agree.",
    "Remaining deposit balance immediately refunded to payer wallet.",
    "Forged or invalid provider signatures are rejected with Error::InvalidSignature.",
    "Unit tests verify zero dispute period when mutual_close_channel is invoked.",
    "SDK paymentChannels.ts updated with mutualCloseChannel() method."
  )

Add-Issue -Number 8 `
  -Title "feat(contracts): implement dynamic tiered fee discounts based on historical agent volume" `
  -Category "Smart Contracts" `
  -Labels "contracts,enhancement" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Tokenomics" `
  -Summary "Introduce automated protocol fee discounts in contracts/agentic-commerce/src/lib.rs based on cumulative settled volume, incentivizing high-frequency agent commerce." `
  -Motivation "Currently, contracts/agentic-commerce/src/lib.rs:L142 uses a fixed DEFAULT_FEE_BPS = 100 (1%). High-volume institutional agents and liquidity routers are disincentivized from processing micropayments through the protocol due to flat fee structures that do not reward ecosystem loyalty." `
  -Implementation "1. Maintain DataKey::AgentVolume(Address) tracking total settled volume in USDC equivalent.`n2. Define fee tier thresholds: Base (100 bps), Silver (75 bps for >10,000 USDC), Gold (50 bps for >100,000 USDC), VIP (25 bps for >500,000 USDC).`n3. Calculate effective fee in complete() dynamically based on provider's cumulative volume tier.`n4. Update agent cumulative volume upon every successful complete()." `
  -AcceptanceCriteria @(
    "Volume tracker accurately accumulates settled job budgets per agent address.",
    "Dynamic fee calculation reduces treasury fee down to minimum 25 bps for top tier.",
    "Overflow-safe arithmetic using checked_add and checked_mul.",
    "Unit tests verify fee tier promotions and correct fee deductions across multiple jobs.",
    "SDK exports getAgentFeeTier(address) helper."
  )

Add-Issue -Number 9 `
  -Title "feat(contracts): add agent capability attestations and verifiable soulbound credentials" `
  -Category "Smart Contracts" `
  -Labels "contracts,compliance,Stellar Wave" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, ERC-8004" `
  -Summary "Add on-chain capability badges and verifiable credentials in contracts/agent-identity/src/lib.rs to certify agent specializations (e.g., Code Auditing, Translation, Market Making)." `
  -Motivation "In contracts/agent-identity/src/lib.rs:L23-L30, Agent only contains id, owner, and uri. Clients have no cryptographic assurance regarding an agent's verified capabilities, security clearance, or benchmark scores without crawling third-party IPFS links that can change at any time." `
  -Implementation "1. Introduce Badge struct with issuer: Address, tag: Symbol, score: u32, issued_at: u64, expires_at: u64.`n2. Store badges under DataKey::Badges(agent_id, tag).`n3. Add issue_badge(env, issuer, agent_id: u64, tag: Symbol, score: u32, ttl: u64) requiring issuer.require_auth().`n4. Add revoke_badge(env, issuer, agent_id: u64, tag: Symbol) allowing issuers to revoke expired or invalid badges." `
  -AcceptanceCriteria @(
    "Badges can only be minted by authorized issuer addresses.",
    "get_badges(agent_id) returns active, non-expired credentials.",
    "Deregistering an agent properly handles or archives associated badges.",
    "Unit tests in agent-identity test.rs cover badge issuance, verification, and expiration.",
    "Dashboard displays verified capability badges on agent profile cards."
  )

Add-Issue -Number 10 `
  -Title "sec(contracts): implement reentrancy and cross-contract re-call protection hooks" `
  -Category "Smart Contracts" `
  -Labels "contracts,security" `
  -Difficulty "Hard" `
  -Skills "Rust, Soroban, Security" `
  -Summary "Incorporate formal reentrancy guards and state check-effects-interactions patterns across all escrow release and refund paths in contracts/agentic-commerce/src/lib.rs." `
  -Motivation "While Soroban prevents classical EVM reentrancy in some contexts, cross-contract token callbacks and custom token contracts can trigger unexpected re-invocations during TokenClient::transfer calls in complete() and cancel(), potentially altering job states before completion finishes." `
  -Implementation "1. Implement a ReentrancyGuard utility using temporary storage (DataKey::ReentrancyLock).`n2. Enforce strict Checks-Effects-Interactions pattern: update job.status = JobStatus::Completed and persist state BEFORE initiating token transfers to provider and treasury.`n3. Revert with Error::ReentrancyDetected if lock is active.`n4. Add fuzzing tests attempting recursive entry point invocations." `
  -AcceptanceCriteria @(
    "Job state transitions committed before any cross-contract token invocation.",
    "Reentrancy lock properly set and cleaned up in complete(), cancel(), and mutual_close().",
    "Simulated malicious token contract attempting reentrant call is rejected.",
    "Unit tests verify zero gas leaks or state corruption under reentrant simulation."
  )

Write-Host "Initialized builder script."
