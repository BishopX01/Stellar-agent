#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, String,
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

#[contract]
pub struct AgentIdentityContract;

#[contractimpl]
impl AgentIdentityContract {
    /// Initializer. Sets the contract admin address.
    /// Panics if the contract has already been initialized.
    ///
    /// The admin is the only address authorised to call `upgrade()`. This must
    /// be called once after deployment before any `upgrade` can be performed.
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


/// A registered agent in the MARC agent-identity registry.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Agent {
    pub id: u64,
    pub owner: Address,
    pub uri: String,
}

#[contracttype]
enum DataKey {
    NextId,
    RegisteredCount,
    Agent(u64),
    OwnerToId(Address),
    Version,
    Admin,
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

#[contract]
pub struct AgentIdentityContract;

#[contractimpl]
impl AgentIdentityContract {
    /// Initializer. Sets the contract admin address.
    /// Panics if the contract has already been initialized.
    ///
    /// The admin is the only address authorised to call `upgrade()`. This must
    /// be called once after deployment before any `upgrade` can be performed.
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
