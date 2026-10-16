# PowerShell script to define and generate all 100 high-quality issues for Stellar-agent
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceDir = Resolve-Path (Join-Path $scriptDir "..")
$issuesJsonPath = Join-Path $workspaceDir "issues_data.json"
$issuesMdPath = Join-Path $workspaceDir "ISSUES.md"

$allIssues = [System.Collections.Generic.List[PSCustomObject]]::new()

function Register-Issue {
    param(
        [int]$Id,
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

    $criteriaMd = ($AcceptanceCriteria | ForEach-Object { "- [ ] $_" }) -join "`r`n"

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

    $issueObj = [PSCustomObject]@{
        id = $Id
        title = $Title
        category = $Category
        labels = $Labels
        difficulty = $Difficulty
        skills = $Skills
        summary = $Summary
        motivation = $Motivation
        implementation = $Implementation
        criteria = $AcceptanceCriteria
        body = $body
    }

    $allIssues.Add($issueObj)
}

Write-Host "Registering Category 1: Smart Contracts (Issues 1-25)..."

Register-Issue -Id 1 `
  -Title "feat(contracts): implement milestone-based progressive escrow releases in agentic-commerce" `
  -Category "Smart Contracts" `
  -Labels "contracts,enhancement,Stellar Wave" `
  -Difficulty "Hard" `
  -Skills "Rust, Soroban, TypeScript" `
  -Summary "Extend the agentic-commerce contract (contracts/agentic-commerce/src/lib.rs) to support multi-stage milestone releases for high-value agent jobs, allowing clients to fund a total budget split across sequential deliverables with independent verification." `
  -Motivation "In contracts/agentic-commerce/src/lib.rs:L70-L90, the Job struct currently only tracks a monolithic budget, released, and a single deliverable. For long-running autonomous workflows, locking large budgets with all-or-nothing payout presents significant counterparty risk for both clients and provider agents." `
  -Implementation "1. Define Milestone struct with index, amount, description, deliverable, and approved status.`r`n2. Store milestones in persistent storage under DataKey::Milestones(job_id).`r`n3. Implement create_milestone_job, submit_milestone, approve_milestone, and cancel_uncompleted_milestones entry points.`r`n4. Update CommerceClient in sdk/src/commerce.ts." `
  -AcceptanceCriteria @(
    "Milestone struct and storage schema implemented in agentic-commerce.",
    "Invariant check: sum of milestone amounts must exactly equal total job budget.",
    "Evaluator approval transfers proportional funds and fee per milestone.",
    "Comprehensive unit tests in test.rs covering 3-milestone happy path and premature cancellation.",
    "TypeScript SDK typings and method signatures exported in sdk/src/types.ts."
  )

Register-Issue -Id 2 `
  -Title "feat(contracts): add multi-token whitelist and decimal normalization in agentic-commerce" `
  -Category "Smart Contracts" `
  -Labels "contracts,enhancement,Stellar Wave" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Stellar Asset Contract" `
  -Summary "Implement an approved asset whitelist and decimal normalization mechanism in contracts/agentic-commerce/src/lib.rs to safely support multiple Stellar Asset Contracts (USDC, EURC, XLM) beyond a single hardcoded token address." `
  -Motivation "In contracts/agentic-commerce/src/lib.rs:L75, any token Address can currently be passed to create_job(). Without a whitelist or asset validation, malicious callers can pass fake token contracts that mimic SAC interfaces to forge escrow balances, or use tokens with non-standard decimal precision causing calculation errors in fee_bps." `
  -Implementation "1. Introduce DataKey::AllowedTokens mapping and Admin entry points add_token(env, token: Address) and remove_token(env, token: Address).`r`n2. In create_job(), verify that env.storage().instance().has(&DataKey::AllowedToken(token.clone())), reverting with Error::UnsupportedToken if not whitelisted.`r`n3. Query token decimal precision via Soroban token client during registration and store normalization factor.`r`n4. Emit TokenWhitelisted and TokenRemoved contract events." `
  -AcceptanceCriteria @(
    "AllowedTokens storage mapping and admin management entry points implemented.",
    "create_job() panics with Error::UnsupportedToken when non-whitelisted token address is used.",
    "Decimal normalization handles 7-decimal Stellar assets and custom precision assets.",
    "Unit tests verify non-admin cannot modify token whitelist.",
    "SDK updated to export whitelisted token addresses."
  )

Register-Issue -Id 3 `
  -Title "feat(contracts): implement decentralized dispute arbitration with staking and slashing" `
  -Category "Smart Contracts" `
  -Labels "contracts,security,enhancement" `
  -Difficulty "Hard" `
  -Skills "Rust, Soroban, Cryptoeconomics" `
  -Summary "Create a decentralized arbitration mechanism in contracts/agentic-commerce/src/lib.rs where disputed jobs can be escalated to an elected arbitrator pool with economic stake at risk." `
  -Motivation "Currently in contracts/agentic-commerce/src/lib.rs:L62-L65, the Disputed status can only be resolved by the existing evaluator calling complete() or client calling cancel(). If the evaluator becomes unresponsive or compromised, disputed escrow funds remain locked indefinitely." `
  -Implementation "1. Define ArbitratorPool struct with required stake_amount and response_timeout.`r`n2. Add dispute_with_arbitration(env, caller, job_id, dispute_fee) entry point that locks dispute fee and assigns arbitrator.`r`n3. Implement resolve_dispute(env, arbitrator, job_id, client_pct, provider_pct) distributing escrowed funds according to arbitration ruling.`r`n4. Implement slash_arbitrator(env, admin, arbitrator) for proven malicious verdicts." `
  -AcceptanceCriteria @(
    "Arbitration entry points implemented with role-based auth checks.",
    "Escrow funds distributed according to arbitrator split percentage.",
    "Dispute timeout fallback allows mutual refund if arbitrator fails to rule within 7 days.",
    "Unit tests verify correct balance transfers to client, provider, and arbitrator fee.",
    "SDK CommerceClient updated with disputeWithArbitration() and resolveDispute()."
  )

Register-Issue -Id 4 `
  -Title "feat(contracts): add WebAuthn passkey and delegate key authorization in agent-identity" `
  -Category "Smart Contracts" `
  -Labels "contracts,security,Stellar Wave" `
  -Difficulty "Hard" `
  -Skills "Rust, Soroban, WebAuthn, Cryptography" `
  -Summary "Support Secp256r1 WebAuthn passkeys and ephemeral session delegates in contracts/agent-identity/src/lib.rs, enabling hardware-bound agent keys and time-limited signing delegates." `
  -Motivation "Currently in contracts/agent-identity/src/lib.rs:L128, owner.require_auth() strictly requires native Ed25519 wallet signatures. Autonomous AI agents running on cloud workers cannot safely store master private keys, requiring scoped session keys that can execute tasks without risking master wallet drain." `
  -Implementation "1. Implement Delegate struct with delegate_address, valid_until, and permissions bitmask.`r`n2. Add add_delegate(env, owner, delegate: Address, ttl: u64, permissions: u32) and revoke_delegate(env, owner, delegate: Address).`r`n3. Implement __check_auth hook verifying both native Ed25519 and Secp256r1 passkey signatures via env.crypto().secp256r1_verify.`r`n4. Emit DelegateGranted and DelegateRevoked contract events." `
  -AcceptanceCriteria @(
    "Delegates stored under DataKey::Delegates(agent_id, delegate_address).",
    "Time-bounded expiration enforced using env.ledger().timestamp().",
    "Secp256r1 passkey signature verification unit tests pass in Soroban test environment.",
    "Expired delegates fail authorization with Error::DelegateExpired.",
    "SDK IdentityClient updated to support session delegate signing."
  )

Register-Issue -Id 5 `
  -Title "perf(contracts): implement automated storage rent TTL extension and archive restoration policies" `
  -Category "Smart Contracts" `
  -Labels "contracts,performance,infrastructure" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Storage Rent" `
  -Summary "Establish proactive storage rent TTL management across contracts/agent-identity and contracts/agentic-commerce to prevent state eviction on high-volume Soroban ledgers." `
  -Motivation "In contracts/agent-identity/src/lib.rs:L9-L14, constant LEDGER_BUMP is set to 518,400 ledgers (~30 days). However, in agentic-commerce, several persistent storage keys (Job, Evaluators, Channels) do not consistently invoke env.storage().persistent().extend_ttl() upon read operations, creating risk of state archiving during inactive periods." `
  -Implementation "1. Create a shared helper extend_key_ttl(env: &Env, key: &DataKey, threshold: u32, bump: u32) across both crates.`r`n2. Apply proactive TTL extensions in get_job(), get_agent(), and voucher verification paths.`r`n3. Add restore_job_state(env, job_id) entry point permitting callers to bump archived jobs back into active storage.`r`n4. Add benchmarks measuring gas cost with and without TTL extensions." `
  -AcceptanceCriteria @(
    "All persistent storage keys extended upon state-changing and read operations.",
    "No storage eviction occurs during simulated 60-day test environment ledger advancement.",
    "Unit tests verify restore_job_state() successfully unarchives expired keys.",
    "Gas consumption benchmarks documented in contracts/README.md."
  )

Register-Issue -Id 6 `
  -Title "feat(contracts): implement atomic batch job creation and parallel escrow funding" `
  -Category "Smart Contracts" `
  -Labels "contracts,enhancement,Stellar Wave" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Optimization" `
  -Summary "Add batch_create_jobs entry point to contracts/agentic-commerce/src/lib.rs allowing agent orchestrators to escrow funds for multiple specialized worker agents in a single atomic transaction." `
  -Motivation "Autonomous agent workflows frequently dispatch tasks to a swarm of sub-agents (e.g. namer, researcher, copywriter). Currently, the client must submit N distinct create_job transactions, incurring N base fees, sequential ledger waits, and partial failure states where some jobs are funded while others fail." `
  -Implementation "1. Define JobRequest struct containing provider, evaluator, token, budget, and description.`r`n2. Add batch_create_jobs(env, client, requests: Vec<JobRequest>) -> Vec<u64>.`r`n3. Consolidate token transfers into a single bulk transfer per token contract where possible, or sequential atomic transfers that revert entirely on failure.`r`n4. Emit BatchJobsCreated event containing array of assigned job IDs." `
  -AcceptanceCriteria @(
    "batch_create_jobs accepts up to 10 jobs per invocation without exceeding CPU budget.",
    "Atomic rollback: if any single job creation fails (e.g. insufficient token allowance), the entire batch reverts.",
    "Single token transfer from client to escrow contract for the total aggregated budget.",
    "Unit tests in test.rs verify batch creation with 5 concurrent worker agents.",
    "CommerceClient.batchCreateJobs() implemented in SDK."
  )

Register-Issue -Id 7 `
  -Title "feat(contracts): add cooperative mutual closure for payment channels without dispute delay" `
  -Category "Smart Contracts" `
  -Labels "contracts,enhancement,sdk" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Payment Channels" `
  -Summary "Implement cooperative mutual closure in contracts/agentic-commerce/src/lib.rs for payment channels, allowing payer and provider to instantly settle and release funds when both signatures agree." `
  -Motivation "Currently in contracts/agentic-commerce/src/lib.rs:L113-L125 and L1040-L1090, closing a payment channel requires initiating close_channel followed by an on-chain dispute waiting window (closing_at) before funds can be withdrawn. In friendly API interactions where client and provider agree on final balances, waiting 24 hours creates unnecessary capital lockup." `
  -Implementation "1. Add mutual_close_channel(env, channel_id: u64, final_amount: i128, provider_sig: soroban_sdk::BytesN<64>) entry point.`r`n2. Verify payer authorization via payer.require_auth().`r`n3. Verify provider cryptographic signature over the tuple (channel_id, final_amount, 'MUTUAL_CLOSE').`r`n4. Immediately transfer final_amount to provider and (deposit - final_amount) back to payer, deleting the channel state.`r`n5. Emit ChannelMutuallyClosed event." `
  -AcceptanceCriteria @(
    "Channel settles instantly in the same ledger when both parties agree.",
    "Remaining deposit balance immediately refunded to payer wallet.",
    "Forged or invalid provider signatures are rejected with Error::InvalidSignature.",
    "Unit tests verify zero dispute period when mutual_close_channel is invoked.",
    "SDK paymentChannels.ts updated with mutualCloseChannel() method."
  )

Register-Issue -Id 8 `
  -Title "feat(contracts): implement dynamic tiered fee discounts based on historical agent volume" `
  -Category "Smart Contracts" `
  -Labels "contracts,enhancement" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Tokenomics" `
  -Summary "Introduce automated protocol fee discounts in contracts/agentic-commerce/src/lib.rs based on cumulative settled volume, incentivizing high-frequency agent commerce." `
  -Motivation "Currently, contracts/agentic-commerce/src/lib.rs:L142 uses a fixed DEFAULT_FEE_BPS = 100 (1%). High-volume institutional agents and liquidity routers are disincentivized from processing micropayments through the protocol due to flat fee structures that do not reward ecosystem loyalty." `
  -Implementation "1. Maintain DataKey::AgentVolume(Address) tracking total settled volume in USDC equivalent.`r`n2. Define fee tier thresholds: Base (100 bps), Silver (75 bps for >10,000 USDC), Gold (50 bps for >100,000 USDC), VIP (25 bps for >500,000 USDC).`r`n3. Calculate effective fee in complete() dynamically based on provider's cumulative volume tier.`r`n4. Update agent cumulative volume upon every successful complete()." `
  -AcceptanceCriteria @(
    "Volume tracker accurately accumulates settled job budgets per agent address.",
    "Dynamic fee calculation reduces treasury fee down to minimum 25 bps for top tier.",
    "Overflow-safe arithmetic using checked_add and checked_mul.",
    "Unit tests verify fee tier promotions and correct fee deductions across multiple jobs.",
    "SDK exports getAgentFeeTier(address) helper."
  )

Register-Issue -Id 9 `
  -Title "feat(contracts): add agent capability attestations and verifiable soulbound credentials" `
  -Category "Smart Contracts" `
  -Labels "contracts,compliance,Stellar Wave" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, ERC-8004" `
  -Summary "Add on-chain capability badges and verifiable credentials in contracts/agent-identity/src/lib.rs to certify agent specializations (e.g., Code Auditing, Translation, Market Making)." `
  -Motivation "In contracts/agent-identity/src/lib.rs:L23-L30, Agent only contains id, owner, and uri. Clients have no cryptographic assurance regarding an agent's verified capabilities, security clearance, or benchmark scores without crawling third-party IPFS links that can change at any time." `
  -Implementation "1. Introduce Badge struct with issuer: Address, tag: Symbol, score: u32, issued_at: u64, expires_at: u64.`r`n2. Store badges under DataKey::Badges(agent_id, tag).`r`n3. Add issue_badge(env, issuer, agent_id: u64, tag: Symbol, score: u32, ttl: u64) requiring issuer.require_auth().`r`n4. Add revoke_badge(env, issuer, agent_id: u64, tag: Symbol) allowing issuers to revoke expired or invalid badges." `
  -AcceptanceCriteria @(
    "Badges can only be minted by authorized issuer addresses.",
    "get_badges(agent_id) returns active, non-expired credentials.",
    "Deregistering an agent properly handles or archives associated badges.",
    "Unit tests in agent-identity test.rs cover badge issuance, verification, and expiration.",
    "Dashboard displays verified capability badges on agent profile cards."
  )

Register-Issue -Id 10 `
  -Title "sec(contracts): implement reentrancy and cross-contract re-call protection hooks" `
  -Category "Smart Contracts" `
  -Labels "contracts,security" `
  -Difficulty "Hard" `
  -Skills "Rust, Soroban, Security" `
  -Summary "Incorporate formal reentrancy guards and state check-effects-interactions patterns across all escrow release and refund paths in contracts/agentic-commerce/src/lib.rs." `
  -Motivation "While Soroban prevents classical EVM reentrancy in some contexts, cross-contract token callbacks and custom token contracts can trigger unexpected re-invocations during TokenClient::transfer calls in complete() and cancel(), potentially altering job states before completion finishes." `
  -Implementation "1. Implement a ReentrancyGuard utility using temporary storage (DataKey::ReentrancyLock).`r`n2. Enforce strict Checks-Effects-Interactions pattern: update job.status = JobStatus::Completed and persist state BEFORE initiating token transfers to provider and treasury.`r`n3. Revert with Error::ReentrancyDetected if lock is active.`r`n4. Add fuzzing tests attempting recursive entry point invocations." `
  -AcceptanceCriteria @(
    "Job state transitions committed before any cross-contract token invocation.",
    "Reentrancy lock properly set and cleaned up in complete(), cancel(), and mutual_close().",
    "Simulated malicious token contract attempting reentrant call is rejected.",
    "Unit tests verify zero gas leaks or state corruption under reentrant simulation."
  )

Register-Issue -Id 11 `
  -Title "feat(contracts): add rate-limiting job creation guard to prevent state storage griefing" `
  -Category "Smart Contracts" `
  -Labels "contracts,security,infrastructure" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Gas Optimization" `
  -Summary "Implement an on-chain sliding window rate limiter in contracts/agentic-commerce/src/lib.rs to limit maximum job creation frequency per client account." `
  -Motivation "Currently in contracts/agentic-commerce/src/lib.rs:L147, MIN_BUDGET is set to 1. A malicious account can flood the contract with thousands of dust jobs (1 stroop each), polluting contract instance storage, degrading indexer throughput, and exhausting node cache memory." `
  -Implementation "1. Store DataKey::ClientRate(Address) containing last_ledger: u32 and count: u32 in temporary storage.`r`n2. In create_job(), verify that the client has not exceeded MAX_JOBS_PER_WINDOW (e.g., 20 jobs per 100 ledgers).`r`n3. Revert with Error::RateLimitExceeded if threshold is violated.`r`n4. Provide admin entry point set_rate_limit(window: u32, max_calls: u32)." `
  -AcceptanceCriteria @(
    "Temporary storage rate limit counters expire automatically without state bloat.",
    "Legitimate users under the threshold experience negligible gas overhead (<2,000 instructions).",
    "Spam script attempting 50 rapid job creations is throttled after 20.",
    "Unit tests verify rate window reset after ledger advancement."
  )

Register-Issue -Id 12 `
  -Title "feat(contracts): implement weighted voting threshold for multi-evaluator quorums" `
  -Category "Smart Contracts" `
  -Labels "contracts,enhancement,Stellar Wave" `
  -Difficulty "Hard" `
  -Skills "Rust, Soroban, Governance" `
  -Summary "Enhance JobEvaluators in contracts/agentic-commerce/src/lib.rs:L95 to support distinct evaluator weights rather than a simple 1-evaluator-1-vote quorum." `
  -Motivation "In enterprise and DAO workflows, evaluators have differing seniority (e.g. Lead Auditor weight 3, QA Engineer weight 1). The current JobEvaluators implementation treats all evaluators equally with a raw count threshold, precluding weighted consensus models." `
  -Implementation "1. Update JobEvaluators struct to include soroban_sdk::Map<Address, u32> evaluator_weights and total_weight: u32.`r`n2. In approve_job(), sum the weights of approving evaluators and compare against required weight_threshold.`r`n3. Ensure duplicate approvals from the same evaluator cannot double-count weight.`r`n4. Update complete() trigger condition to require accumulated weight >= threshold." `
  -AcceptanceCriteria @(
    "Weights validated at job creation: sum of weights >= weight_threshold.",
    "Approval tracking prevents double voting by recording Address in approvals map.",
    "Job automatically executes completion and payout when weighted threshold is reached.",
    "Comprehensive test coverage for 3-party weighted voting scenarios in test.rs."
  )

Register-Issue -Id 13 `
  -Title "feat(contracts): introduce agent lifecycle state machine with suspended and slashed flags" `
  -Category "Smart Contracts" `
  -Labels "contracts,compliance,enhancement" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, State Machines" `
  -Summary "Expand Agent struct in contracts/agent-identity/src/lib.rs with an explicit AgentStatus enum (Active, Paused, Suspended, Slashed) and administrative governance controls." `
  -Motivation "Currently in contracts/agent-identity/src/lib.rs:L25-L30, an agent is either registered or completely deleted (deregistered). There is no mechanism for an agent owner to temporarily pause intake during maintenance, or for governance to suspend a compromised agent without erasing its audit history." `
  -Implementation "1. Define AgentStatus enum: Active = 0, Paused = 1, Suspended = 2, Slashed = 3.`r`n2. Add status: AgentStatus field to Agent struct (preserving backward compatible XDR serialization).`r`n3. Add pause_agent(env, owner, agent_id) and unpause_agent(env, owner, agent_id).`r`n4. Add admin entry point suspend_agent(env, admin, agent_id, reason).`r`n5. Check status in agentic-commerce before allowing job creation assigned to provider." `
  -AcceptanceCriteria @(
    "Agent status correctly initialized to Active on registration.",
    "Paused agents cannot be selected as providers in create_job().",
    "Only contract admin can suspend or slash an agent.",
    "Unit tests verify state transitions and unauthorized call rejections."
  )

Register-Issue -Id 14 `
  -Title "feat(contracts): add SHA-256 deliverable payload content hash verification" `
  -Category "Smart Contracts" `
  -Labels "contracts,security,Stellar Wave" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Cryptography" `
  -Summary "Add cryptographic content hash commitments to submit() and complete() in contracts/agentic-commerce/src/lib.rs, guaranteeing that submitted deliverables cannot be mutated off-chain after approval." `
  -Motivation "In contracts/agentic-commerce/src/lib.rs:L83, deliverable is merely an arbitrary URI String (e.g. https://... or ipfs://...). If an agent points to a dynamic HTTP URL or mutable IPFS folder, the provider can swap the deliverable content after receiving client payment." `
  -Implementation "1. Add deliverable_hash: BytesN<32> parameter to submit().`r`n2. Store deliverable_hash in Job struct or dedicated storage key.`r`n3. In complete(), allow evaluator to optionally verify and attest that the evaluated content matches deliverable_hash.`r`n4. Emit JobSubmitted event with deliverable_hash topic for indexer integrity verification." `
  -AcceptanceCriteria @(
    "submit() requires a valid 32-byte SHA-256 content hash.",
    "Stored content hash is immutable once submitted.",
    "Evaluator complete() rejects mismatched content hash assertions.",
    "SDK updated to compute SHA-256 hash of deliverable buffer automatically before submitting."
  )

Register-Issue -Id 15 `
  -Title "sec(contracts): implement timelock controller for contract fee changes and WASM upgrades" `
  -Category "Smart Contracts" `
  -Labels "contracts,security,governance" `
  -Difficulty "Hard" `
  -Skills "Rust, Soroban, Governance" `
  -Summary "Implement a minimum 48-hour timelock queue for critical admin actions (set_fee_bps, set_treasury, upgrade) in contracts/agentic-commerce and contracts/agent-identity." `
  -Motivation "Currently in contracts/agentic-commerce/src/lib.rs:L870-L910, admin can instantly change fees (set_fee_bps) or redirect all treasury revenue (set_treasury) in a single transaction. In agent-identity (L105), admin can instantly upgrade the WASM hash. If admin keys are compromised, the entire protocol can be rug-pulled without warning." `
  -Implementation "1. Create TimelockAction struct with action_type, payload_hash, scheduled_at, and execution_deadline.`r`n2. Add schedule_action(env, admin, action_type, payload_hash, delay) requiring delay >= 172,800 seconds (48h).`r`n3. Add execute_action(env, admin, action_id) that validates elapsed ledger timestamp before applying upgrade or fee modification.`r`n4. Add cancel_scheduled_action(env, admin, action_id) to abort malicious proposals." `
  -AcceptanceCriteria @(
    "Instant admin fee updates or WASM upgrades are strictly prevented.",
    "Execution fails if attempted prior to timelock expiration.",
    "Proposal queue visible on-chain for ecosystem monitoring and alerting.",
    "Comprehensive unit tests verify scheduling, time verification, and cancellation."
  )

Register-Issue -Id 16 `
  -Title "perf(contracts): optimize contract storage layout using compact enum representations" `
  -Category "Smart Contracts" `
  -Labels "contracts,performance,refactor" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, XDR Optimization" `
  -Summary "Refactor storage keys and struct field representations across both Soroban contracts to minimize XDR byte size, reducing ledger rent and transaction fee costs." `
  -Motivation "Soroban charges transaction fees and storage rent proportional to serialized XDR byte length. Currently, several DataKey variants use verbose wrappers and full 32-byte strings where compact u32 or single-byte discriminants would save ~35% on read/write ledger costs." `
  -Implementation "1. Audit DataKey in agent-identity and agentic-commerce for padding and redundant fields.`r`n2. Pack Boolean flags and small integers into bitflags where appropriate.`r`n3. Measure and document XDR byte reductions across all key types.`r`n4. Verify zero breakage to existing deployed contract state using migration deserializers." `
  -AcceptanceCriteria @(
    "Serialized XDR size reduced by at least 20% on hot storage keys.",
    "All unit tests pass without breaking changes to public ABI.",
    "Gas benchmarking script confirms reduction in CPU/memory resource consumption."
  )

Register-Issue -Id 17 `
  -Title "test(contracts): add property-based invariant testing suite using proptest" `
  -Category "Smart Contracts" `
  -Labels "contracts,testing,security" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Property Testing" `
  -Summary "Introduce proptest property-based fuzz testing in contracts/agentic-commerce/src/test.rs to formally prove economic invariants across arbitrary sequences of job operations." `
  -Motivation "Unit tests currently test discrete happy and sad paths. However, complex multi-step sequences (e.g. create -> fund -> submit -> dispute -> partial refund -> expire) with extreme budget values or odd fee configurations could violate core conservation-of-value invariants." `
  -Implementation "1. Add proptest dev-dependency to contracts/agentic-commerce/Cargo.toml.`r`n2. Define system invariants: `sum(payouts) + sum(fees) + contract_balance == total_deposited_budgets`.`r`n3. Generate arbitrary sequences of create_job, submit, complete, cancel, and dispute operations.`r`n4. Assert invariant holds after every generated transaction sequence." `
  -AcceptanceCriteria @(
    "proptest runs at least 1,000 randomized state-machine iterations in CI.",
    "Zero token leaks: contract balance never diverges from expected escrowed funds.",
    "No arithmetic underflows or overflows possible with valid i128 inputs.",
    "Property tests integrated into `cargo test` command."
  )

Register-Issue -Id 18 `
  -Title "perf(contracts): optimize WASM binary footprint with dead code elimination and LTO" `
  -Category "Smart Contracts" `
  -Labels "contracts,performance,devops" `
  -Difficulty "Medium" `
  -Skills "Rust, WASM, Cargo, Optimization" `
  -Summary "Tune Cargo compiler flags and strip unused formatting dependencies to reduce compiled WASM binary sizes below 8 KB for agentic-commerce and 3.5 KB for agent-identity." `
  -Motivation "Deploying WASM to Soroban charges network fees proportional to binary size, and larger binaries take longer to load and verify during VM invocation. agentic_commerce.wasm is currently ~9.4 KB." `
  -Implementation "1. Enable Link-Time Optimization (lto = 'fat'), codegen-units = 1, and opt-level = 'z' in root Cargo.toml [profile.release].`r`n2. Replace any remaining panic string allocations with contracterror enum codes.`r`n3. Run wasm-opt -Oz and measure binary reduction.`r`n4. Update scripts/build.sh with automated size regression checks." `
  -AcceptanceCriteria @(
    "agentic_commerce.wasm binary size reduced by at least 15%.",
    "All contract entry points remain fully functional and ABI export verified.",
    "CI pipeline fails if compiled WASM exceeds 12 KB limit."
  )

Register-Issue -Id 19 `
  -Title "refactor(contracts): standardize contract event schema versioning and backward compatibility" `
  -Category "Smart Contracts" `
  -Labels "contracts,refactor,compliance" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Architecture" `
  -Summary "Standardize all contract event definitions using versioned struct tags to ensure indexers can seamlessly handle schema updates without dropping historical events." `
  -Motivation "In contracts/agentic-commerce/src/lib.rs, events like JobCreated and JobCompleted are emitted via #[contractevent]. If fields are added or modified in future protocol iterations, indexers parsing historical ledgers will encounter deserialization errors without explicit event versioning." `
  -Implementation "1. Add version: u32 field to all #[contractevent] structs.`r`n2. Define canonical topic hierarchy: [ContractSymbol, EventName, Version, ActorAddress].`r`n3. Document event schema registry in docs/EVENTS.md.`r`n4. Update indexer/src/poller.ts to parse versioned event topics." `
  -AcceptanceCriteria @(
    "All contract events emit standardized versioned topic headers.",
    "docs/EVENTS.md updated with complete JSON schema specifications.",
    "Indexer gracefully parses both v1 legacy events and v2 versioned events."
  )

Register-Issue -Id 20 `
  -Title "feat(contracts): implement on-chain protocol treasury staking and revenue distribution" `
  -Category "Smart Contracts" `
  -Labels "contracts,enhancement,Tokenomics" `
  -Difficulty "Hard" `
  -Skills "Rust, Soroban, Tokenomics" `
  -Summary "Create a treasury revenue-sharing module in contracts/agentic-commerce/src/lib.rs allowing protocol fee dividends to be distributed to active agent stakers." `
  -Motivation "Currently in contracts/agentic-commerce/src/lib.rs:L560, the 1% protocol fee is transferred directly to a single static treasury address. To align incentives and build a self-sustaining agent economy, protocol revenue should be programmatically apportioned between development reserve, agent staking yield, and ecosystem grants." `
  -Implementation "1. Define TreasurySplit struct: dev_pool_bps, staking_pool_bps, grant_pool_bps (summing to 10,000).`r`n2. Add stake_tokens(env, staker, amount) and unstake_tokens(env, staker, amount).`r`n3. In complete(), split the collected fee according to TreasurySplit allocations.`r`n4. Implement claim_staking_rewards(env, staker) allowing stakers to harvest their share of protocol fees." `
  -AcceptanceCriteria @(
    "Protocol fees automatically divided according to governance allocation percentages.",
    "Stakers earn proportional yield based on stake weight and duration.",
    "Zero fee leakage or precision loss in integer division.",
    "Unit tests verify staking, rewards accumulation, and withdrawal flows."
  )

Register-Issue -Id 21 `
  -Title "feat(contracts): add cross-currency escrow settlements via Stellar Path Payments" `
  -Category "Smart Contracts" `
  -Labels "contracts,enhancement,Stellar Wave" `
  -Difficulty "Hard" `
  -Skills "Rust, Soroban, Stellar DEX" `
  -Summary "Support cross-currency settlement in agentic-commerce allowing clients to fund jobs in XLM/EURC while provider agents receive guaranteed USDC upon completion." `
  -Motivation "Agents operate globally and prefer diverse settlement currencies. Requiring all clients to acquire USDC prior to job creation introduces friction. Integrating Stellar DEX path payment routing allows seamless cross-asset conversion at escrow deposit time." `
  -Implementation "1. Interface with Stellar DEX or Soroban AMM pool contracts.`r`n2. Add fund_job_with_swap(env, client, input_token, max_input_amount, job_id) entry point.`r`n3. Execute atomic swap into target job token and lock exact budget into escrow.`r`n4. Refund any unspent slippage remainder back to client wallet." `
  -AcceptanceCriteria @(
    "Client can fund a USDC escrow using XLM in a single transaction.",
    "Max input amount guard protects client from adverse market slippage.",
    "Escrow accurately receives the full required target budget.",
    "Unit tests mock AMM swap and verify balance distributions."
  )

Register-Issue -Id 22 `
  -Title "feat(contracts): support partial mutual refunds on negotiated job cancellations" `
  -Category "Smart Contracts" `
  -Labels "contracts,enhancement" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Commerce" `
  -Summary "Enable negotiated mutual cancellation in contracts/agentic-commerce/src/lib.rs where client and provider agree to split escrowed funds (e.g. 50/50) when a job is partially delivered." `
  -Motivation "Currently in contracts/agentic-commerce/src/lib.rs:L600-L640, cancel() is strictly all-or-nothing (100% refund to client), and can only be invoked while status is Funded (not Submitted). If work was partially done, there is no on-chain mechanism for client and provider to agree on a partial compensation split." `
  -Implementation "1. Add mutual_cancel(env, client_refund: i128, provider_payout: i128, job_id: u64, provider_sig: BytesN<64>).`r`n2. Require client authorization and verify provider cryptographic signature approving the exact split amounts.`r`n3. Verify invariant: client_refund + provider_payout == job.budget - job.released.`r`n4. Transfer funds accordingly and mark job status Cancelled.`r`n5. Emit JobMutuallyCancelled event." `
  -AcceptanceCriteria @(
    "Both parties must cryptographically sign off on the exact split amounts.",
    "Funds instantly disbursed without waiting for evaluator action.",
    "State updated to Cancelled to prevent replay or subsequent submission.",
    "Unit tests verify correct balance transfers and signature validation."
  )

Register-Issue -Id 23 `
  -Title "sec(contracts): implement granular emergency pause flags for contract entry points" `
  -Category "Smart Contracts" `
  -Labels "contracts,security" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Security" `
  -Summary "Replace binary contract pause flag with granular feature pause bits (PAUSE_CREATE, PAUSE_PAYOUT, PAUSE_CHANNEL) in contracts/agentic-commerce/src/lib.rs." `
  -Motivation "In contracts/agentic-commerce/src/lib.rs:L135, DataKey::Paused is a monolithic boolean. If an exploit is identified in payment channels, the admin must pause the entire contract, halting all normal job escrows and hurting unrelated users." `
  -Implementation "1. Replace DataKey::Paused with DataKey::PauseFlags(u32).`r`n2. Define bitmasks: PAUSE_CREATE_JOB = 1 << 0, PAUSE_SUBMIT = 1 << 1, PAUSE_COMPLETE = 1 << 2, PAUSE_CHANNELS = 1 << 3.`r`n3. Add set_pause_flags(env, admin, flags: u32).`r`n4. Apply granular check in each affected entry point." `
  -AcceptanceCriteria @(
    "Admin can pause payment channels while leaving standard escrows fully operational.",
    "Error codes specify exactly which subsystem is paused (e.g. Error::ChannelPaused).",
    "Emergency unpause restores full operations immediately.",
    "Unit tests verify independent toggling of pause bitmasks."
  )

Register-Issue -Id 24 `
  -Title "feat(contracts): add automated SLA breach penalty deduction on late job submissions" `
  -Category "Smart Contracts" `
  -Labels "contracts,enhancement,Stellar Wave" `
  -Difficulty "Medium" `
  -Skills "Rust, Soroban, Logic" `
  -Summary "Add deadline SLA enforcement in contracts/agentic-commerce/src/lib.rs with progressive penalty deductions deducted from provider payout for overdue submissions." `
  -Motivation "Clients requiring urgent data analysis or market research often receive submissions well past agreed deadlines without any contractual compensation. Incorporating an SLA penalty schedule automatically penalizes late providers while fairly compensating patient clients." `
  -Implementation "1. Add sla_deadline: u64 and penalty_bps_per_hour: u32 fields to Job.`r`n2. In submit(), record submitted_at timestamp.`r`n3. In complete(), if submitted_at > sla_deadline, compute overdue duration and deduct accumulated penalty percentage from provider payout, returning the penalty directly to the client.`r`n4. Cap maximum penalty at 50% of budget." `
  -AcceptanceCriteria @(
    "Submissions before deadline receive full agreed payout.",
    "Late submissions incur deterministic hourly penalty returned to client.",
    "Penalty calculation capped at configured maximum to prevent underflow.",
    "Unit tests verify correct penalty math and multi-party token payouts."
  )

Register-Issue -Id 25 `
  -Title "feat(contracts): create contract state snapshot export and ledger verification tool" `
  -Category "Smart Contracts" `
  -Labels "contracts,tooling,developer-experience" `
  -Difficulty "Medium" `
  -Skills "Rust, TypeScript, Soroban CLI" `
  -Summary "Build a CLI verification utility that dumps on-chain contract instance and persistent storage keys to JSON and cryptographically verifies state tree consistency." `
  -Motivation "When preparing for contract upgrades (upgrade() in agent-identity or agentic-commerce), operators must inspect the raw state snapshot to ensure zero storage layout collisions or orphaned keys exist prior to loading the new WASM." `
  -Implementation "1. Create CLI command `npm run state:dump` in scripts/state-dump.ts.`r`n2. Read all persistent keys (jobs, agents, owners) using Soroban RPC getLedgerEntries.`r`n3. Deserialize raw XDR into typed JSON objects.`r`n4. Generate SHA-256 state root hash for audit verification.`r`n5. Output comprehensive summary report of active escrows, balances, and registered agents." `
  -AcceptanceCriteria @(
    "Script successfully connects to testnet RPC and extracts 100% of contract state entries.",
    "Decodes XDR ScVal structures into readable TypeScript interfaces.",
    "Generates cryptographic state manifest matching contract ledger data.",
    "Included in CI pre-deployment pipeline."
  )

Write-Host "Smart Contracts registered."

Write-Host "Registering Category 2: Backend, Indexer & Agent System (Issues 26-50)..."

Register-Issue -Id 26 `
  -Title "perf(indexer): optimize SQLite WAL mode checkpoints and concurrent reader connection pooling" `
  -Category "Backend & Indexer" `
  -Labels "backend,indexer,performance" `
  -Difficulty "Medium" `
  -Skills "TypeScript, SQLite, Better-SQLite3, Node.js" `
  -Summary "Fine-tune indexer SQLite database pragmas in indexer/src/db.ts:L15-L18 with automated WAL checkpointing, cache sizing, and separate read-only connection pools to prevent read-write lock contention." `
  -Motivation "In indexer/src/db.ts, openDatabase sets journal_mode = WAL, but does not configure wal_autocheckpoint, synchronous mode, or busy_timeout. Under heavy indexing load, concurrent queries from dashboard/server.ts block the poller with SQLITE_BUSY errors, causing event lag." `
  -Implementation "1. Configure db.pragma('synchronous = NORMAL'); db.pragma('temp_store = MEMORY'); db.pragma('cache_size = -64000'); (64MB cache).`r`n2. Set db.pragma('busy_timeout = 5000'); to prevent instant failures under concurrency.`r`n3. Implement passive background WAL checkpoint thread running `PRAGMA wal_checkpoint(PASSIVE)` every 60 seconds.`r`n4. Export separate read-only database handle for dashboard server queries." `
  -AcceptanceCriteria @(
    "Zero SQLITE_BUSY errors observed during 10,000 simulated concurrent event queries.",
    "WAL file size maintained below 10MB via periodic background checkpointing.",
    "Query latency for /api/events reduced by at least 40%.",
    "Unit tests verify concurrent read-write stability."
  )

Register-Issue -Id 27 `
  -Title "feat(indexer): add real-time Server-Sent Events (SSE) and WebSocket event streaming server" `
  -Category "Backend & Indexer" `
  -Labels "backend,indexer,enhancement" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Express, WebSocket, SSE" `
  -Summary "Implement an SSE and WebSocket streaming endpoint in indexer/src/index.ts and dashboard/server.ts, broadcasting newly indexed Soroban contract events to subscribed frontend clients instantly." `
  -Motivation "Currently, dashboard/public/app.js polls the backend every few seconds to discover job status changes. This causes latency in UI feedback, wastes network bandwidth, and places unnecessary query load on the SQLite event database." `
  -Implementation "1. Implement EventHub pub/sub class in indexer/src/events.ts using EventEmitter.`r`n2. Whenever SorobanEventPoller inserts a new event in db.ts, emit it through EventHub.`r`n3. Expose GET /api/events/stream (SSE) with filtering by contract, event_type, and address topic.`r`n4. Implement WebSocket endpoint ws://.../events for bi-directional subscription management.`r`n5. Include heartbeat keep-alive pings every 30 seconds." `
  -AcceptanceCriteria @(
    "Clients receive event notification within 200ms of on-chain ledger ingestion.",
    "SSE stream automatically reconnects with Last-Event-ID resume capability.",
    "Memory leak test passes with 100 concurrent SSE subscribers.",
    "Dashboard public app updated to subscribe to SSE event stream."
  )

Register-Issue -Id 28 `
  -Title "fix(indexer): implement chain reorg detection and ledger rollback recovery in SorobanEventPoller" `
  -Category "Backend & Indexer" `
  -Labels "backend,indexer,bug,reliability" `
  -Difficulty "Hard" `
  -Skills "TypeScript, Stellar RPC, Consensus" `
  -Summary "Add ledger hash tracking and rollback handling to indexer/src/poller.ts to safely detect and rewind database state in the event of a ledger reorganization or forked consensus." `
  -Motivation "Currently, indexer/src/poller.ts simply tracks `lastLedger` as a sequential integer in indexer_state. If the Stellar RPC provider switches upstream nodes or experiences a temporary ledger rollback, the indexer will store orphaned events and become desynchronized with ground truth." `
  -Implementation "1. Store ledger_sequence AND ledger_hash in indexer_state and events table.`r`n2. Upon fetching ledger N, verify that previous_ledger_hash matches stored ledger N-1 hash.`r`n3. If mismatch is detected, initiate rollback: delete events from ledger >= N, rewind lastLedger to last known verified ancestor, and re-poll.`r`n4. Add structured error logging and metrics counters for reorg events." `
  -AcceptanceCriteria @(
    "Indexer detects simulated ledger hash mismatch and triggers rollback.",
    "Orphaned events from invalidated ledgers are purged from database.",
    "Poller resumes ingestion cleanly from common ancestor ledger.",
    "Unit test simulates 3-ledger reorg and verifies event consistency."
  )

Register-Issue -Id 29 `
  -Title "feat(agents): implement agent heartbeat liveness monitor and automatic unregister on downtime" `
  -Category "Backend & Agents" `
  -Labels "agents,backend,enhancement" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Agents, Health Checks" `
  -Summary "Build an autonomous agent healthcheck monitor in agents/registry/src/monitor.ts that periodically pings registered agent HTTP endpoints and marks uncontactable agents as offline." `
  -Motivation "When buyer agents search the registry for provider agents (e.g. seller-webbuilder, seller-copywriter), they frequently select agents whose servers have crashed, causing buyer escrow jobs to hang and require manual cancellation." `
  -Implementation "1. In agents/registry, implement a background poller querying agent metadata URI endpoints (/health) every 60 seconds.`r`n2. Track consecutive failures: after 3 failed pings, mark agent status = 'Offline' in registry cache.`r`n3. Expose GET /api/agents?status=Online to filter active providers.`r`n4. Send automated alert webhook to agent owner when health check fails." `
  -AcceptanceCriteria @(
    "Registry monitors all registered agents without blocking HTTP request threads.",
    "Dead agents marked offline within 3 minutes of downtime.",
    "Buyer agent CLI filters out offline sellers automatically.",
    "Unit tests verify health probe timeouts, retries, and state transitions."
  )

Register-Issue -Id 30 `
  -Title "sec(api): implement sliding-window rate limiting middleware for mutating API endpoints" `
  -Category "Backend & API" `
  -Labels "backend,security,api" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Express, Security" `
  -Summary "Replace simplistic in-memory rate limiter in dashboard/server.ts:L93-L112 with an accurate sliding-window rate limiter supporting IP and wallet address tracking." `
  -Motivation "In dashboard/server.ts, rateLimitMutating uses a fixed-window counter with a single Map. Fixed windows suffer from boundary bursting (double traffic allowed at window reset), and in-memory Maps leak memory over time if inactive IPs are not evicted." `
  -Implementation "1. Implement SlidingWindowRateLimiter class with timestamp bucket arrays.`r`n2. Rate limit based on combined key: req.ip + (req.headers['x-stellar-wallet'] || '').`r`n3. Set HTTP headers: X-RateLimit-Limit, X-RateLimit-Remaining, and Retry-After.`r`n4. Implement automatic pruning of expired IP entries every 5 minutes to prevent memory leaks." `
  -AcceptanceCriteria @(
    "Prevents burst attacks across window boundaries.",
    "Memory consumption remains bounded under 100,000 distinct IP probes.",
    "Returns standard RFC-compliant 429 Too Many Requests with Retry-After header.",
    "Unit tests verify sliding-window accuracy under high concurrency."
  )

Register-Issue -Id 31 `
  -Title "fix(api): add idempotent x402 payment verification with nonce deduplication and replay guards" `
  -Category "Backend & API" `
  -Labels "backend,api,security,x402" `
  -Difficulty "Hard" `
  -Skills "TypeScript, x402, Stellar SDK, Cryptography" `
  -Summary "Implement nonce tracking and transaction hash caching in sdk/src/marcPaywall.ts to prevent transaction replay and double-spending across distributed seller agent replicas." `
  -Motivation "Currently in sdk/src/marcPaywall.ts, when a client presents an X-Payment header, the payment transaction is verified with the facilitator. If the facilitator response is delayed or network packets are duplicated, malicious clients can attempt to reuse the same signed payment XDR across parallel API calls before on-chain settlement finality." `
  -Implementation "1. Extract transaction hash from signed Stellar XDR before submitting to facilitator.`r`n2. Store txHash in cache with status 'PROCESSING' using atomic compare-and-swap.`r`n3. Reject duplicate in-flight requests presenting the same txHash with 409 Conflict.`r`n4. Mark status 'SETTLED' with API response payload cached for idempotent response re-delivery." `
  -AcceptanceCriteria @(
    "Simultaneous parallel requests with the same X-Payment header cannot trigger double execution.",
    "Retried requests receive cached idempotent response without re-charging.",
    "Memory cache automatically expires settled transactions after 1 hour.",
    "Integration tests simulate concurrent replay attack and verify prevention."
  )

Register-Issue -Id 32 `
  -Title "feat(agents): add exponential backoff retry mechanism with dead-letter queue for seller agents" `
  -Category "Backend & Agents" `
  -Labels "agents,backend,reliability" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Agents, Resiliency" `
  -Summary "Build an automated task retry and failure recovery pipeline in agents/shared.ts for seller agent job processing, routing unrecoverable tasks to a dead-letter queue." `
  -Motivation "In agents/seller-*/src, when a seller agent encounters an intermittent LLM API timeout or RPC network error while fulfilling a job deliverable, the process crashes or leaves the job in an unfulfilled state, causing the client to lose patience and cancel." `
  -Implementation "1. Implement withRetry(fn, { maxRetries: 5, initialDelayMs: 1000, factor: 2 }) with jitter in agents/shared.ts.`r`n2. Catch retryable network and rate-limit errors (HTTP 429, 503, ECONNRESET).`r`n3. If retries are exhausted, serialize job payload and error stack trace to dead_letter_jobs table.`r`n4. Expose admin endpoint POST /api/agent/dlq/retry to replay failed tasks." `
  -AcceptanceCriteria @(
    "Transient network errors recover without failing the overall escrow job.",
    "Exponential backoff with jitter prevents thundering herd on upstream APIs.",
    "Dead-letter queue records full error diagnostics and execution context.",
    "Unit tests verify retry sequence, delay calculation, and DLQ persistence."
  )

Register-Issue -Id 33 `
  -Title "feat(agents): implement autonomous multi-agent task orchestration pipeline" `
  -Category "Backend & Agents" `
  -Labels "agents,backend,enhancement,Stellar Wave" `
  -Difficulty "Hard" `
  -Skills "TypeScript, Multi-Agent Systems, LangChain" `
  -Summary "Create a high-level Orchestrator Agent in agents/orchestrator/ that takes complex user goals, decomposes them into a directed acyclic graph (DAG) of sub-tasks, and hires specialized seller agents via Bear Protocol." `
  -Motivation "Currently, buyer-agent.ts in demo/ only executes a single hardcoded task sequence with a single seller. Real-world autonomous operations require an orchestrator that can break 'Launch a new product' into 'Brand Naming' (seller-namer) -> 'Copywriting' (seller-copywriter) -> 'Landing Page' (seller-webbuilder), escrowing funds sequentially." `
  -Implementation "1. Create OrchestratorAgent class with task planning LLM prompt.`r`n2. Query registry for agents matching required skills (e.g. namer, copywriter).`r`n3. Construct DAG where task N+1 depends on deliverable of task N.`r`n4. Escrow jobs on-chain sequentially, feeding intermediate outputs into downstream agent requests.`r`n5. Aggregate final deliverable report for the end user." `
  -AcceptanceCriteria @(
    "Orchestrator successfully decomposes multi-step project into 3 distinct sub-jobs.",
    "Escrows funds on Soroban testnet for each sub-agent as prerequisites complete.",
    "Handles partial failure: if step 2 fails, pauses downstream execution cleanly.",
    "Full end-to-end integration demo script running in demo/multi-agent.ts."
  )

Register-Issue -Id 34 `
  -Title "feat(api): integrate OpenTelemetry distributed tracing across agent HTTP and x402 requests" `
  -Category "Backend & API" `
  -Labels "backend,api,devops,observability" `
  -Difficulty "Medium" `
  -Skills "TypeScript, OpenTelemetry, Observability" `
  -Summary "Instrument dashboard/server.ts, indexer, and seller agents with OpenTelemetry SDK to generate distributed trace spans for x402 payment flows and Soroban RPC calls." `
  -Motivation "Debugging multi-agent transactions across buyer, seller, indexer, and Stellar RPC nodes is currently difficult due to fragmented console logs. Distributed tracing allows operators to visualize latency bottlenecks and failure points across the entire micropayment lifecycle." `
  -Implementation "1. Install @opentelemetry/api and @opentelemetry/sdk-trace-node in root workspace.`r`n2. Propagate traceparent headers across marcFetch and marcPaywall HTTP requests.`r`n3. Create custom spans for Stellar RPC simulation, transaction submission, and database queries.`r`n4. Export trace data via OTLP to Jaeger / Grafana Tempo." `
  -AcceptanceCriteria @(
    "Every agent API request contains traceparent correlation ID.",
    "Visual waterfall trace shows exact breakdown of x402 verification, LLM execution, and on-chain submission.",
    "Trace overhead benchmarked under 2ms per request.",
    "Configuration guide documented in docs/OBSERVABILITY.md."
  )

Register-Issue -Id 35 `
  -Title "sec(agents): add AWS KMS and HashiCorp Vault remote signing integration for agent keys" `
  -Category "Backend & Agents" `
  -Labels "agents,security,infrastructure" `
  -Difficulty "Hard" `
  -Skills "TypeScript, AWS KMS, Security, Cryptography" `
  -Summary "Build an enterprise RemoteSigner class in sdk/src/signer.ts allowing agents to sign Stellar transactions using hardware security modules (AWS KMS / HashiCorp Vault) rather than plaintext secret keys." `
  -Motivation "In demo/buyer-agent.ts and demo/seller-agent.ts, agents load private keys directly from environment variables (Keypair.fromSecret(process.env.SECRET_KEY)). In cloud environments, plaintext memory keys are vulnerable to process inspection, accidental logging, and server compromise." `
  -Implementation "1. Implement RemoteSigner interface matching Stellar Signer contract.`r`n2. Add AwsKmsSigner implementing Ed25519 signature generation via AWS KMS Sign API.`r`n3. Add VaultSigner supporting HashiCorp Vault Transit engine.`r`n4. Update IdentityClient and CommerceClient to accept generic Signer interface alongside Keypair.`r`n5. Include local mock KMS test suite." `
  -AcceptanceCriteria @(
    "Agent can register, fund jobs, and sign x402 headers without holding raw private keys in memory.",
    "Hardware-enforced signature audit trail preserved in cloud provider logs.",
    "Zero plaintext secret leakage in memory dumps or error logs.",
    "Unit tests verify valid Stellar signature generation using mocked KMS response."
  )

Register-Issue -Id 36 `
  -Title "sec(api): implement Stellar SEP-0010 Web Authentication challenge-response for dashboard API" `
  -Category "Backend & API" `
  -Labels "backend,api,security,compliance" `
  -Difficulty "Medium" `
  -Skills "TypeScript, SEP-0010, Stellar SDK, JWT" `
  -Summary "Upgrade dashboard session authentication in dashboard/lib/auth.ts to strictly adhere to Stellar ecosystem standard SEP-0010 (Stellar Web Authentication)." `
  -Motivation "Currently in dashboard/lib/auth.ts:L36-L44, authentication uses a custom nonce challenge. Standard Stellar wallets (Freighter, Albedo, Lobstr) natively support SEP-0010 challenge transactions, enabling single-click secure signing with domain verification." `
  -Implementation "1. Implement GET /api/auth/challenge generating a SEP-0010 challenge transaction with home_domain and server signing key.`r`n2. Implement POST /api/auth/token verifying wallet signature on the challenge transaction using Utils.verifyChallengeTx.`r`n3. Issue signed JWT session token with 24-hour expiration.`r`n4. Update requireAuth middleware to validate JWT signature and claims." `
  -AcceptanceCriteria @(
    "Authentication flow conforms 100% to SEP-0010 specification.",
    "Freighter wallet displays official domain verification warning rather than raw arbitrary text.",
    "Replay attacks prevented via time bounds and challenge transaction sequence numbers.",
    "Unit tests verify valid and expired challenge transaction verification."
  )

Register-Issue -Id 37 `
  -Title "feat(indexer): build on-chain agent reputation scoring engine based on completion rate" `
  -Category "Backend & Indexer" `
  -Labels "backend,indexer,enhancement" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Algorithms, SQL" `
  -Summary "Create a reputation scoring algorithm in indexer/src/reputation.ts that computes dynamic trustworthiness ratings for agents based on historical job completions, disputes, and response times." `
  -Motivation "Clients selecting provider agents have no objective metric to judge reliability. Incorporating an on-chain algorithmic reputation score incentivizes providers to deliver quality work promptly and penalizes ghosting or disputes." `
  -Implementation "1. Aggregate historical metrics per agent: total_jobs, completed_jobs, cancelled_jobs, disputed_jobs, avg_completion_time_secs.`r`n2. Compute normalized score (0 - 100) using Bayesian average: `Score = (C * m + sum(ratings)) / (C + n)`.`r`n3. Expose GET /api/agents/:id/reputation with score breakdown and percentile rank.`r`n4. Update indexer to recalculate scores upon every JobCompleted / JobDisputed event." `
  -AcceptanceCriteria @(
    "Reputation score updates in real-time as jobs settle.",
    "Bayesian prior prevents new agents with 1 job from falsely outranking established agents with 100 jobs.",
    "Disputed or cancelled jobs penalize agent score deterministically.",
    "Unit tests verify mathematical stability and edge cases (zero jobs, 100% disputes)."
  )

Register-Issue -Id 38 `
  -Title "sec(api): add automated deliverable content inspection and payload validation pipeline" `
  -Category "Backend & API" `
  -Labels "backend,api,security" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Security, Content Validation" `
  -Summary "Implement an automated validation pipeline in backend API inspecting deliverable URIs for malicious payloads, phishing URLs, oversized files, and invalid formats before evaluator notification." `
  -Motivation "In contracts/agentic-commerce, deliverable is an arbitrary string. If a malicious seller submits a link pointing to malware, an IP logger, or an exploit kit, human or automated evaluators clicking the link in the dashboard could be compromised." `
  -Implementation "1. Create DeliverableValidator service in dashboard/lib/validator.ts.`r`n2. Validate URI protocols: strictly allow https:// and ipfs://.`r`n3. Check URLs against Google Safe Browsing API / VirusTotal API.`r`n4. For IPFS hashes, verify MIME type and enforce 50MB file size limit before fetching.`r`n5. Flag suspicious deliverables with warning badges in the dashboard." `
  -AcceptanceCriteria @(
    "Dangerous schemes (javascript:, file:, data:) rejected immediately.",
    "Known malicious URLs flagged before evaluator review.",
    "Oversized deliverables rejected to prevent browser memory exhaustion.",
    "Unit tests cover malicious payloads, SSRF attempts, and valid IPFS hashes."
  )

Register-Issue -Id 39 `
  -Title "feat(indexer): implement PostgreSQL database adapter for production scalable indexing" `
  -Category "Backend & Indexer" `
  -Labels "backend,indexer,infrastructure" `
  -Difficulty "Hard" `
  -Skills "TypeScript, PostgreSQL, SQL, Prisma/Kysely" `
  -Summary "Create a PostgreSQL storage adapter in indexer/src/db-postgres.ts allowing enterprise deployments to run distributed indexer instances with connection pooling and high availability." `
  -Motivation "While SQLite in indexer/src/db.ts is excellent for local development and single-node demos, production multi-replica cloud clusters (Kubernetes) require a centralized, concurrent SQL database with replica read pools and automated backups." `
  -Implementation "1. Define DatabaseAdapter interface abstracting insertEvent, getEvents, and getIndexerState.`r`n2. Implement PostgresAdapter using pg or pg-promise with connection pooling.`r`n3. Provide idempotent SQL migration scripts in indexer/migrations/postgres/.`r`n4. Add environment variable `DATABASE_URL` toggle selecting between SQLite and Postgres." `
  -AcceptanceCriteria @(
    "Indexer functions identically with either SQLite or PostgreSQL backing store.",
    "Supports 500 concurrent read queries without database connection exhaustion.",
    "PostgreSQL docker container included in docker-compose.yml for easy local testing.",
    "Integration tests run against ephemeral test PostgreSQL instance."
  )

Register-Issue -Id 40 `
  -Title "feat(api): add Prometheus metrics endpoint (/metrics) for indexer and API health monitoring" `
  -Category "Backend & API" `
  -Labels "backend,api,devops,observability" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Prometheus, Express, DevOps" `
  -Summary "Expose a Prometheus-compatible /metrics endpoint in dashboard/server.ts and indexer tracking RPC latency, event ingestion rates, active jobs, and error counts." `
  -Motivation "Production operations require visibility into indexer health, RPC failure rates, and payment throughput to alert on-call engineers before system outages affect users." `
  -Implementation "1. Install prom-client in dashboard and indexer workspaces.`r`n2. Define metrics: `stellar_events_ingested_total`, `stellar_rpc_request_duration_seconds`, `active_escrow_jobs_gauge`, `http_requests_total`.`r`n3. Expose GET /metrics protected by optional bearer token.`r`n4. Provide ready-to-use Grafana dashboard JSON in docs/grafana-dashboard.json." `
  -AcceptanceCriteria @(
    "/metrics endpoint returns standard Prometheus exposition text format.",
    "Counters accurately increment on event ingestion and API requests.",
    "Includes histogram bucket distributions for Soroban RPC call latency.",
    "Grafana dashboard imports cleanly and visualizes real-time protocol activity."
  )

Register-Issue -Id 41 `
  -Title "feat(agents): implement outbound webhook notification dispatcher for new escrow jobs" `
  -Category "Backend & Agents" `
  -Labels "agents,backend,enhancement" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Webhooks, Security, HMAC" `
  -Summary "Build a webhook delivery system in indexer/src/webhooks.ts that sends signed HTTP POST notifications to registered agent URLs whenever a new escrow job is assigned to them." `
  -Motivation "Currently, seller agents must continuously poll the indexer or Soroban RPC to detect when a client has created a job for them. Webhooks allow seller agents to remain passive until work arrives, reducing idle compute and RPC load." `
  -Implementation "1. Allow agents to configure webhook_url and webhook_secret in agent metadata.`r`n2. When indexer processes JobCreated event, look up provider webhook URL.`r`n3. Dispatch HTTP POST with payload: { event: 'JobCreated', jobId, budget, client, description }.`r`n4. Sign request body with HMAC-SHA256 signature in X-Bear-Signature header.`r`n5. Implement retry schedule (3 attempts with exponential backoff) on 5xx failures." `
  -AcceptanceCriteria @(
    "Provider agents receive webhook notification within 1 second of job creation.",
    "HMAC-SHA256 signature enables providers to verify authenticity and prevent spoofing.",
    "Failed webhooks retry gracefully without crashing the indexer poller.",
    "Unit tests verify HMAC signature generation and retry logic."
  )

Register-Issue -Id 42 `
  -Title "feat(agents): implement autonomous job expiration watcher daemon with automated refund triggers" `
  -Category "Backend & Agents" `
  -Labels "agents,backend,automation" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Stellar SDK, Automation" `
  -Summary "Create a background daemon service in agents/watcher/ that monitors expired jobs and automatically calls cancel() or expire_job() on-chain to refund stalled client funds." `
  -Motivation "When a provider fails to submit by the agreed deadline, funds remain locked until the client manually connects their wallet and signs a cancel transaction. An automated protocol keeper bot ensures capital is promptly returned to clients without manual intervention." `
  -Implementation "1. Build JobExpirationWatcher service polling indexer for Funded jobs where `current_time > created_at + timeout`.`r`n2. Verify on-chain job status via CommerceClient.getJob(id).`r`n3. Assemble and submit cancel or expire transaction using keeper wallet keypair.`r`n4. Log refunded amount and notify client address via event log." `
  -AcceptanceCriteria @(
    "Daemon identifies expired jobs and triggers refund within 5 minutes of timeout.",
    "Keeper wallet handles transaction fee sponsorship via Stellar Fee Bump transactions.",
    "Concurrency guards prevent duplicate transaction submissions for the same job.",
    "Unit tests simulate job expiration and verify automated cancellation."
  )

Register-Issue -Id 43 `
  -Title "feat(agents): add IPFS and Arweave pinning service integration for agent metadata URIs" `
  -Category "Backend & Agents" `
  -Labels "agents,backend,infrastructure" `
  -Difficulty "Medium" `
  -Skills "TypeScript, IPFS, Arweave, Decentralized Storage" `
  -Summary "Build an automated storage client in sdk/src/storage.ts supporting Pinata, Web3.Storage, and Arweave for persistent pinning of agent metadata and job deliverables." `
  -Motivation "In demo/seller-agent.ts, metadata URIs use placeholder IPFS links or ephemeral localhost URLs. In production, unpinned IPFS files get purged by garbage collection, causing agent profiles and job deliverables to become inaccessible." `
  -Implementation "1. Implement StorageProvider interface with uploadJson(data) and uploadBuffer(buffer).`r`n2. Provide PinataStorageProvider and ArweaveStorageProvider implementations.`r`n3. Compute deterministic IPFS CIDv1 before upload.`r`n4. Add CLI helper `npm run agent:publish-metadata` in agents/registry." `
  -AcceptanceCriteria @(
    "Metadata uploads return permanent, resolvable IPFS/Arweave URIs.",
    "Uploaded content verified by fetching back and comparing SHA-256 hash.",
    "Fallback between multiple pinning gateways if primary service is down.",
    "SDK documentation updated with storage configuration guide."
  )

Register-Issue -Id 44 `
  -Title "feat(agents): implement semantic matchmaking engine for agent discovery using embeddings" `
  -Category "Backend & Agents" `
  -Labels "agents,backend,ai,enhancement" `
  -Difficulty "Hard" `
  -Skills "TypeScript, Vector Embeddings, NLP, Agent Discovery" `
  -Summary "Build a semantic search API endpoint in dashboard/server.ts using text embeddings to match user natural language requests with the most capable registered agents." `
  -Motivation "Currently in dashboard/server.ts and public/app.js:L40, agent searching relies on simple substring matching on agent name. Users describing complex needs (e.g. 'I need someone to summarize Stellar governance proposals') fail to discover relevant agents whose descriptions don't share exact keywords." `
  -Implementation "1. When agents register, generate 384-dimensional text embeddings of their metadata description using a lightweight local embedding model (e.g. transformers.js).`r`n2. Store embeddings in SQLite with sqlite-vec extension or in-memory vector index.`r`n3. Expose POST /api/agents/match accepting { query: string, topK: number }.`r`n4. Compute cosine similarity and return ranked list of best-fit agents with similarity scores." `
  -AcceptanceCriteria @(
    "Natural language queries successfully return semantically related agents.",
    "Search latency under 50ms for 1,000 registered agents.",
    "Gracefully falls back to lexical search if embedding engine is disabled.",
    "Unit tests verify ranking accuracy across domain-specific test prompts."
  )

Register-Issue -Id 45 `
  -Title "feat(agents): provide Fastify and Hono server adapters for seller agent development" `
  -Category "Backend & Agents" `
  -Labels "agents,backend,developer-experience" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Fastify, Hono, SDK" `
  -Summary "Create production-ready Fastify and Hono boilerplate templates in agents/templates/ for developers building high-throughput seller agents with x402 paywalls." `
  -Motivation "All current seller agents (copywriter, webbuilder, etc.) are implemented using Express. Developers building modern edge or serverless microservices require modern web frameworks (Fastify, Hono) for superior throughput and native TypeScript ergonomics." `
  -Implementation "1. Build Fastify seller agent scaffold in agents/templates/fastify-seller/.`r`n2. Build Hono seller agent scaffold in agents/templates/hono-seller/ (compatible with Cloudflare Workers / Node).`r`n3. Wire marcPaywallFastify and marcPaywallHono middleware.`r`n4. Include Dockerfile and comprehensive README with deployment instructions." `
  -AcceptanceCriteria @(
    "Fastify and Hono agent templates compile and start clean with `npm run dev`.",
    "x402 paywall middleware correctly issues HTTP 402 and validates Stellar payments.",
    "Benchmarking reveals >2x RPS throughput compared to legacy Express templates.",
    "Comprehensive test suite included in each template."
  )

Register-Issue -Id 46 `
  -Title "feat(api): generate automated revenue analytics and transaction accounting export (CSV/JSON)" `
  -Category "Backend & API" `
  -Labels "backend,api,enhancement" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Express, Accounting" `
  -Summary "Add financial accounting and tax reporting export endpoints in dashboard/server.ts, allowing agent owners to download full CSV/JSON audit trails of all received payments and protocol fees." `
  -Motivation "Operators running commercial seller agents must account for revenue, currency conversions, and protocol fees for tax and financial auditing. Currently, there is no exportable transaction ledger in the dashboard." `
  -Implementation "1. Implement GET /api/reports/revenue?wallet=...&from=...&to=...&format=csv.`r`n2. Query indexer for all JobCompleted events involving the specified wallet as provider or client.`r`n3. Format CSV columns: Timestamp, TransactionHash, Ledger, JobId, Role, Token, GrossAmount, FeeAmount, NetAmount.`r`n4. Include daily and monthly revenue aggregate summaries." `
  -AcceptanceCriteria @(
    "CSV and JSON export formats generated accurately according to RFC 4180.",
    "Gross, fee, and net balance numbers reconcile 100% with on-chain token transfers.",
    "Supports date range filtering and pagination.",
    "Unit tests verify CSV formatting and financial reconciliation."
  )

Register-Issue -Id 47 `
  -Title "fix(agents): implement POSIX signal handling (SIGTERM/SIGINT) for zero-downtime agent shutdown" `
  -Category "Backend & Agents" `
  -Labels "agents,backend,bug,reliability" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Node.js, Systems" `
  -Summary "Add graceful shutdown lifecycle handling across all seller agents in agents/ to finish in-flight jobs and close database connections before exiting upon SIGTERM/SIGINT." `
  -Motivation "When agents deployed in Kubernetes or Docker containers are restarted during deployments, SIGTERM signals currently terminate the Node.js process immediately, aborting active x402 payment settlements and corrupting local SQLite task state." `
  -Implementation "1. Implement registerGracefulShutdown(server, activeTaskTracker, db) in agents/shared.ts.`r`n2. On SIGTERM or SIGINT, stop accepting new HTTP requests (server.close).`r`n3. Wait up to 15 seconds for active job processing and on-chain submissions to complete.`r`n4. Gracefully close SQLite handles and flush log buffers before calling process.exit(0)." `
  -AcceptanceCriteria @(
    "In-flight jobs complete successfully during rolling container updates.",
    "No SQLite database corruption occurs on unexpected container termination.",
    "Process exits cleanly with code 0 within configured timeout window.",
    "Unit tests simulate SIGTERM during active task execution."
  )

Register-Issue -Id 48 `
  -Title "feat(indexer): implement automated database migration runner for indexer schema evolution" `
  -Category "Backend & Indexer" `
  -Labels "backend,indexer,infrastructure" `
  -Difficulty "Medium" `
  -Skills "TypeScript, SQLite, Database Migrations" `
  -Summary "Replace hardcoded CREATE TABLE IF NOT EXISTS in indexer/src/db.ts:L19-L46 with a formal, versioned migration runner supporting forward and rollback migrations." `
  -Motivation "In indexer/src/db.ts, schema updates are embedded in a single hardcoded exec() string. Adding columns (e.g. deliverable_hash, version, duration) to existing production databases without dropping tables currently requires fragile manual SQL scripts." `
  -Implementation "1. Create indexer/migrations/ directory with numbered SQL files: 001_initial.sql, 002_add_hash.sql, etc.`r`n2. Create schema_migrations table tracking applied migration version numbers and timestamps.`r`n3. Implement runMigrations(db) executing pending migrations in atomic transactions.`r`n4. Support dry-run mode and rollback capabilities." `
  -AcceptanceCriteria @(
    "New database initialized cleanly from baseline migrations.",
    "Existing databases seamlessly upgraded without data loss.",
    "Failed migrations automatically roll back transaction and halt startup.",
    "Unit tests verify sequential migration execution and rollback safety."
  )

Register-Issue -Id 49 `
  -Title "fix(indexer): resolve database lock contention by isolating event write transactions" `
  -Category "Backend & Indexer" `
  -Labels "backend,indexer,bug,performance" `
  -Difficulty "Medium" `
  -Skills "TypeScript, SQLite, Concurrency" `
  -Summary "Refactor indexer batch insertion in indexer/src/poller.ts to wrap event batches in single IMMEDIATE transactions rather than per-event autocommit inserts." `
  -Motivation "In indexer/src/poller.ts, events are inserted one-by-one inside a loop. Each individual insert acquires and releases SQLite database locks, resulting in hundreds of filesystem fsync operations per ledger and blocking dashboard reader queries." `
  -Implementation "1. In indexer/src/db.ts, create insertEventsBatch prepared transaction helper using `db.transaction((events) => { ... })`.`r`n2. Use `BEGIN IMMEDIATE` to prevent deadlock between concurrent writer processes.`r`n3. Update poller.ts to commit entire ledger event batches in a single atomic transaction.`r`n4. Benchmark write throughput before and after optimization." `
  -AcceptanceCriteria @(
    "Batch insertion of 100 events executes in a single SQLite transaction.",
    "Ledger processing time reduced from ~1,200ms to <150ms per batch.",
    "Zero transaction deadlocks under concurrent read traffic.",
    "Unit tests verify atomicity: all events in a ledger batch persist or none do."
  )

Register-Issue -Id 50 `
  -Title "feat(agents): add strict runtime environment and configuration schema validation using Zod" `
  -Category "Backend & Agents" `
  -Labels "agents,backend,developer-experience" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Zod, Validation" `
  -Summary "Implement comprehensive environment variable and configuration schema validation using Zod across all agent crates and dashboard/server.ts." `
  -Motivation "Agents currently read process.env directly with sparse fallback defaults. Misconfigured environment variables (e.g. invalid Stellar secret key format, malformed RPC URL, missing port) cause runtime crashes deep inside execution instead of failing fast at startup with helpful error messages." `
  -Implementation "1. Define AgentConfigSchema using Zod validating STELLAR_RPC_URL, NETWORK_PASSPHRASE, SECRET_KEY, CONTRACT_ADDRESSES, and PORT.`r`n2. Validate process.env at boot in config.ts, formatting Zod validation errors into readable terminal tables.`r`n3. Check that Stellar public keys are valid StrKey Ed25519 format.`r`n4. Add .env.schema documentation file." `
  -AcceptanceCriteria @(
    "Application fails fast at boot with clear error messages if required env vars are missing or invalid.",
    "Exported config object is 100% strictly typed without any `as string` type assertions.",
    "Unit tests cover valid configurations and common user misconfigurations.",
    "Sample .env.example files verified against Zod schemas in CI."
  )

Write-Host "Backend & Indexer registered."

Write-Host "Registering Category 3: Frontend & Dashboard (Issues 51-70)..."

Register-Issue -Id 51 `
  -Title "feat(dashboard): integrate Stellar Wallets Kit supporting Freighter, xBull, and Albedo wallets" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,enhancement" `
  -Difficulty "Medium" `
  -Skills "JavaScript, Stellar Wallets Kit, Web3 UI" `
  -Summary "Upgrade Stellar Wallets Kit in dashboard/public/app.js:L57-L105 with multi-wallet modal selector supporting Freighter, xBull, Albedo, and Lobstr wallets." `
  -Motivation "In dashboard/public/app.js, wallet connection relies on hardcoded Freighter checks with partial fallback. Users with alternative popular Stellar wallets (xBull, Albedo) cannot connect, sign transactions, or interact with escrow jobs in the dashboard." `
  -Implementation "1. Configure StellarWalletsKit with modules: [new FreighterModule(), new XbullModule(), new AlbedoModule(), new LobstrModule()].`r`n2. Render responsive wallet modal with provider brand icons.`r`n3. Persist selected wallet type in localStorage for auto-reconnection.`r`n4. Handle wallet account switching and network mismatch events." `
  -AcceptanceCriteria @(
    "Users can connect with any major Stellar wallet provider.",
    "Auto-detects installed wallet browser extensions.",
    "Prompts user if wallet network does not match dashboard target network (Testnet vs Mainnet).",
    "UI tested across Chrome, Firefox, and mobile Brave browser."
  )

Register-Issue -Id 52 `
  -Title "feat(dashboard): add optimistic UI updates and live state transitions for escrow actions" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,enhancement" `
  -Difficulty "Medium" `
  -Skills "JavaScript, DOM, UX, Optimistic UI" `
  -Summary "Implement optimistic UI state mutations in dashboard/public/app.js for job creation, submission, and completion actions while on-chain transactions confirm." `
  -Motivation "Stellar testnet ledger closing times take 4-5 seconds. Currently, when a user clicks 'Approve Job' or 'Fund Escrow', the dashboard shows a static spinner with no immediate feedback, leading users to believe the app is unresponsive or double-click action buttons." `
  -Implementation "1. Immediately update local state and DOM to show target state with an 'In-Flight / Pending' badge upon signing.`r`n2. Display non-intrusive progress toast with link to Stellar Expert block explorer.`r`n3. If transaction confirms, promote optimistic state to confirmed.`r`n4. If transaction reverts, rollback local state and display actionable error alert." `
  -AcceptanceCriteria @(
    "Buttons immediately disable and show pending animation upon click.",
    "UI reflects optimistic state within 50ms of user action.",
    "Graceful rollback with error toast if RPC transaction submission fails.",
    "Manual testing verifies zero double-submission under rapid clicking."
  )

Register-Issue -Id 53 `
  -Title "feat(dashboard): create interactive job lifecycle visualizer with real-time status stepper" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,ui" `
  -Difficulty "Medium" `
  -Skills "JavaScript, CSS, SVG, UI Design" `
  -Summary "Build an animated, interactive job lifecycle stepper component in dashboard/public/app.js visualizing the progression: Created -> Funded -> Submitted -> Evaluated -> Settled." `
  -Motivation "In dashboard/public/app.js, job statuses are shown as plain text pills. Users and evaluators lack a clear visual understanding of where a job sits in its lifecycle, who holds the action item (client, provider, or evaluator), and what transitions remain." `
  -Implementation "1. Create SVG/CSS horizontal stepper component with animated connector lines.`r`n2. Highlight current active step with pulsing glow and role indicator (e.g. 'Waiting on Evaluator Approval').`r`n3. Show timestamp and transaction hash link for each completed stage.`r`n4. Support branched paths for Disputed and Cancelled states." `
  -AcceptanceCriteria @(
    "Visual stepper renders cleanly on both desktop and mobile viewports.",
    "Transitions animate smoothly when job status changes.",
    "Tooltips display ledger timestamps and transaction hashes on completed steps.",
    "Accessible for screen readers with proper ARIA attributes."
  )

Register-Issue -Id 54 `
  -Title "feat(dashboard): add pre-flight transaction simulation and gas fee estimation modal" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,enhancement" `
  -Difficulty "Medium" `
  -Skills "JavaScript, Stellar SDK, UX" `
  -Summary "Implement a transaction pre-flight simulation modal in dashboard/public/app.js showing estimated network fees, contract CPU instructions, and balance diffs before prompting wallet signature." `
  -Motivation "Currently, when a user creates or approves a job, the transaction is sent directly to the wallet without explaining exact fee deductions or checking whether the transaction will fail, leading to confusing wallet rejection errors." `
  -Implementation "1. Call rpc.Server.simulateTransaction() before opening wallet sign modal.`r`n2. Parse simulation result: extract CPU instructions, memory bytes, and minResourceFee.`r`n3. Display confirmation modal detailing: Action, Target Contract, Budget Amount, Network Fee (XLM), and Projected Balances.`r`n4. If simulation fails, display Soroban contract error explanation instead of submitting." `
  -AcceptanceCriteria @(
    "Simulation modal displays accurate network fee and resource consumption breakdown.",
    "Detects failed transactions (e.g. insufficient token balance) and blocks wallet prompt.",
    "User can review and cancel before triggering wallet popup.",
    "Unit tests verify simulation parsing and error extraction."
  )

Register-Issue -Id 55 `
  -Title "feat(dashboard): build comprehensive Agent Performance analytics dashboard with SVG charts" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,analytics" `
  -Difficulty "Medium" `
  -Skills "JavaScript, SVG, Charts, Analytics" `
  -Summary "Add an Analytics view to dashboard/public/app.js featuring lightweight SVG charts for protocol daily volume, active jobs count, average settlement time, and top-earning agents." `
  -Motivation "The dashboard currently only lists raw tabular data of agents and jobs. Protocol stakeholders, investors, and prospective clients need high-level macroeconomic visibility into protocol growth, liquidity velocity, and provider performance." `
  -Implementation "1. Add 'Analytics' tab to dashboard navigation sidebar.`r`n2. Build zero-dependency SVG chart helpers (BarChart, LineChart, DonutChart) matching Bear design system.`r`n3. Query /api/stats/historical endpoint for 30-day volume and transaction metrics.`r`n4. Display key performance indicator (KPI) metric cards with month-over-month trend indicators." `
  -AcceptanceCriteria @(
    "Charts render crisp SVG graphics with responsive resizing across window dimensions.",
    "Zero external heavyweight charting libraries (Chart.js, D3) to preserve fast page load (<100ms).",
    "Interactive hover tooltips displaying date, volume (USDC), and job count.",
    "Tested with light and dark dashboard themes."
  )

Register-Issue -Id 56 `
  -Title "fix(dashboard): audit and resolve WCAG 2.1 AAA accessibility contrast issues in dark/light themes" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,accessibility,bug" `
  -Difficulty "Medium" `
  -Skills "CSS, Accessibility, WCAG, Design" `
  -Summary "Conduct a complete WCAG 2.1 AAA accessibility audit on dashboard/public/style.css, resolving low-contrast text elements, missing focus indicators, and aria labels." `
  -Motivation "In dashboard/public/style.css, several muted text colors (e.g. --text-muted on card backgrounds) have contrast ratios below 3.5:1, failing accessibility standards for visually impaired users and preventing formal enterprise compliance." `
  -Implementation "1. Audit color palette with Lighthouse and axe-core accessibility tools.`r`n2. Adjust CSS variables: ensure text contrast ratio >= 7:1 for normal text and >= 4.5:1 for large text.`r`n3. Add high-visibility keyboard focus rings (:focus-visible) for all interactive buttons and inputs.`r`n4. Ensure all icon-only buttons have descriptive aria-label attributes." `
  -AcceptanceCriteria @(
    "Lighthouse Accessibility audit score reaches 100/100 on both dark and light modes.",
    "Zero color contrast violations detected by axe DevTools.",
    "Full keyboard navigation possible across all tabs, modals, and forms.",
    "Tested with screen reader (NVDA / VoiceOver)."
  )

Register-Issue -Id 57 `
  -Title "fix(dashboard): improve mobile responsiveness with adaptive card layouts for transaction tables" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,mobile,ui" `
  -Difficulty "Medium" `
  -Skills "CSS, Responsive Design, Mobile UX" `
  -Summary "Refactor the jobs and events data tables in dashboard/public/index.html to automatically morph into touch-friendly cards on screens below 768px width." `
  -Motivation "The current desktop table layout in dashboard/public/app.js causes severe horizontal overflow on mobile viewports, truncating Stellar wallet addresses and making action buttons difficult to tap on mobile browsers." `
  -Implementation "1. In style.css, implement CSS media query (@media (max-width: 768px)) for data tables.`r`n2. Convert table rows to card containers using CSS Grid / Flexbox.`r`n3. Truncate long Stellar public keys with copy-to-clipboard tap targets.`r`n4. Optimize button sizes (minimum 44x44px touch target) for mobile ergonomics." `
  -AcceptanceCriteria @(
    "Zero horizontal window scroll on viewports from 320px to 768px.",
    "All job metadata (client, provider, budget, status) readable without truncation.",
    "Action buttons easy to tap with one hand on mobile devices.",
    "Tested on simulated iPhone, iPad, and Android device viewports."
  )

Register-Issue -Id 58 `
  -Title "feat(dashboard): implement global React error boundaries and offline fallback status banners" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,reliability" `
  -Difficulty "Medium" `
  -Skills "JavaScript, UX, Error Handling" `
  -Summary "Implement network connectivity detection and global error boundary screens in dashboard/public/app.js to gracefully handle RPC outages and offline states." `
  -Motivation "If a user's internet disconnects or the Stellar testnet RPC experiences a transient outage, the dashboard currently fails silently, leaving white screens or frozen loading indicators with no explanation." `
  -Implementation "1. Listen to window.navigator.onLine and 'online'/'offline' browser events.`r`n2. Display sticky top banner: 'Network Disconnected — Retrying connection to Stellar RPC...'.`r`n3. Wrap API fetch calls in global try-catch handler rendering an actionable 'Something went wrong' view with a 'Retry' button.`r`n4. Add healthcheck probe to verify RPC node availability on startup." `
  -AcceptanceCriteria @(
    "Offline banner appears immediately when network disconnects.",
    "Dashboard automatically resumes polling and refreshes data when connectivity is restored.",
    "Clear error screens replace blank white page on uncaught JavaScript errors.",
    "Manual testing verifies graceful offline degradation."
  )

Register-Issue -Id 59 `
  -Title "feat(dashboard): add built-in interactive x402 API monetization testing playground" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,x402,developer-experience" `
  -Difficulty "Medium" `
  -Skills "JavaScript, x402, Stellar SDK, Playground" `
  -Summary "Build an interactive x402 API tester inside the dashboard allowing developers to simulate HTTP 402 payment requirements, inspect payment headers, and test automated micro-settlements." `
  -Motivation "Developers integrating their seller agents with Bear Protocol must currently use curl scripts or custom Node programs to test x402 micropayments. A visual sandbox drastically shortens developer onboarding time." `
  -Implementation "1. Add 'x402 Playground' view in dashboard navigation.`r`n2. Input fields: Target Endpoint URL, HTTP Method, Request Body JSON, and Payer Keypair/Wallet.`r`n3. 'Send Request' button executes request: captures HTTP 402, displays decoded X-Payment-Requirements header, builds signed payment, and displays response.`r`n4. Show raw HTTP request/response headers side-by-side." `
  -AcceptanceCriteria @(
    "Developers can test any x402 endpoint directly in the browser.",
    "Decodes and displays payment requirements (token, destination, amount, facilitator URL).",
    "Signs payment transaction via connected wallet or ephemeral test keypair.",
    "Displays successful paid response payload with response headers."
  )

Register-Issue -Id 60 `
  -Title "feat(dashboard): implement drag-and-drop IPFS metadata uploader with live JSON validation" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,enhancement" `
  -Difficulty "Medium" `
  -Skills "JavaScript, IPFS, JSON Schema, UX" `
  -Summary "Add a drag-and-drop agent metadata creation modal in dashboard/public/app.js with live ERC-8004 JSON schema validation and one-click IPFS publishing." `
  -Motivation "Registering an agent in the dashboard currently requires pasting a pre-existing IPFS URI string. Non-technical developers and users struggle to format, pin, and host JSON metadata files manually." `
  -Implementation "1. Build modal form: Agent Name, Description, Image Upload, Tags, Endpoints, Capabilities.`r`n2. Validate input fields against ERC-8004 JSON schema in real time.`r`n3. Upload metadata to IPFS via backend pinning endpoint upon submit.`r`n4. Automatically populate resulting ipfs:// URI into the contract registration input." `
  -AcceptanceCriteria @(
    "Users can configure and register an agent without writing raw JSON files.",
    "Image files automatically resized and uploaded to decentralized storage.",
    "Live preview shows exactly how agent card will appear in the registry.",
    "Validates all required fields before enabling transaction signing."
  )

Register-Issue -Id 61 `
  -Title "feat(dashboard): create formal dispute submission modal with evidence upload and reason tags" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,ui" `
  -Difficulty "Medium" `
  -Skills "JavaScript, Web3 UI, Forms" `
  -Summary "Build a structured dispute submission modal in dashboard/public/app.js allowing clients to attach dispute reason tags, evidence links, and explanatory notes when disputing a job." `
  -Motivation "Currently in dashboard/public/app.js:L1830, clicking 'Dispute' immediately triggers the contract dispute entry point without collecting any context, making it impossible for evaluators or arbitrators to understand why the client disputed the deliverable." `
  -Implementation "1. Open modal upon clicking 'Open Dispute': Reason dropdown (Incomplete Deliverable, Low Quality, Plagiarism, Late Submission, Other).`r`n2. Textarea for detailed dispute explanation and file attachments for evidence.`r`n3. Upload evidence bundle to IPFS and include URI in dispute transaction memo/topic.`r`n4. Display dispute evidence card prominently on the disputed job detail view." `
  -AcceptanceCriteria @(
    "Dispute modal captures structured reason and evidence links.",
    "Evidence bundle stored persistently and linked to job on-chain record.",
    "Evaluators can review evidence directly inside dashboard before ruling.",
    "Unit tests verify form validation and transaction dispatch."
  )

Register-Issue -Id 62 `
  -Title "feat(dashboard): add browser Web Notifications API for background job status alerts" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,notifications" `
  -Difficulty "Medium" `
  -Skills "JavaScript, Web Notifications API, Service Worker" `
  -Summary "Integrate HTML5 Web Notifications in dashboard/public/app.js to alert users with system desktop notifications when their jobs are funded, submitted, or approved while browsing other tabs." `
  -Motivation "Agent jobs often take several minutes to complete. Users currently have to keep the dashboard tab open and watch it manually to know when their deliverable is ready or when funds have been released." `
  -Implementation "1. Request Notification.requestPermission() on user opt-in.`r`n2. In event poller / SSE stream, when an event matching user's wallet address arrives, spawn Notification.`r`n3. Clicking notification focuses the dashboard browser tab and opens the specific job detail view.`r`n4. Provide notification preferences toggle in dashboard settings." `
  -AcceptanceCriteria @(
    "Desktop notification triggers promptly upon relevant job state transitions.",
    "Respects user permission grant/denial without repeated prompts.",
    "Clicking notification directs user to the exact target job.",
    "Works across Chrome, Firefox, Edge, and Safari."
  )

Register-Issue -Id 63 `
  -Title "feat(dashboard): enhance agent search with multi-tag filtering, sorting, and debounced input" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,search,ux" `
  -Difficulty "Medium" `
  -Skills "JavaScript, UX, Search" `
  -Summary "Upgrade agent search in dashboard/public/app.js:L40 with multi-tag filtering, sorting by rating/price/recency, and 300ms debounced keystroke handling." `
  -Motivation "The current search filter only matches raw strings against agent name. As the registry grows to hundreds of agents, users cannot filter by category (e.g. 'Research', 'Design'), sort by lowest fee, or view newly added agents." `
  -Implementation "1. Parse tags from agent metadata and render clickable filter pills above the agent grid.`r`n2. Add sort dropdown: 'Most Active', 'Highest Rated', 'Lowest Fee', 'Newest'.`r`n3. Debounce input using existing debounce helper to avoid re-rendering DOM on every character.`r`n4. Display 'No agents found matching criteria' empty state with clear filters button." `
  -AcceptanceCriteria @(
    "Filtering by multiple tags narrows search results instantly.",
    "Sorting orders agents correctly according to selected criteria.",
    "Zero input lag or DOM stuttering during rapid typing.",
    "Filters persist in URL search params for shareable links."
  )

Register-Issue -Id 64 `
  -Title "feat(dashboard): add live wallet balance widget with one-click testnet friendbot faucet button" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,developer-experience" `
  -Difficulty "Medium" `
  -Skills "JavaScript, Stellar SDK, Testnet" `
  -Summary "Add a live wallet balance badge in the dashboard sidebar showing XLM and USDC balances with a one-click 'Fund via Friendbot' button for testnet wallets." `
  -Motivation "Developers testing the demo frequently run out of testnet XLM for transaction fees or testnet USDC for escrow budgets, requiring them to open a terminal or find external faucet links." `
  -Implementation "1. Fetch wallet XLM balance via Horizon server.loadAccount().`r`n2. Fetch wallet USDC balance via Soroban token client (balanceScVal).`r`n3. Add 'Faucet' button that triggers Friendbot API call: `https://friendbot.stellar.org/?addr=...`.`r`n4. Refresh balance display automatically after funding completes." `
  -AcceptanceCriteria @(
    "Sidebar displays live XLM and USDC balances formatted to 2 decimal places.",
    "Clicking Faucet funds wallet with 10,000 testnet XLM within 5 seconds.",
    "Button shows loading spinner and disables during funding to prevent spam.",
    "Hidden automatically when connected to Stellar Mainnet."
  )

Register-Issue -Id 65 `
  -Title "feat(dashboard): implement accounting export feature for wallet transaction history" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,enhancement" `
  -Difficulty "Medium" `
  -Skills "JavaScript, CSV, Frontend" `
  -Summary "Add an 'Export History' button in the dashboard Transaction History view allowing users to download their complete escrow activity as a CSV file." `
  -Motivation "Users managing multiple client or provider agents need an easy way to export their transaction records directly from the frontend for accounting and book-keeping without interacting with backend APIs." `
  -Implementation "1. Add 'Export CSV' button above the transaction history list in app.js.`r`n2. Convert filtered job and payment records into formatted CSV data.`r`n3. Create downloadable Blob with dynamic filename: `bear-transactions-[wallet]-[date].csv`.`r`n4. Trigger browser download automatically." `
  -AcceptanceCriteria @(
    "Generates clean CSV file with headers: Date, Job ID, Type, Counterparty, Amount, Status, TxHash.",
    "Respects active user search and date filters in exported data.",
    "Tested with 1,000+ transaction rows without browser freezing.",
    "Verified in Excel and Google Sheets without encoding errors."
  )

Register-Issue -Id 66 `
  -Title "fix(dashboard): eliminate flash of unstyled content (FOUC) during theme initialization" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,bug,ui" `
  -Difficulty "Medium" `
  -Skills "HTML, CSS, JavaScript, Performance" `
  -Summary "Move theme initialization script to the head of dashboard/public/index.html to prevent flash of light theme when reloading in dark mode." `
  -Motivation "In dashboard/public/app.js:L8-L29, theme initialization runs inside the deferred app.js bundle at the bottom of the body. When a user with dark mode reloads the page, the browser renders the default light CSS for 200-300ms before flashing into dark mode." `
  -Implementation "1. Extract initTheme() into an inline blocking script inside `<head>` in index.html.`r`n2. Read localStorage('bear-theme') or prefers-color-scheme immediately before CSS renders.`r`n3. Set data-theme attribute on `<html>` tag before DOM content loads.`r`n4. Test page reload under 3G throttling to verify zero theme flicker." `
  -AcceptanceCriteria @(
    "Zero flash of unstyled or mismatched theme colors during page load.",
    "Dark theme active on the very first painted frame.",
    "Theme toggle button in sidebar still functions seamlessly.",
    "Verified in Chrome DevTools Performance paint profiler."
  )

Register-Issue -Id 67 `
  -Title "feat(dashboard): add global keyboard navigation shortcuts for frequent escrow operations" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,accessibility,ux" `
  -Difficulty "Medium" `
  -Skills "JavaScript, Keyboard UX, Accessibility" `
  -Summary "Implement keyboard hotkeys (e.g., '/' to search, 'n' for new job, 'r' to refresh, 'Esc' to close modals) across the dashboard interface." `
  -Motivation "Power users managing dozens of agent jobs per day lose significant time moving between keyboard and mouse for repetitive actions like searching, refreshing, and closing modals." `
  -Implementation "1. Create KeyboardShortcutManager in app.js listening to window keydown events.`r`n2. Ignore hotkeys when user is typing inside text inputs or textareas.`r`n3. Bind shortcuts: '/' -> focus search bar, 'n' -> open create job modal, 'r' -> refresh data, 'Esc' -> close active modal, '?' -> show keyboard shortcut cheat sheet.`r`n4. Render accessible keyboard shortcut legend in settings modal." `
  -AcceptanceCriteria @(
    "Key combinations trigger corresponding UI actions reliably.",
    "Shortcuts disabled while typing inside form inputs.",
    "'?' key displays visual keyboard shortcut helper modal.",
    "Cross-platform support (Mac Cmd vs Windows Ctrl)."
  )

Register-Issue -Id 68 `
  -Title "feat(dashboard): create dedicated agent public profile pages with verified on-chain badges" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,ui" `
  -Difficulty "Medium" `
  -Skills "JavaScript, HTML, CSS, Web3 UI" `
  -Summary "Build dedicated standalone agent profile views at /app#/agent/:id in dashboard/public/app.js displaying full agent bio, verified badges, rating breakdown, and direct hire button." `
  -Motivation "Currently, clicking an agent card only expands a small inline modal. Agents cannot share a permanent link to their public storefront or display their full portfolio, reviews, and on-chain credential badges." `
  -Implementation "1. Update dashboard client-side router to handle `#/agent/:id` route.`r`n2. Render dedicated Agent Profile view: Banner, Avatar, Verified Badges, Bio, Pricing Schedule, Capabilities, and Recent Job History.`r`n3. Add 'Hire Agent' primary call-to-action button opening pre-filled escrow creation form.`r`n4. Generate OpenGraph meta tags for rich social link previews." `
  -AcceptanceCriteria @(
    "Direct URL /app#/agent/1 loads the correct agent profile cleanly.",
    "Displays verified cryptographic badges from agent-identity contract.",
    "Includes shareable link with one-click copy button.",
    "Responsive layout optimized for mobile and desktop."
  )

Register-Issue -Id 69 `
  -Title "feat(dashboard): add dynamic network switcher between Testnet, Futurenet, and Mainnet" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,enhancement" `
  -Difficulty "Medium" `
  -Skills "JavaScript, Stellar SDK, Architecture" `
  -Summary "Implement a network selector dropdown in dashboard navigation header allowing seamless switching between Stellar Testnet, Futurenet, and Mainnet." `
  -Motivation "Contract addresses and RPC endpoints are currently hardcoded to testnet in lib/config.ts. Testing against Futurenet (for bleeding-edge Soroban features) or mainnet requires code edits and rebuilding." `
  -Implementation "1. Define network presets in config: Testnet, Futurenet, Mainnet with corresponding contract addresses, passphrases, and RPC URLs.`r`n2. Add network dropdown badge in top navigation bar.`r`n3. Switching network reconfigures SDK clients, clears cache, and prompts wallet network change.`r`n4. Display prominent warning banner when connected to Mainnet (Real USDC)." `
  -AcceptanceCriteria @(
    "User can switch between Testnet, Futurenet, and Mainnet on the fly.",
    "Contract addresses dynamically update to match selected network.",
    "Warns user if wallet network differs from selected dashboard network.",
    "Selected network persisted in localStorage."
  )

Register-Issue -Id 70 `
  -Title "perf(dashboard): implement virtualized scrolling for high-volume job and event feeds" `
  -Category "Frontend & Dashboard" `
  -Labels "dashboard,frontend,performance" `
  -Difficulty "Medium" `
  -Skills "JavaScript, DOM Virtualization, Performance" `
  -Summary "Implement a virtualized DOM list renderer in dashboard/public/app.js to smoothly display lists with thousands of historical jobs and events without browser memory lag." `
  -Motivation "Currently, all job and event rows are rendered as direct DOM elements. When viewing 500+ historical records, DOM node count exceeds 5,000, causing scroll stuttering and heavy mobile browser memory consumption." `
  -Implementation "1. Implement VirtualList helper rendering only visible items + 5 buffer items above/below viewport.`r`n2. Dynamically calculate container scroll height based on item heights.`r`n3. Recycle DOM elements as user scrolls up and down.`r`n4. Maintain smooth 60 FPS scrolling performance under 10,000 simulated jobs." `
  -AcceptanceCriteria @(
    "Total active DOM nodes capped below 100 regardless of total list size.",
    "Scroll performance maintains consistent 60 FPS on mobile and low-end devices.",
    "Dynamic search filtering and sorting remain fully responsive.",
    "Memory consumption reduced by >70% for large lists."
  )

Write-Host "Frontend & Dashboard registered."

Write-Host "Registering Category 4: Packages & React SDK (Issues 71-85)..."

Register-Issue -Id 71 `
  -Title "feat(react): implement useJob hook for reactive on-chain job status synchronization" `
  -Category "Packages & React SDK" `
  -Labels "packages,react,sdk,enhancement" `
  -Difficulty "Medium" `
  -Skills "TypeScript, React, SDK" `
  -Summary "Create a dedicated useJob(jobId) hook in packages/react/src/hooks/useJob.ts providing reactive, polling-backed synchronization for a specific escrow job." `
  -Motivation "Currently, packages/react/src/hooks only contains useAgent.ts. React developers building custom web3 applications have no turnkey hook to track job status, fetch deliverables, and trigger lifecycle transitions." `
  -Implementation "1. Create packages/react/src/hooks/useJob.ts.`r`n2. Interface UseJobResult: { job: Job | null, loading: boolean, error: Error | null, refetch: () => Promise<void> }.`r`n3. Support optional pollIntervalMs option for background polling while job is active.`r`n4. Export from packages/react/src/index.ts." `
  -AcceptanceCriteria @(
    "useJob hook fetches and returns strongly typed Job object from on-chain contract.",
    "Automatically updates when job status changes from Funded to Completed.",
    "Cleans up background polling timers on component unmount.",
    "Unit tests with mock Soroban RPC demonstrate state transitions."
  )

Register-Issue -Id 72 `
  -Title "feat(react): implement useCommerce hook for programmatic escrow creation and settlement" `
  -Category "Packages & React SDK" `
  -Labels "packages,react,sdk,enhancement" `
  -Difficulty "Medium" `
  -Skills "TypeScript, React, Soroban SDK" `
  -Summary "Build a comprehensive useCommerce() hook in packages/react/src/hooks/useCommerce.ts exposing high-level methods: createJob, submitJob, completeJob, and cancelJob with in-flight state tracking." `
  -Motivation "Developers using @marc-stellar/react currently have to instantiate CommerceClient manually, handle ScVal serialization, and manage separate loading/error states for every transaction." `
  -Implementation "1. Implement useCommerce() hook returning { createJob, submitJob, completeJob, cancelJob, isPending, txHash, error }.`r`n2. Handle wallet signing integration seamlessly via ambient wallet context.`r`n3. Expose pre-flight simulation and estimated gas fee calculation.`r`n4. Export comprehensive TypeScript typings." `
  -AcceptanceCriteria @(
    "Enables one-line job creation: `const { createJob } = useCommerce(); await createJob(...)`.",
    "isPending boolean updates accurately during transaction lifecycle.",
    "Returns transaction hash upon successful on-chain confirmation.",
    "Unit tests verify method execution and error handling."
  )

Register-Issue -Id 73 `
  -Title "feat(react): implement usePaymentChannel hook for off-chain micropayment management" `
  -Category "Packages & React SDK" `
  -Labels "packages,react,sdk,micropayments" `
  -Difficulty "Hard" `
  -Skills "TypeScript, React, Payment Channels" `
  -Summary "Build a usePaymentChannel(channelId) React hook in packages/react/src/hooks/usePaymentChannel.ts for opening, voucher signing, and closing off-chain micropayment channels." `
  -Motivation "Payment channels are essential for high-frequency AI agent interactions (100s of queries/minute). Integrating channels into React apps currently requires manual voucher cryptography and state management." `
  -Implementation "1. Create usePaymentChannel hook with methods: openChannel, createVoucher, verifyVoucher, closeChannel, forceClose.`r`n2. Maintain local monotonic voucher nonce counter in memory/localStorage.`r`n3. Compute Ed25519 voucher signatures off-chain instantly.`r`n4. Track channel deposit balance and remaining spent allowance." `
  -AcceptanceCriteria @(
    "Generates valid cryptographic vouchers off-chain in <5ms.",
    "Provides real-time channel utilization percentage (spent vs deposit).",
    "Handles cooperative and dispute closure workflows.",
    "Unit tests verify voucher generation and verification in React environment."
  )

Register-Issue -Id 74 `
  -Title "feat(react): implement useWallet hook for seamless Stellar wallet connection management" `
  -Category "Packages & React SDK" `
  -Labels "packages,react,sdk,web3" `
  -Difficulty "Medium" `
  -Skills "TypeScript, React, Stellar Wallets Kit" `
  -Summary "Create a unified useWallet() hook and WalletProvider context in packages/react/src/context/WalletContext.tsx supporting multi-wallet connection and balance tracking." `
  -Motivation "Developers integrating @marc-stellar/react must currently implement their own wallet connection logic or write boilerplate Stellar Wallets Kit event listeners." `
  -Implementation "1. Build WalletProvider wrapping applications with wallet context.`r`n2. Expose useWallet() returning { address, connected, walletType, balance, connect, disconnect, signTransaction }.`r`n3. Listen to wallet account and network change events automatically.`r`n4. Auto-reconnect previously connected wallet on page load." `
  -AcceptanceCriteria @(
    "Clean hook API: `const { address, connect } = useWallet();`.",
    "Supports Freighter, xBull, and Albedo wallets out of the box.",
    "Synchronizes XLM and USDC token balances automatically.",
    "Unit tests with mock wallet adapter verify connection and disconnection flows."
  )

Register-Issue -Id 75 `
  -Title "feat(react): implement useAgentSearch hook with client-side fuzzy searching and caching" `
  -Category "Packages & React SDK" `
  -Labels "packages,react,sdk,search" `
  -Difficulty "Medium" `
  -Skills "TypeScript, React, Search, Algorithms" `
  -Summary "Create a useAgentSearch() hook in packages/react/src/hooks/useAgentSearch.ts providing fast client-side fuzzy searching, filtering, and tag classification." `
  -Motivation "Applications displaying agent directories need an efficient way to search and filter agents without making repeated backend API calls on every keystroke." `
  -Implementation "1. Implement useAgentSearch(agents, { keys: ['name', 'description', 'tags'] }).`r`n2. Incorporate lightweight Bitap/Levenshtein fuzzy matching algorithm.`r`n3. Support tag intersection and minimum reputation score filters.`r`n4. Return ranked matching results with highlighted match offsets." `
  -AcceptanceCriteria @(
    "Fuzzy search tolerates minor typos (e.g. 'resercher' matches 'researcher').",
    "Sub-millisecond search execution for lists of up to 1,000 agents.",
    "Returns matched results sorted by relevance score.",
    "Comprehensive unit tests verify search accuracy and edge cases."
  )

Register-Issue -Id 76 `
  -Title "feat(react): implement useJobEvents hook with real-time event streaming subscriptions" `
  -Category "Packages & React SDK" `
  -Labels "packages,react,sdk,events" `
  -Difficulty "Medium" `
  -Skills "TypeScript, React, SSE, WebSockets" `
  -Summary "Build useJobEvents(jobId) hook in packages/react/src/hooks/useJobEvents.ts subscribing to live contract event streams via Server-Sent Events or WebSockets." `
  -Motivation "Relying strictly on polling introduces latency and server strain. A reactive event hook allows React components to receive instantaneous push updates the moment an on-chain event is indexed." `
  -Implementation "1. Create useJobEvents hook connecting to backend /api/events/stream SSE endpoint.`r`n2. Filter events matching specified jobId or agent address topic.`r`n3. Maintain chronological events array: { eventType, timestamp, ledger, payload }[].`r`n4. Automatically manage SSE connection lifecycle and reconnection backoff." `
  -AcceptanceCriteria @(
    "Component receives new event within 100ms of indexer ingestion.",
    "Gracefully handles network disconnections and resumes without duplicate events.",
    "Proper cleanup: closes EventSource stream on unmount.",
    "Unit tests mock SSE server and verify event append behavior."
  )

Register-Issue -Id 77 `
  -Title "feat(react): create turnkey UI component library (@marc-stellar/react-ui)" `
  -Category "Packages & React SDK" `
  -Labels "packages,react,ui,design-system" `
  -Difficulty "Medium" `
  -Skills "TypeScript, React, CSS, Design System" `
  -Summary "Build a suite of pre-styled accessible React UI components in packages/react/src/components/ including AgentCard, JobStatusBadge, EscrowStepper, and TokenBalanceBadge." `
  -Motivation "Developers building applications on Bear Protocol currently have to design and build all UI elements from scratch. Providing drop-in React components ensures visual consistency and speeds up dapp creation." `
  -Implementation "1. Implement `<AgentCard agent={agent} onHire={...} />`.`r`n2. Implement `<JobStatusBadge status={status} />` with animated status colors.`r`n3. Implement `<EscrowStepper currentStep={step} />`.`r`n4. Implement `<TokenBalanceBadge address={address} token='USDC' />`.`r`n5. Use Vanilla CSS with CSS variable theming matching Bear design system." `
  -AcceptanceCriteria @(
    "Components render beautifully in both light and dark mode.",
    "Fully typed prop interfaces with JSDoc comments.",
    "Zero external UI framework dependencies (pure CSS modules).",
    "Tested with keyboard navigation and screen readers."
  )

Register-Issue -Id 78 `
  -Title "feat(react): implement customizable WalletConnectButton component with multi-wallet modal" `
  -Category "Packages & React SDK" `
  -Labels "packages,react,ui,web3" `
  -Difficulty "Medium" `
  -Skills "TypeScript, React, Web3 UI" `
  -Summary "Build a drop-in `<WalletConnectButton />` React component in packages/react/src/components/WalletConnectButton.tsx with customizable triggers, avatar badges, and wallet selection modal." `
  -Motivation "Connecting a Stellar wallet is the primary onboarding step for any web3 application. A pre-built, elegant connect button saves hours of frontend integration effort for third-party developers." `
  -Implementation "1. Create `<WalletConnectButton className='...' onConnect={...} />`.`r`n2. When disconnected, shows 'Connect Wallet' with brand icon.`r`n3. When connected, displays truncated address (GABC...XYZ), avatar glyph, and balance.`r`n4. Clicking opens dropdown menu: Copy Address, View on Explorer, Switch Wallet, Disconnect." `
  -AcceptanceCriteria @(
    "Single-line integration: `<WalletConnectButton />` works out of the box.",
    "Responsive modal with Freighter, xBull, and Albedo provider options.",
    "Accessible focus management and keyboard controls.",
    "Supports custom CSS styling overrides."
  )

Register-Issue -Id 79 `
  -Title "fix(react): ensure full SSR compatibility and Next.js App Router support for React hooks" `
  -Category "Packages & React SDK" `
  -Labels "packages,react,nextjs,ssr,bug" `
  -Difficulty "Medium" `
  -Skills "TypeScript, React, Next.js, SSR" `
  -Summary "Audit and resolve window/document reference errors across @marc-stellar/react to guarantee seamless server-side rendering (SSR) in Next.js 14+ App Router." `
  -Motivation "Stellar SDKs and wallet connectors often reference window or localStorage during module evaluation. Importing @marc-stellar/react in Next.js server components currently triggers 'window is not defined' hydration errors." `
  -Implementation "1. Add 'use client' directives at the top of all React hook and component entry points.`r`n2. Guard all window, document, and localStorage calls with typeof window !== 'undefined' checks.`r`n3. Ensure initial SSR render matches client hydration state to avoid React mismatch warnings.`r`n4. Add Next.js 14 sample app in demo/nextjs-app to verify clean SSR compilation." `
  -AcceptanceCriteria @(
    "Zero 'window is not defined' errors during Next.js build or SSR runtime.",
    "Hydration succeeds with zero console warnings.",
    "Works out of the box in both Pages Router and App Router.",
    "CI builds Next.js test application successfully."
  )

Register-Issue -Id 80 `
  -Title "perf(react): optimize package bundle size with tree-shaking and zero external heavy dependencies" `
  -Category "Packages & React SDK" `
  -Labels "packages,react,performance,build" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Rollup, Bundlephobia, Tree-shaking" `
  -Summary "Configure tsup/Rollup bundling in packages/react/tsup.config.ts for optimal tree-shaking, keeping the total minified bundle size under 15 KB gzipped." `
  -Motivation "Developers are sensitive to package bundle bloat in web applications. Bundling entire Stellar SDKs or unnecessary dependencies into the React package degrades page load speed and core web vitals." `
  -Implementation "1. Configure ESM and CJS dual output in packages/react/tsup.config.ts.`r`n2. Mark @stellar/stellar-sdk, react, and react-dom as peerDependencies.`r`n3. Enable sideEffects: false in package.json to unlock full bundler tree-shaking.`r`n4. Add bundlesize CI check to enforce 15 KB limit." `
  -AcceptanceCriteria @(
    "Minified + gzipped bundle size remains below 15 KB.",
    "Tree-shaking verified: unused hooks are completely stripped from final consumer bundle.",
    "Exports clean TypeScript declaration files (.d.ts).",
    "CI checks bundle size on every pull request."
  )

Register-Issue -Id 81 `
  -Title "test(react): build comprehensive React hook test suite with React Testing Library and mock RPC" `
  -Category "Packages & React SDK" `
  -Labels "packages,react,testing" `
  -Difficulty "Medium" `
  -Skills "TypeScript, React, Vitest, Testing Library" `
  -Summary "Create a robust unit test suite for all hooks in packages/react/ using Vitest and React Testing Library with mocked Soroban RPC responses." `
  -Motivation "Currently in packages/react, tests are minimal. Changes to SDK client logic risk breaking React hook state machines without automated test coverage." `
  -Implementation "1. Configure Vitest with jsdom environment in packages/react/vitest.config.ts.`r`n2. Write unit tests for useAgent, useJob, useCommerce, and useWallet using renderHook.`r`n3. Mock IdentityClient and CommerceClient responses to simulate loading, success, and error states.`r`n4. Test unmount cleanup and dependency change race condition prevention." `
  -AcceptanceCriteria @(
    "Test coverage exceeds 90% across all React hooks and components.",
    "All tests run fast in under 5 seconds via Vitest.",
    "Verifies proper error handling when RPC fails.",
    "Integrated into root npm test script."
  )

Register-Issue -Id 82 `
  -Title "docs(react): build interactive Storybook showcase for React components and hooks" `
  -Category "Packages & React SDK" `
  -Labels "packages,react,documentation,storybook" `
  -Difficulty "Medium" `
  -Skills "TypeScript, React, Storybook, Documentation" `
  -Summary "Set up Storybook in packages/react/.storybook to showcase all UI components and interactive hook demonstrations with live controls." `
  -Motivation "Third-party developers evaluating @marc-stellar/react need a visual catalog where they can inspect component variants, test different theme states, and see live code examples." `
  -Implementation "1. Install and configure Storybook 8 in packages/react/.`r`n2. Create stories for AgentCard (active, offline, verified badges).`r`n3. Create stories for JobStatusBadge (Funded, Submitted, Completed, Disputed).`r`n4. Create stories for EscrowStepper and WalletConnectButton.`r`n5. Build static Storybook site and deploy to GitHub Pages." `
  -AcceptanceCriteria @(
    "Storybook builds cleanly with `npm run storybook`.",
    "All components documented with interactive controls and dark/light mode toggles.",
    "Includes copy-pasteable code snippets for every component.",
    "Exported as static documentation site in CI."
  )

Register-Issue -Id 83 `
  -Title "feat(react): add automatic request deduplication and SWR caching in useAgent hook" `
  -Category "Packages & React SDK" `
  -Labels "packages,react,performance,cache" `
  -Difficulty "Medium" `
  -Skills "TypeScript, React, Caching, SWR" `
  -Summary "Enhance useAgent in packages/react/src/hooks/useAgent.ts with stale-while-revalidate (SWR) caching and in-flight request deduplication." `
  -Motivation "In packages/react/src/hooks/useAgent.ts:L34-L60, every mounting component triggers an independent getAgent() RPC call. When displaying an agent directory with multiple components referencing the same agent, duplicate network requests waste bandwidth and hit RPC rate limits." `
  -Implementation "1. Implement a shared memory cache `Map<string, { data: Agent, timestamp: number }>` in useAgent.ts.`r`n2. Implement in-flight promise deduplication: parallel requests for agentId share a single Promise.`r`n3. Return cached data immediately (stale) while fetching fresh data in the background (revalidate).`r`n4. Provide configurable ttlMs option (default: 60,000ms)." `
  -AcceptanceCriteria @(
    "Mounting 10 components with the same agentId triggers exactly 1 network RPC call.",
    "Cached data renders instantly on page navigation with zero loading flicker.",
    "Background revalidation keeps data synchronized.",
    "Unit tests verify deduplication and cache eviction."
  )

Register-Issue -Id 84 `
  -Title "refactor(react): audit and export exhaustive TypeScript types and prop interfaces" `
  -Category "Packages & React SDK" `
  -Labels "packages,react,typescript,refactor" `
  -Difficulty "Medium" `
  -Skills "TypeScript, SDK, API Design" `
  -Summary "Audit packages/react/src/index.ts to ensure all hook options, return types, component props, and contract enums are cleanly re-exported without leaking internal types." `
  -Motivation "Consumers importing @marc-stellar/react frequently encounter missing type exports or conflicting type definitions between the SDK core and the React package." `
  -Implementation "1. Review all exported interfaces: UseAgentOptions, UseAgentResult, UseJobResult, UseCommerceResult, etc.`r`n2. Re-export essential core types (Agent, Job, JobStatus, MarcConfig) directly from marc-stellar-sdk.`r`n3. Ensure strict TypeScript 5.6 compatibility with isolatedModules and declarationMap enabled.`r`n4. Verify zero TypeScript errors in a consumer project import test." `
  -AcceptanceCriteria @(
    "All public hooks and components have 100% strictly typed prop interfaces.",
    "TypeScript autocomplete and IntelliSense work seamlessly in VS Code.",
    "Zero implicit `any` types throughout package.",
    "Validated with `tsc --noEmit` in CI."
  )

Register-Issue -Id 85 `
  -Title "docs(react): create comprehensive Next.js and Vite quickstart starter templates" `
  -Category "Packages & React SDK" `
  -Labels "packages,react,documentation,developer-experience" `
  -Difficulty "Medium" `
  -Skills "TypeScript, React, Next.js, Vite, Quickstart" `
  -Summary "Provide plug-and-play starter repository templates in examples/nextjs-starter and examples/vite-starter demonstrating how to build an agent commerce dapp in under 5 minutes." `
  -Motivation "Developers learn fastest by cloning a working example. Having clean, modern starter projects lowers the barrier to entry and encourages hackathon participants to build on Bear Protocol." `
  -Implementation "1. Build examples/vite-starter with React 18, Tailwind/Vanilla CSS, and @marc-stellar/react.`r`n2. Build examples/nextjs-starter with Next.js 14 App Router, Server Actions, and wallet connection.`r`n3. Include pre-built pages: Agent Directory, Job Escrow Creation, and Status Tracking.`r`n4. Include one-click deploy buttons for Vercel and Netlify in README." `
  -AcceptanceCriteria @(
    "Both templates clone, install, and run locally in under 60 seconds.",
    "Complete end-to-end workflow: connect wallet -> browse agents -> fund job -> view status.",
    "Comprehensive README with step-by-step tutorial.",
    "Verified in CI with automated build smoke tests."
  )

Write-Host "Packages & React SDK registered."

Write-Host "Registering Category 5: SDK, Security, DevOps & Infrastructure (Issues 86-100)..."

Register-Issue -Id 86 `
  -Title "sec(dashboard): configure strict Content Security Policy (CSP) headers in dashboard/server.ts" `
  -Category "SDK & Security" `
  -Labels "security,dashboard,backend" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Express, Helmet, Web Security" `
  -Summary "Resolve disabled Content Security Policy in dashboard/server.ts:L48-L50 by implementing fine-grained CSP directives with nonces and sha256 script hashes." `
  -Motivation "In dashboard/server.ts:L50, app.use(helmet({ contentSecurityPolicy: false })) completely disables CSP because external CDN scripts and Google Fonts were blocked. Running without CSP exposes all wallet-connected users to Cross-Site Scripting (XSS) and token theft." `
  -Implementation "1. Generate crypto cryptographic nonce per request using crypto.randomBytes(16).`r`n2. Configure Helmet CSP with script-src allowing 'self', nonces, and approved wallet CDN domains (jsdelivr.net, unpkg.com).`r`n3. Configure connect-src allowing Stellar RPC endpoints, Horizon, and IPFS gateways.`r`n4. Configure style-src allowing 'self', Google Fonts, and inline style nonces.`r`n5. Enforce object-src 'none' and base-uri 'self'." `
  -AcceptanceCriteria @(
    "Strict CSP enabled without breaking dashboard wallet kit, fonts, or RPC calls.",
    "Zero inline script execution permitted without valid nonce.",
    "SecurityHeaders.com audit score improves from Grade F to Grade A+.",
    "Automated tests verify CSP header presence on all HTTP responses."
  )

Register-Issue -Id 87 `
  -Title "feat(sdk): implement Server-Sent Events (SSE) payment chunking in marcFetch for LLM streaming" `
  -Category "SDK & Security" `
  -Labels "sdk,x402,streaming,enhancement" `
  -Difficulty "Hard" `
  -Skills "TypeScript, x402, HTTP Streaming, LLMs" `
  -Summary "Enhance marcFetch in sdk/src/marcFetch.ts to support streaming HTTP responses with incremental micropayments (pay-per-token / pay-per-chunk) for generative AI agent APIs." `
  -Motivation "Currently, marcFetch pays a single upfront micropayment before receiving a complete response. For long-running generative LLM tasks (streaming responses over 30 seconds), clients risk paying upfront for aborted streams, or providers risk unpaid token generation." `
  -Implementation "1. Implement streaming paywall client in sdk/src/marcFetch.ts.`r`n2. Read ReadableStream chunks from HTTP response.`r`n3. Support mid-stream HTTP 402 challenge frames or payment channel voucher replenishment every N tokens.`r`n4. Provide consumer callback onChunk(chunk) yielding tokens as they arrive.`r`n5. Gracefully settle net consumed tokens on stream close." `
  -AcceptanceCriteria @(
    "marcFetch streams tokens in real-time while paying incrementally via vouchers.",
    "Aborting stream immediately halts further payments without overpaying.",
    "Compatible with OpenAI and Anthropic streaming API formats.",
    "Integration tests simulate streaming LLM generation with incremental settlements."
  )

Register-Issue -Id 88 `
  -Title "feat(sdk): add offline transaction preparation and unsigned XDR serialization in marc-stellar-sdk" `
  -Category "SDK & Security" `
  -Labels "sdk,security,developer-experience" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Stellar SDK, Cold Storage" `
  -Summary "Add prepareJobTransaction methods to CommerceClient and IdentityClient in sdk/src/ to return unsigned transaction XDR strings for offline signing and multisig workflows." `
  -Motivation "Currently, CommerceClient methods (createJob, complete) require passing a live Keypair and immediately submit the transaction to the network. Enterprise custodians and multisig vaults require separating transaction assembly from signing." `
  -Implementation "1. Add prepareCreateJob(clientAddress, provider, evaluator, token, budget, description) -> Promise<string> (unsigned XDR).`r`n2. Add prepareSubmit(providerAddress, jobId, deliverable) -> Promise<string>.`r`n3. Add prepareComplete(evaluatorAddress, jobId) -> Promise<string>.`r`n4. Add submitSignedXdr(signedXdr: string) -> Promise<TransactionResult>.`r`n5. Export utility to decode and inspect unsigned Soroban contract invocations." `
  -AcceptanceCriteria @(
    "Returns valid unsigned XDR without requiring access to private keys.",
    "Unsigned XDR can be signed by external cold wallet (Ledger / Multisig) and submitted.",
    "Comprehensive unit tests verify XDR assembly and simulation.",
    "SDK documentation updated with air-gapped signing examples."
  )

Register-Issue -Id 89 `
  -Title "feat(sdk): implement multi-RPC endpoint health check and automated failover in baseClient.ts" `
  -Category "SDK & Security" `
  -Labels "sdk,reliability,infrastructure" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Stellar RPC, High Availability" `
  -Summary "Enhance BaseClient in sdk/src/baseClient.ts with automatic health checking, exponential backoff, and transparent failover across a list of fallback Stellar RPC endpoints." `
  -Motivation "Public Soroban RPC endpoints occasionally experience rate limiting, network degradation, or temporary downtime. If the primary RPC URL fails, all SDK operations crash even if secondary backup RPC providers are healthy." `
  -Implementation "1. Update MarcConfig to accept rpcUrls: string[] array.`r`n2. Implement RpcFailoverPool tracking health status, latency, and consecutive failures per endpoint.`r`n3. When an RPC call fails with 5xx or network timeout, automatically retry with next candidate.`r`n4. Periodically probe degraded endpoints in the background to restore them to active rotation." `
  -AcceptanceCriteria @(
    "Transparent failover to secondary RPC within 500ms of primary failure.",
    "Round-robin or lowest-latency routing across healthy RPC endpoints.",
    "Zero runtime exceptions thrown to consumer if at least one RPC node is operational.",
    "Unit tests simulate RPC failure and verify failover execution."
  )

Register-Issue -Id 90 `
  -Title "test(contracts): implement automated Soroban contract fuzzing suite with cargo-fuzz" `
  -Category "SDK & Security" `
  -Labels "contracts,security,fuzzing" `
  -Difficulty "Hard" `
  -Skills "Rust, cargo-fuzz, Security, Soroban" `
  -Summary "Build an automated fuzzing harness using cargo-fuzz / libFuzzer in contracts/fuzz/ to subject Soroban contract parsers and state transition logic to millions of randomized inputs." `
  -Motivation "Smart contract logic must be resilient against edge cases, unexpected string encodings, integer boundaries, and adversarial payloads. Fuzz testing identifies hidden panics and memory leaks that standard unit tests miss." `
  -Implementation "1. Set up cargo-fuzz in contracts/fuzz/.`r`n2. Define fuzz target for agent-identity register() and update_uri() testing arbitrary UTF-8/binary strings.`r`n3. Define fuzz target for agentic-commerce create_job(), submit(), and voucher verification.`r`n4. Integrate cargo fuzz into continuous security scanning pipeline." `
  -AcceptanceCriteria @(
    "Fuzz targets run >1,000,000 iterations without discovering unhandled panics or memory crashes.",
    "Enforces strict bounds: oversized inputs rejected with clean contract errors.",
    "Documented fuzzing runbook in contracts/FUZZING.md.",
    "Automated 10-minute fuzzing smoke check included in nightly CI."
  )

Register-Issue -Id 91 `
  -Title "ci: add GitHub Actions matrix testing against Soroban Protocol 20, 21, and 22" `
  -Category "DevOps & CI/CD" `
  -Labels "devops,ci,stellar" `
  -Difficulty "Medium" `
  -Skills "GitHub Actions, CI/CD, Stellar Protocol" `
  -Summary "Configure a GitHub Actions matrix workflow in .github/workflows/protocol-matrix.yml testing contract builds and SDK compatibility across Soroban Protocol versions." `
  -Motivation "Stellar network upgrades (Protocol 20 -> 21 -> 22) introduce new XDR types, cost models, and host functions. Testing against only a single protocol version leaves the codebase vulnerable to breaking changes during network upgrades." `
  -Implementation "1. Create .github/workflows/protocol-matrix.yml with matrix: [protocol-20, protocol-21, protocol-22].`r`n2. Download corresponding stellar-cli and soroban-sdk versions.`r`n3. Run cargo test and stellar contract build --optimize across all matrix combinations.`r`n4. Report compatibility status badge in README." `
  -AcceptanceCriteria @(
    "CI matrix tests all active Stellar protocol versions automatically on pull requests.",
    "Alerts maintainers in advance if upcoming protocol upgrade breaks contract syntax.",
    "Build times optimized with aggressive Cargo caching.",
    "All matrix jobs pass green in CI."
  )

Register-Issue -Id 92 `
  -Title "ci: add automated WASM instruction count and CPU gas profiling regression checks" `
  -Category "DevOps & CI/CD" `
  -Labels "devops,ci,performance,contracts" `
  -Difficulty "Medium" `
  -Skills "GitHub Actions, Rust, Gas Profiling" `
  -Summary "Create a CI workflow checking Soroban CPU instructions and memory byte consumption on every PR, failing if a commit introduces a gas regression >10%." `
  -Motivation "Unintentional algorithmic regressions or inefficient data structure serialization can drastically increase transaction costs for users without triggering unit test failures." `
  -Implementation "1. Create benchmark script scripts/profile-gas.sh measuring CPU instructions for all contract entry points.`r`n2. Record baseline gas numbers in .gas-baseline.json.`r`n3. In GitHub Actions, run benchmark on PR branch and compare against baseline.`r`n4. Post automated markdown comment on PR summarizing gas diffs and fail if regression >10%." `
  -AcceptanceCriteria @(
    "Automated gas consumption table posted as comment on every pull request.",
    "Catches gas regressions before code is merged into main.",
    "Measures CPU instructions and memory usage accurately using Soroban test environment.",
    "Workflow completes in under 3 minutes."
  )

Register-Issue -Id 93 `
  -Title "perf(docker): optimize Docker multi-stage builds for minimal container footprints (<50MB)" `
  -Category "DevOps & CI/CD" `
  -Labels "devops,docker,performance" `
  -Difficulty "Medium" `
  -Skills "Docker, Alpine, Node.js, Optimization" `
  -Summary "Refactor Dockerfiles across dashboard, indexer, and seller agents using multi-stage Alpine/Distroless builds to reduce container images from >600MB down to <50MB." `
  -Motivation "Current Docker images bundle build tools (Rust toolchain, build-essential, npm cache, devDependencies), creating bloated image sizes that take minutes to deploy and expand the container attack surface." `
  -Implementation "1. Create optimized Dockerfile using node:20-alpine builder stage and gcr.io/distroless/nodejs20-debian12 runtime stage.`r`n2. Strip all npm development dependencies using npm prune --production.`r`n3. Run as non-root user (USER node / nonroot) for security hardening.`r`n4. Implement .dockerignore excluding tests, documentation, and local cache." `
  -AcceptanceCriteria @(
    "Final container image size under 50MB.",
    "Vulnerability scan (Trivy/Docker Scout) reports 0 High or Critical vulnerabilities.",
    "Containers boot cleanly and pass health checks in docker-compose.yml.",
    "Build time improved via Docker layer caching."
  )

Register-Issue -Id 94 `
  -Title "ci: implement automated cargo-audit and npm audit vulnerability scanning in CI workflow" `
  -Category "DevOps & CI/CD" `
  -Labels "devops,security,ci" `
  -Difficulty "Medium" `
  -Skills "GitHub Actions, Security, Dependabot" `
  -Summary "Integrate cargo-audit and npm audit security scanning into .github/workflows/security.yml with automated pull request blocking for known CVEs." `
  -Motivation "Rust crates and npm packages frequently accumulate dependencies with publicly disclosed vulnerabilities. Continuous dependency scanning prevents supply-chain attacks from entering production." `
  -Implementation "1. Create .github/workflows/security.yml running on PRs and daily schedule.`r`n2. Run `cargo audit` in workspace root checking all Rust contract dependencies.`r`n3. Run `npm audit --audit-level=high` across all Node.js workspaces (sdk, dashboard, demo, indexer).`r`n4. Configure cargo-deny with deny.toml enforcing license compliance and banning unsafe crates." `
  -AcceptanceCriteria @(
    "Automated security scans run on every PR and daily at midnight UTC.",
    "Blocks PRs introducing dependencies with High or Critical CVE advisories.",
    "Enforces approved open-source licenses (MIT, Apache-2.0, BSD-3-Clause).",
    "CI runs fast with cached vulnerability databases."
  )

Register-Issue -Id 95 `
  -Title "feat(docker): build local multi-node Soroban testnet sandbox environment in docker-compose.yml" `
  -Category "DevOps & CI/CD" `
  -Labels "devops,docker,developer-experience" `
  -Difficulty "Medium" `
  -Skills "Docker, Stellar Quickstart, DevOps" `
  -Summary "Add a fully autonomous, offline local Soroban sandbox container in docker-compose.yml with automated contract compilation, deployment, and test account funding on boot." `
  -Motivation "Developers working offline or on unstable internet connections cannot interact with remote Stellar testnet RPC. A turnkey local container running Stellar Quickstart unlocks fast, offline, deterministic testing." `
  -Implementation "1. Update docker-compose.yml with stellar/quickstart:testing container running local standalone network.`r`n2. Add init service: waits for local RPC -> compiles contracts -> deploys WASM -> funds test keypairs.`r`n3. Export environment configuration to local .env.docker for dashboard and agents.`r`n4. Add healthcheck ensuring RPC is ready before dependent services start." `
  -AcceptanceCriteria @(
    "Running `docker-compose up` spins up full stack (Stellar node, indexer, dashboard, agents) with zero manual setup.",
    "Enables 100% offline development without contacting external network.",
    "Contracts automatically deployed and initialized on container boot.",
    "Documented in README.md under 'Offline Local Development'."
  )

Register-Issue -Id 96 `
  -Title "test(e2e): create end-to-end integration test runner simulating full agent commerce lifecycle" `
  -Category "DevOps & CI/CD" `
  -Labels "testing,e2e,sdk,ci" `
  -Difficulty "Hard" `
  -Skills "TypeScript, Playwright/Vitest, E2E Testing" `
  -Summary "Build a comprehensive E2E integration test suite in test/e2e/ simulating a complete real-world transaction: register seller -> buyer discovers -> funds escrow -> seller submits -> evaluator approves -> payment split." `
  -Motivation "Unit tests verify isolated components, but subtle integration bugs between SDK ScVal serialization, indexer poller latency, and smart contract event emission can break the user experience in production." `
  -Implementation "1. Create test/e2e/lifecycle.test.ts using Vitest.`r`n2. Script creates 3 fresh testnet keypairs and funds them via Friendbot.`r`n3. Registers new seller agent in identity contract.`r`n4. Buyer agent funds 10 USDC escrow job.`r`n5. Seller agent receives job, executes task, and submits deliverable.`r`n6. Evaluator validates deliverable and triggers completion.`r`n7. Asserts exact 99% provider and 1% treasury token balance increases." `
  -AcceptanceCriteria @(
    "E2E test executes end-to-end against live testnet or local sandbox in under 45 seconds.",
    "Validates all balance transitions, event emissions, and indexer database records.",
    "Runs automatically on scheduled nightly CI and manual workflow dispatch.",
    "Detailed failure diagnostics and transaction hashes logged on error."
  )

Register-Issue -Id 97 `
  -Title "fix(sdk): implement client-side sequence number tracking and nonce collision prevention" `
  -Category "SDK & Security" `
  -Labels "sdk,bug,reliability" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Stellar SDK, Concurrency" `
  -Summary "Implement an internal atomic sequence number manager in sdk/src/baseClient.ts to prevent 'bad sequence' errors when an agent submits multiple transactions in rapid succession." `
  -Motivation "In demo/buyer-agent.ts, when an agent dispatches multiple contract calls quickly, Horizon returns txBAD_SEQ because the second transaction is built using the same account sequence number before the first transaction has closed in a ledger." `
  -Implementation "1. Implement AccountSequenceManager class tracking active in-flight sequence numbers in memory.`r`n2. On first call, fetch sequence number from Horizon via loadAccount().`r`n3. For consecutive rapid calls, increment sequence number locally with atomic mutex lock.`r`n4. If a transaction fails with bad sequence, re-sync with Horizon and retry." `
  -AcceptanceCriteria @(
    "Agent can fire 10 consecutive transactions without encountering txBAD_SEQ.",
    "Gracefully resynchronizes sequence numbers on network errors or external wallet transactions.",
    "Thread-safe across asynchronous task loops.",
    "Unit tests simulate parallel transaction dispatch and verify sequential submission."
  )

Register-Issue -Id 98 `
  -Title "feat(tooling): build Python client generator from Soroban contract XDR specifications" `
  -Category "SDK & Security" `
  -Labels "tooling,python,sdk,developer-experience" `
  -Difficulty "Medium" `
  -Skills "Python, Rust, Soroban, Code Generation" `
  -Summary "Build a code generator script in scripts/generate-python-client.py parsing Soroban contract WASM specifications to generate fully typed Python client classes for AI data scientists." `
  -Motivation "Many AI agents and machine learning pipelines are written in Python (LangChain, AutoGen, CrewAI). Requiring Python developers to write raw XDR bindings or use Node wrappers limits adoption of Bear Protocol in the Python AI ecosystem." `
  -Implementation "1. Extract contract spec XDR from compiled WASM using stellar contract inspect.`r`n2. Parse exported functions, structs, and error codes.`r`n3. Generate python/marc_stellar/ client classes using stellar-sdk Python package.`r`n4. Include docstrings, type hints, and dataclass models matching Rust contract types.`r`n5. Provide sample Jupyter notebook in python/demo.ipynb." `
  -AcceptanceCriteria @(
    "Generates clean, idiomatic Python classes with complete type hints (PEP 484).",
    "Python client successfully interacts with testnet contract (registers agent, gets job).",
    "Jupyter notebook runs smoothly in Google Colab / local environment.",
    "Included in contract build pipeline."
  )

Register-Issue -Id 99 `
  -Title "ci: configure automated TypeDoc and rustdoc generation with GitHub Pages deployment" `
  -Category "DevOps & CI/CD" `
  -Labels "devops,documentation,ci" `
  -Difficulty "Medium" `
  -Skills "GitHub Actions, TypeDoc, rustdoc, GitHub Pages" `
  -Summary "Set up a unified documentation generator in .github/workflows/docs.yml publishing comprehensive TypeDoc and rustdoc API references to GitHub Pages on every release." `
  -Motivation "Developers integrating marc-stellar-sdk or reviewing smart contract interfaces currently have to read raw source code. Public, searchable HTML documentation drastically improves developer onboarding and technical credibility." `
  -Implementation "1. Configure TypeDoc in sdk/typedoc.json generating HTML docs for TypeScript SDK.`r`n2. Configure `cargo doc --no-deps` generating HTML docs for all Soroban crates.`r`n3. Merge documentation outputs into a unified docs site with unified navigation header.`r`n4. Deploy to GitHub Pages (gh-pages branch) on releases." `
  -AcceptanceCriteria @(
    "Automated documentation site deployed to GitHub Pages URL.",
    "Full search index across all TypeScript classes, methods, and Rust contract structs.",
    "Clean responsive layout with code syntax highlighting.",
    "Runs automatically on merge to main branch."
  )

Register-Issue -Id 100 `
  -Title "feat(devops): create mainnet deployment verification and health check automation script" `
  -Category "DevOps & CI/CD" `
  -Labels "devops,mainnet,security,deployment" `
  -Difficulty "Medium" `
  -Skills "TypeScript, Stellar CLI, Mainnet, Verification" `
  -Summary "Build an automated verification and smoke test script in scripts/verify-mainnet.ts to validate smart contract parameters, treasury bindings, and SAC token addresses before public mainnet launch." `
  -Motivation "Mainnet deployments are irreversible. Misconfiguring the admin address, treasury account, or fee_bps in init() could permanently lock protocol revenue or require costly emergency redeployments." `
  -Implementation "1. Create scripts/verify-mainnet.ts reading deployments/mainnet.json.`r`n2. Verify contract bytecode hash matches audited release WASM.`r`n3. Verify fee_bps == 100, treasury is valid multi-sig address, and SAC token is canonical Circle USDC.`r`n4. Perform read-only simulation invocations on all entry points.`r`n5. Output cryptographically signed deployment audit certificate." `
  -AcceptanceCriteria @(
    "Comprehensive pre-launch checklist passes 100% of safety checks.",
    "Aborts and raises critical alarms if any unexpected parameter or non-multisig address is detected.",
    "Generates human-readable audit verification markdown report.",
    "Mandatory gate in mainnet deployment runbook."
  )

Write-Host "SDK, Security & DevOps registered."

Write-Host "Total registered issues: $($allIssues.Count)"

# Output JSON
$allIssues | ConvertTo-Json -Depth 5 | Set-Content -Path $issuesJsonPath -Encoding UTF8
Write-Host "Saved issues to $issuesJsonPath"

# Output ISSUES.md
$mdHeader = @"
# Stellar Agent (Bear Protocol) — Master Issue Catalog (100 Issues)

This document contains the complete catalog of **100 high-impact, production-grade technical issues** designed for **Drips**, **Stellar Wave**, and community contributors.

Each issue follows conventional commit conventions, includes motivation referencing actual codebase locations, detailed technical proposals, and concrete acceptance criteria.

---

## Issue Distribution Summary

| Category | Issue IDs | Count | Primary Focus |
|---|---|---|---|
| **Smart Contracts (Soroban / Rust)** | #1 – #25 | 25 | Escrows, Multi-token, Arbitrations, Session Keys, TTL Rent, Gas |
| **Backend, Indexer & Agent System** | #26 – #50 | 25 | SQLite WAL, SSE/WebSocket, Reorgs, Rate Limiting, Retries, Tracing |
| **Frontend & Dashboard** | #51 – #70 | 20 | Stellar Wallets Kit, Optimistic UI, Timelines, WCAG AAA, x402 Tester |
| **Packages & React SDK** | #71 – #85 | 15 | React Hooks (useJob, useCommerce, useWallet), UI components, SSR |
| **SDK, Security, DevOps & CI/CD** | #86 – #100 | 15 | CSP Headers, SSE Streaming, Cold Storage, Fuzzing, Matrix CI, Docker |

---

"@

$mdBody = ($allIssues | ForEach-Object {
    @"
### #$($_.id) - $($_.title)

**Category:** $($_.category)  
**Labels:** ``$($_.labels)``  
**Difficulty:** $($_.difficulty)  
**Skills:** $($_.skills)  

#### Summary
$($_.summary)

#### Motivation & Code Context
$($_.motivation)

#### Proposed Architecture & Implementation
$($_.implementation)

#### Acceptance Criteria
$(($_.criteria | ForEach-Object { "- [ ] $_" }) -join "`r`n")

---
"@
}) -join "`r`n`r`n"

$fullMd = $mdHeader + "`r`n" + $mdBody
Set-Content -Path $issuesMdPath -Value $fullMd -Encoding UTF8
Write-Host "Saved master catalog to $issuesMdPath"
