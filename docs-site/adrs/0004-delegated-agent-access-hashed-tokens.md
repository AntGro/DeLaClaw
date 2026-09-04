# ADR 0004: Delegated agent access via hashed bearer tokens at adapter boundary

Date: 2026-07-20
Status: Accepted

## Context

DeLaClaw needs external agents (automations, background workers, custom tools) to act on behalf of a user without sharing the user's session. Must work across BYOB backends (Supabase, Local, Drive) and must not require central infrastructure operated by the author.

Requirements:
- Revocable, scoped, expiring delegation
- Owner isolation preserved — agent cannot act across owners
- No plaintext secrets at rest — DB leak must not expose tokens
- Same surface for all backends via `js/db.js`, no `if (backend===)` in views

## Decision

Delegated access is implemented as an adapter-level capability. Agents authenticate using opaque bearer tokens. Backends MUST verify delegation and translate it into an owner-scoped authorization context before data access.

Contract:

- Authentication: caller passes `Authorization: Bearer <agent_token>`
- Storage: only `token_hash = sha256(token)` UNIQUE is persisted, plus `owner_id`, `scope`, `expires_at`, `revoked_at`, `last_used_at`; plaintext returned once on creation via `create_agent_grant()`
- Verification: hash the bearer, lookup unrevoked + unexpired grant, check scope, enforce `owner_id`
- Authorization: `owner only` for management, `owner or agent` for data access where verified agent's `owner_id` equals row's `owner_id`
- Lifecycle: revocation via `revoke_agent_grant(id)` → `revoked_at`; `last_used_at` throttled (5 min)

Trust model: storage adapter is trusted to verify hash + enforce owner isolation; agent is untrusted, limited by scope/expiry/revocation.

## Reference implementation (Supabase)

- Table `agent_grants(id, owner_id, display_name, token_hash UNIQUE, scope, last_used_at, expires_at, revoked_at)`
- Function `has_agent_access()` SECURITY DEFINER reads `request.headers`, returns granting owner for RLS
- RLS policies use `has_agent_access()` to enforce owner-scoped access

Other backends MUST implement equivalent verification behind same `db.js` surface. Local single-user case may start as trusted but MUST NOT allow cross-owner access when multi-user.

## Consequences

- Positive: no central auth service, scoped delegation, plaintext never stored, owner isolation preserved across all backends
- Positive: same `db.js` contract for Supabase/REST/Drive/Demo
- Negative: each backend needs hash verification + scope + expiry + revocation; current Local/Drive implementations are incomplete (trusted-only gap)
- Negative: bearer token compromise remains possible; security depends on expiry, revocation, and scope limits — hashing protects stored secrets, not a stolen active token
- Neutral: adds agent_grants table/RPCs in Supabase reference; other backends need file/JSON equivalent

## Alternatives considered

- Share user JWT with agent — rejected: not per-agent revocable, no scope, leaks session
- Short-lived signed JWTs with custom signer — rejected: key management + central infrastructure required
- Plaintext API keys — rejected: DB leak exposes tokens
- Service role bypass for agents — rejected: breaks owner isolation, violates BYOB trust model
