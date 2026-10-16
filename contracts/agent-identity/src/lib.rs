#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, String, Symbol, Vec,
};

const MAX_METADATA_URI_LEN: u32 = 256; // prevents storage-griefing via oversized URI (#320)

// Soroban rent constants (#322).
// LEDGER_BUMP  — target TTL after every write/read (~30 days at ~5 s/ledger).
// LEDGER_THRESHOLD — minimum TTL before we bother bumping on a read (1 ledger
//                    means "always bump", keeping read-path behaviour simple).
const LEDGER_BUMP: u32 = 518_400; // 30 * 24 * 3_600 / 5
const LEDGER_THRESHOLD: u32 = 1;

// ---------------------------------------------------------------------------
// #696 — Delegate / WebAuthn permission constants
// ---------------------------------------------------------------------------

/// Delegate may call `update_uri` on behalf of the agent owner.
pub const PERM_UPDATE_URI: u32 = 0b0001;
/// Delegate may call `deregister` on behalf of the agent owner.
pub const PERM_DEREGISTER: u32 = 0b0010;
/// Delegate may call `transfer_owner` on behalf of the agent owner.
pub const PERM_TRANSFER: u32 = 0b0100;
/// All permissions combined.
pub const PERM_ALL: u32 = PERM_UPDATE_URI | PERM_DEREGISTER | PERM_TRANSFER;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    AgentNotFound = 1,
    AlreadyRegistered = 2,
    /// The delegate key has passed its `valid_until` timestamp. (#696)
    DelegateExpired = 3,
    /// The caller is not authorized (neither owner nor valid delegate). (#696)
    Unauthorized = 4,
    /// The delegate does not have the required permission bit set. (#696)
    InsufficientPermissions = 5,
    /// The issuer is not on the admin-managed issuer allowlist. (#701)
    IssuerNotAuthorized = 6,
    /// The badge does not exist for the given (agent_id, tag). (#701)
    BadgeNotFound = 7,
    /// The caller is not the original issuer of the badge. (#701)
    NotBadgeIssuer = 8,
}

/// A registered agent in the MARC agent-identity registry.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Agent {
    pub id: u64,
    pub owner: Address,
    pub uri: String,
}

// ---------------------------------------------------------------------------
// #696 — Delegate struct
// ---------------------------------------------------------------------------

/// A time-bounded delegate key that can act on behalf of an agent owner.
///
/// Designed for autonomous AI agents running on cloud workers that cannot
/// safely store master private keys. The owner grants a scoped `delegate_address`
/// (e.g. an ephemeral session key or a WebAuthn passkey-backed address) with
/// a specific `permissions` bitmask and an expiry timestamp.
///
/// Fields:
/// - `delegate_address` — the address authorised to act as a delegate.
/// - `valid_until`       — Unix timestamp (seconds) after which the delegate
///                         is considered expired and must not be accepted.
/// - `permissions`       — bitmask of allowed operations (see `PERM_*` constants).
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Delegate {
    pub delegate_address: Address,
    pub valid_until: u64,
    pub permissions: u32,
}

// ---------------------------------------------------------------------------
// #701 — Capability badge / verifiable credential
// ---------------------------------------------------------------------------

/// An on-chain capability attestation issued by an authorised issuer.
///
/// Badges certify an agent's specialisations (e.g. Code Auditing, Translation,
/// Market Making) with a benchmark `score` and an expiry. They are soulbound:
/// they are bound to the agent id and cannot be transferred independently of
/// the agent.
///
/// Fields:
/// - `issuer`     — the address that minted the badge; the only address
///                  allowed to revoke it.
/// - `tag`        — the capability symbol (e.g. `code_audit`).
/// - `score`      — issuer-attested benchmark score (0..=u32::MAX).
/// - `issued_at`  — Unix timestamp (seconds) at issuance.
/// - `expires_at` — Unix timestamp (seconds) after which the badge is inactive.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Badge {
    pub issuer: Address,
    pub tag: Symbol,
    pub score: u32,
    pub issued_at: u64,
    pub expires_at: u64,
}

#[contracttype]
enum DataKey {
    NextId,
    RegisteredCount,
    Agent(u64),
    OwnerToId(Address),
    Version,
    Admin,
    /// Storage key for a delegate record: (agent_id, delegate_address). (#696)
    Delegate(u64, Address),
    /// Storage key for a capability badge: (agent_id, tag). (#701)
    Badges(u64, Symbol),
    /// Admin-managed allowlist of addresses permitted to mint badges. (#701)
    AuthorizedIssuer(Address),
}

// --- Events ---

/// Emitted when a new agent is registered.
#[contractevent]
pub struct Registered {
    #[topic]
    pub owner: Address,
    pub agent_id: u64,
}

/// Emitted when an agent owner updates their metadata URI.
#[contractevent]
pub struct UriUpdated {
    #[topic]
    pub owner: Address,
    pub agent_id: u64,
}

/// Emitted when an agent is removed from the registry.
#[contractevent]
pub struct AgentDeregistered {
    #[topic]
    pub owner: Address,
    pub agent_id: u64,
}

/// Emitted when an agent's owner address is transferred to a new wallet.
#[contractevent]
pub struct OwnerTransferred {
    #[topic]
    pub old_owner: Address,
    pub new_owner: Address,
    pub agent_id: u64,
}

// --- #696 Delegate events ---

/// Emitted when a delegate is granted by an agent owner.
#[contractevent]
pub struct DelegateGranted {
    #[topic]
    pub owner: Address,
    pub agent_id: u64,
    pub delegate: Address,
    pub valid_until: u64,
    pub permissions: u32,
}

/// Emitted when a delegate is explicitly revoked by an agent owner.
#[contractevent]
pub struct DelegateRevoked {
    #[topic]
    pub owner: Address,
    pub agent_id: u64,
    pub delegate: Address,
}

// --- #701 Badge events ---

/// Emitted when a capability badge is minted for an agent.
#[contractevent]
pub struct BadgeIssued {
    #[topic]
    pub issuer: Address,
    pub agent_id: u64,
    pub tag: Symbol,
    pub score: u32,
    pub expires_at: u64,
}

/// Emitted when a capability badge is revoked by its issuer.
#[contractevent]
pub struct BadgeRevoked {
    #[topic]
    pub issuer: Address,
    pub agent_id: u64,
    pub tag: Symbol,
}

#[contract]
pub struct AgentIdentityContract;

#[contractimpl]
impl AgentIdentityContract {
    /// Initializer. Sets the contract admin address.
    /// Panics if the contract has already been initialized.
    ///
    /// The admin is the only address authorised to call `upgrade()` and to
    /// manage the badge issuer allowlist. This must be called once after
    /// deployment before any `upgrade` can be performed.
    pub fn init(env: Env, admin: Address) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Upgrade the contract's WASM executable to a new hash.
    ///
    /// Only the current admin (set via `init`) may call this. After the call
    /// the contract immediately executes the new WASM for all future
    /// invocations while all persistent storage (agents, owner mappings, etc.)
    /// is preserved unchanged.
    ///
    /// # Panics
    /// - `"not initialized"` if `init()` has never been called.
    /// - `"not admin"` if `admin` does not match the stored admin.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: soroban_sdk::BytesN<32>) {
        admin.require_auth();
        let current_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != current_admin {
            panic!("not admin");
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Register a new agent owned by `owner`. Caller must sign for `owner`.
    /// Returns the newly-assigned sequential agent id (starts at 1).
    ///
    /// # ID Semantics
    ///
    /// Agent IDs are **append-only**. Once assigned, an ID is never reused,
    /// even if the corresponding agent is later deregistered. `next_id`
    /// therefore represents the total number of registrations ever performed,
    /// not the current number of active agents.
    pub fn register(env: Env, owner: Address, uri: String) -> u64 {
        owner.require_auth();

        if uri.len() == 0 {
            panic!("metadata_uri cannot be empty");
        }
        if uri.len() > MAX_METADATA_URI_LEN {
            panic!("metadata_uri too long");
        }

        if env
            .storage()
            .persistent()
            .has(&DataKey::OwnerToId(owner.clone()))
        {
            panic_with_error!(&env, Error::AlreadyRegistered);
        }

        let next: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u64);

        let agent = Agent {
            id: next,
            owner: owner.clone(),
            uri,
        };
        env.storage().persistent().set(&DataKey::Agent(next), &agent);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Agent(next), LEDGER_THRESHOLD, LEDGER_BUMP);
        env.storage()
            .persistent()
            .set(&DataKey::OwnerToId(owner.clone()), &next);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::OwnerToId(owner.clone()), LEDGER_THRESHOLD, LEDGER_BUMP);
        env.storage()
            .instance()
            .set(&DataKey::NextId, &next.checked_add(1).expect("agent id overflow"));

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RegisteredCount)
            .unwrap_or(0u32);
        env.storage()
            .instance()
            .set(&DataKey::RegisteredCount, &count.checked_add(1).expect("count overflow"));

        Registered {
            owner,
            agent_id: next,
        }
        .publish(&env);

        next
    }

    /// Update the metadata URI of an agent. Caller must be the current owner.
    pub fn update_uri(env: Env, caller: Address, id: u64, new_uri: String) {
        caller.require_auth();
        if new_uri.len() == 0 {
            panic!("metadata_uri cannot be empty");
        }
        if new_uri.len() > MAX_METADATA_URI_LEN {
            panic!("metadata_uri too long");
        }
        let mut agent: Agent = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(id))
            .unwrap_or_else(|| panic!("agent not found"));
        if agent.owner != caller {
            panic!("not agent owner");
        }
        agent.uri = new_uri;
        env.storage().persistent().set(&DataKey::Agent(id), &agent);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Agent(id), LEDGER_THRESHOLD, LEDGER_BUMP);

        UriUpdated {
            owner: caller,
            agent_id: id,
        }
        .publish(&env);
    }

    /// Remove an agent from the registry. Caller must be the current owner.
    /// Frees the OwnerToId slot so the same address can re-register later.
    ///
    /// Any capability badges associated with the agent are archived (removed)
    /// so that stale credentials cannot outlive the agent they attest to.
    pub fn deregister(env: Env, caller: Address, id: u64) {
        caller.require_auth();
        let agent: Agent = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(id))
            .unwrap_or_else(|| panic!("agent not found"));
        if agent.owner != caller {
            panic!("not agent owner");
        }
        env.storage().persistent().remove(&DataKey::Agent(id));
        // Only remove the OwnerToId mapping if it still points to this agent.
        // If the owner has since re-registered (getting a new agent id), the
        // mapping now points to the newer agent and must NOT be wiped. This
        // prevents a stale or replayed deregister call from corrupting the
        // registry. (Fixes issue #321.)
        let current_id: Option<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::OwnerToId(agent.owner.clone()));
        if current_id == Some(id) {
            env.storage()
                .persistent()
                .remove(&DataKey::OwnerToId(agent.owner.clone()));
        }

        // #701 — archive/remove all badges bound to this agent so that
        // credentials cannot be resolved for a deregistered agent.
        let tags: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&DataKey::BadgeTags(id))
            .unwrap_or_else(|| Vec::new(&env));
        for tag in tags.iter() {
            env.storage().persistent().remove(&DataKey::Badges(id, tag));
        }
        env.storage().persistent().remove(&DataKey::BadgeTags(id));

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RegisteredCount)
            .unwrap_or(0u32);
        env.storage()
            .instance()
            .set(&DataKey::RegisteredCount, &count.saturating_sub(1));

        AgentDeregistered {
            owner: agent.owner,
            agent_id: id,
        }
        .publish(&env);
    }

    /// Transfer ownership of an agent to a new wallet. Caller must be the
    /// current owner. The new owner must not already own an agent.
    pub fn transfer_owner(env: Env, caller: Address, id: u64, new_owner: Address) {
        caller.require_auth();
        let mut agent: Agent = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(id))
            .unwrap_or_else(|| panic!("agent not found"));
        if agent.owner != caller {
            panic!("not agent owner");
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::OwnerToId(new_owner.clone()))
        {
            panic_with_error!(&env, Error::AlreadyRegistered);
        }
        env.storage()
            .persistent()
            .remove(&DataKey::OwnerToId(agent.owner.clone()));
        env.storage()
            .persistent()
            .set(&DataKey::OwnerToId(new_owner.clone()), &id);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::OwnerToId(new_owner.clone()), LEDGER_THRESHOLD, LEDGER_BUMP);
        agent.owner = new_owner.clone();
        env.storage().persistent().set(&DataKey::Agent(id), &agent);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Agent(id), LEDGER_THRESHOLD, LEDGER_BUMP);

        OwnerTransferred {
            old_owner: caller,
            new_owner,
            agent_id: id,
        }
        .publish(&env);
    }

    // -----------------------------------------------------------------------
    // #696 — Delegate management (WebAuthn passkey / session key support)
    // -----------------------------------------------------------------------

    /// Grant a delegate key for an agent.
    ///
    /// The `owner` must sign the transaction. The delegate is stored under
    /// `DataKey::Delegate(agent_id, delegate_address)` with the supplied
    /// `valid_until` Unix timestamp and `permissions` bitmask.
    ///
    /// # Parameters
    /// - `owner`       — current agent owner; must authorize this call.
    /// - `agent_id`    — the agent the delegate will act for.
    /// - `delegate`    — address of the delegate key (ephemeral key or passkey address).
    /// - `ttl`         — seconds from the current ledger timestamp until expiry.
    /// - `permissions` — bitmask of `PERM_*` constants (e.g. `PERM_UPDATE_URI`).
    ///
    /// Emits a `DelegateGranted` event on success.
    pub fn add_delegate(
        env: Env,
        owner: Address,
        agent_id: u64,
        delegate: Address,
        ttl: u64,
        permissions: u32,
    ) {
        owner.require_auth();

        // Verify the agent exists and is owned by `owner`.
        let agent: Agent = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(agent_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::AgentNotFound));
        if agent.owner != owner {
            panic_with_error!(&env, Error::Unauthorized);
        }

        let now: u64 = env.ledger().timestamp();
        let valid_until: u64 = now.saturating_add(ttl);

        let record = Delegate {
            delegate_address: delegate.clone(),
            valid_until,
            permissions,
        };

        let key = DataKey::Delegate(agent_id, delegate.clone());
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);

        DelegateGranted {
            owner,
            agent_id,
            delegate,
            valid_until,
            permissions,
        }
        .publish(&env);
    }

    /// Revoke a previously-granted delegate for an agent (owner-only).
    ///
    /// Removes the `DataKey::Delegate(agent_id, delegate)` entry from
    /// persistent storage. The delegate will no longer be accepted by
    /// `check_delegate`. Emits a `DelegateRevoked` event on success.
    pub fn revoke_delegate(env: Env, owner: Address, agent_id: u64, delegate: Address) {
        owner.require_auth();

        let agent: Agent = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(agent_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::AgentNotFound));
        if agent.owner != owner {
            panic_with_error!(&env, Error::Unauthorized);
        }

        let key = DataKey::Delegate(agent_id, delegate.clone());
        if env.storage().persistent().has(&key) {
            env.storage().persistent().remove(&key);
        }

        DelegateRevoked {
            owner,
            agent_id,
            delegate,
        }
        .publish(&env);
    }

    /// Read a delegate record for a given (agent_id, delegate_address) pair.
    ///
    /// Returns `None` if no delegate is stored, or if the record has expired.
    /// Callers should use this for informational purposes; the contract itself
    /// enforces expiry inside `check_delegate`.
    pub fn get_delegate(env: Env, agent_id: u64, delegate: Address) -> Option<Delegate> {
        let key = DataKey::Delegate(agent_id, delegate);
        let record: Option<Delegate> = env.storage().persistent().get(&key);
        match record {
            Some(ref d) if d.valid_until >= env.ledger().timestamp() => {
                env.storage()
                    .persistent()
                    .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);
                record
            }
            _ => None,
        }
    }

    /// Verify that `caller` is either the agent owner OR a non-expired delegate
    /// with at least `required_permission` bits set.
    ///
    /// Returns `Ok(())` if authorised, otherwise panics with:
    /// - `Error::AgentNotFound`           — agent does not exist
    /// - `Error::DelegateExpired`         — delegate record past `valid_until`
    /// - `Error::InsufficientPermissions` — delegate lacks the required bit
    /// - `Error::Unauthorized`            — caller is neither owner nor delegate
    pub fn check_delegate(
        env: Env,
        agent_id: u64,
        caller: Address,
        required_permission: u32,
    ) {
        let agent: Agent = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(agent_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::AgentNotFound));

        // Owner passes unconditionally.
        if agent.owner == caller {
            return;
        }

        // Check delegate record.
        let key = DataKey::Delegate(agent_id, caller.clone());
        let record: Option<Delegate> = env.storage().persistent().get(&key);

        match record {
            None => panic_with_error!(&env, Error::Unauthorized),
            Some(d) => {
                let now = env.ledger().timestamp();
                if d.valid_until < now {
                    panic_with_error!(&env, Error::DelegateExpired);
                }
                if d.permissions & required_permission == 0 {
                    panic_with_error!(&env, Error::InsufficientPermissions);
                }
                // Valid non-expired delegate with sufficient permissions — pass.
            }
        }
    }

    // -----------------------------------------------------------------------
    // #701 — Capability badges / verifiable credentials
    // -----------------------------------------------------------------------

    /// Authorise `issuer` to mint capability badges (admin-only).
    ///
    /// The admin (set via `init`) must sign. Once authorised, `issuer` may
    /// call `issue_badge` for any registered agent.
    pub fn add_authorized_issuer(env: Env, admin: Address, issuer: Address) {
        admin.require_auth();
        let current_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != current_admin {
            panic!("not admin");
        }
        let key = DataKey::AuthorizedIssuer(issuer);
        env.storage().persistent().set(&key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);
    }

    /// Remove `issuer` from the badge issuer allowlist (admin-only).
    ///
    /// Existing badges minted by the issuer remain valid until they expire or
    /// are revoked; only future minting is blocked.
    pub fn remove_authorized_issuer(env: Env, admin: Address, issuer: Address) {
        admin.require_auth();
        let current_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != current_admin {
            panic!("not admin");
        }
        env.storage()
            .persistent()
            .remove(&DataKey::AuthorizedIssuer(issuer));
    }

    /// Return `true` if `issuer` is currently allowed to mint badges.
    pub fn is_authorized_issuer(env: Env, issuer: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::AuthorizedIssuer(issuer))
            .unwrap_or(false)
    }

    /// Mint a capability badge for a registered agent.
    ///
    /// The `issuer` must sign and must be on the admin-managed issuer
    /// allowlist. The badge is stored under `DataKey::Badges(agent_id, tag)`
    /// and expires at `now + ttl` seconds.
    ///
    /// # Parameters
    /// - `issuer`   — authorised issuer address; must authorize this call.
    /// - `agent_id` — the agent the badge attests to.
    /// - `tag`      — capability symbol (e.g. `code_audit`).
    /// - `score`    — issuer-attested benchmark score.
    /// - `ttl`      — seconds from the current ledger timestamp until expiry.
    ///
    /// Emits a `BadgeIssued` event on success.
    pub fn issue_badge(
        env: Env,
        issuer: Address,
        agent_id: u64,
        tag: Symbol,
        score: u32,
        ttl: u64,
    ) {
        issuer.require_auth();

        // Only allowlisted issuers may mint badges.
        let authorized: bool = env
            .storage()
            .persistent()
            .get(&DataKey::AuthorizedIssuer(issuer.clone()))
            .unwrap_or(false);
        if !authorized {
            panic_with_error!(&env, Error::IssuerNotAuthorized);
        }

        // The agent must exist.
        if !env.storage().persistent().has(&DataKey::Agent(agent_id)) {
            panic_with_error!(&env, Error::AgentNotFound);
        }

        let now: u64 = env.ledger().timestamp();
        let expires_at: u64 = now.saturating_add(ttl);

        let badge = Badge {
            issuer: issuer.clone(),
            tag: tag.clone(),
            score,
            issued_at: now,
            expires_at,
        };

        let key = DataKey::Badges(agent_id, tag.clone());
        env.storage().persistent().set(&key, &badge);
        env.storage()
            .persistent()
            .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);

        // Track the tag so `deregister` can archive all badges for the agent.
        let mut tags: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&DataKey::BadgeTags(agent_id))
            .unwrap_or_else(|| Vec::new(&env));
        let mut found = false;
        for existing in tags.iter() {
            if existing == tag {
                found = true;
                break;
            }
        }
        if !found {
            tags.push_back(tag.clone());
            let tags_key = DataKey::BadgeTags(agent_id);
            env.storage().persistent().set(&tags_key, &tags);
            env.storage()
                .persistent()
                .extend_ttl(&tags_key, LEDGER_THRESHOLD, LEDGER_BUMP);
        }

        BadgeIssued {
            issuer,
            agent_id,
            tag,
            score,
            expires_at,
        }
        .publish(&env);
    }

    /// Revoke a capability badge. Only the original issuer may revoke.
    ///
    /// Removes the `DataKey::Badges(agent_id, tag)` entry from persistent
    /// storage. Emits a `BadgeRevoked` event on success.
    ///
    /// # Panics
    /// - `Error::BadgeNotFound` if no badge exists for the (agent_id, tag).
    /// - `Error::NotBadgeIssuer` if `issuer` did not mint the badge.
    pub fn revoke_badge(env: Env, issuer: Address, agent_id: u64, tag: Symbol) {
        issuer.require_auth();

        let key = DataKey::Badges(agent_id, tag.clone());
        let badge: Badge = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::BadgeNotFound));

        if badge.issuer != issuer {
            panic_with_error!(&env, Error::NotBadgeIssuer);
        }

        env.storage().persistent().remove(&key);

        // Drop the tag from the agent's badge index.
        let tags: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&DataKey::BadgeTags(agent_id))
            .unwrap_or_else(|| Vec::new(&env));
        let mut remaining: Vec<Symbol> = Vec::new(&env);
        for existing in tags.iter() {
            if existing != tag {
                remaining.push_back(existing);
            }
        }
        let tags_key = DataKey::BadgeTags(agent_id);
        if remaining.len() == 0 {
            env.storage().persistent().remove(&tags_key);
        } else {
            env.storage().persistent().set(&tags_key, &remaining);
            env.storage()
                .persistent()
                .extend_ttl(&tags_key, LEDGER_THRESHOLD, LEDGER_BUMP);
        }

        BadgeRevoked {
            issuer,
            agent_id,
            tag,
        }
        .publish(&env);
    }

    /// Return all active (non-expired) badges for an agent.
    ///
    /// Expired badges are skipped and lazily pruned from storage. Returns an
    /// empty vector if the agent has no active credentials.
    pub fn get_badges(env: Env, agent_id: u64) -> Vec<Badge> {
        let now: u64 = env.ledger().timestamp();
        let tags: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&DataKey::BadgeTags(agent_id))
            .unwrap_or_else(|| Vec::new(&env));

        let mut active: Vec<Badge> = Vec::new(&env);
        for tag in tags.iter() {
            let key = DataKey::Badges(agent_id, tag.clone());
            let badge: Option<Badge> = env.storage().persistent().get(&key);
            match badge {
                Some(b) if b.expires_at >= now => {
                    env.storage()
                        .persistent()
                        .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);
                    active.push_back(b);
                }
                Some(_) => {
                    // Expired — prune lazily.
                    env.storage().persistent().remove(&key);
                }
                None => {}
            }
        }
        active
    }

    /// Return a single badge for (agent_id, tag) if it exists and is active.
    ///
    /// Returns `None` for missing or expired badges.
    pub fn get_badge(env: Env, agent_id: u64, tag: Symbol) -> Option<Badge> {
        let key = DataKey::Badges(agent_id, tag);
        let badge: Option<Badge> = env.storage().persistent().get(&key);
        match badge {
            Some(ref b) if b.expires_at >= env.ledger().timestamp() => {
                env.storage()
                    .persistent()
                    .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);
                badge
            }
            _ => None,
        }
    }

    // -----------------------------------------------------------------------

    /// Fetch an agent by its id. Returns `None` if no such agent exists.
    pub fn get_agent(env: Env, id: u64) -> Option<Agent> {
        let key = DataKey::Agent(id);
        let agent: Option<Agent> = env.storage().persistent().get(&key);
        if agent.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);
        }
        agent
    }

    /// Fetch an agent directly by its owner address in a single call.
    ///
    /// Resolves the owner's agent id from the `OwnerToId` index and returns
    /// the full `Agent` record, or `None` if the owner has no registered
    /// agent. This avoids the two-call `agent_of` + `get_agent` round trip.
    pub fn get_agent_by_owner(env: Env, owner: Address) -> Option<Agent> {
        let key = DataKey::OwnerToId(owner);
        let agent_id: Option<u64> = env.storage().persistent().get(&key);
        match agent_id {
            Some(id) => Self::get_agent(env, id),
            None => None,
        }
    }

    /// Return the agent id owned by `owner`, or `None` if none is registered.
    pub fn agent_of(env: Env, owner: Address) -> Option<u64> {
        env.storage().persistent().get(&DataKey::OwnerToId(owner))
    }

    /// Return the total number of agents ever registered (append-only).
    pub fn registered_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::RegisteredCount)
            .unwrap_or(0u32)
    }

    /// Return the next agent id that will be assigned on the next `register`.
    pub fn next_id(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(1u64)
    }

    /// Return the contract version marker.
    pub fn version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or(1u32)
    }
}