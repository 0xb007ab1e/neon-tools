# Runbook: Secret Rotation

> Rotating TenantForge's secrets with zero downtime (add-new-before-revoke-old). Rules:
> `@rules/workflow-secrets.md`, `@rules/topic-cryptography.md`.

## When to use

- Scheduled rotation, suspected/confirmed exposure (treat any leaked secret as compromised), or
  personnel/role change.

## The secrets TenantForge holds

| Secret                                  | Blast radius                                                | Notes                                      |
| --------------------------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| `NEON_API_KEY`                          | **Highest** — can create/delete every tenant's Neon project | Org-scoped; rotate via the Neon org        |
| `DATABASE_URL` (control-plane registry) | Tenant **metadata** + fleet state                           | Not tenant content; not connection secrets |
| `TENANTFORGE_HTTP_TOKEN`                | HTTP control-plane API access                               | Bearer token for `/v1/*`                   |
| Per-tenant connection secrets           | One tenant's DB                                             | In the `SecretStore`, keyed by tenant id   |

## Steps (zero-downtime: add-new-before-revoke-old)

### NEON_API_KEY

1. Create a **new** API key in the Neon org (Neon console / API).
2. Roll it out to all control-plane instances (deploy/restart or hot-reload of the secret).
3. Verify provisioning works with the new key (provision + offboard a canary tenant in a test org).
4. **Revoke** the old key in Neon. (Confirmed compromise → revoke FIRST and accept brief
   provisioning downtime over continued exposure; pair with [`incident-response.md`](./incident-response.md).)

### DATABASE_URL (registry credential)

1. Create a new role/password on the control-plane Neon project (or rotate via Neon).
2. Provision both (dual-valid) where possible; roll the new `DATABASE_URL` to instances; verify
   `/health` + a registry read.
3. Revoke the old credential. Watch for auth-error spikes (`@rules/topic-logging-observability.md`).

### TENANTFORGE_HTTP_TOKEN

1. If clients allow two valid tokens, provision the new alongside the old; otherwise schedule a brief
   cutover. Roll out, update clients, revoke the old.

### A tenant's connection secret

1. Reset that tenant's Neon role password (Neon API) to mint a new connection URI.
2. `SecretStore.set(tenantId, newUri)` (and update any cached connection).
3. Verify `getConnection(tenantId)` resolves and the tenant connects; the old URI is now invalid.

## Verification

- All consumers use the new secret; the old is rejected; no auth-error spike.

## Rollback / abort

- During the dual-valid window the old secret still works — re-point and investigate before revoking.

## Escalation

- Confirmed exposure → run under [`incident-response.md`](./incident-response.md); page security.

## Related

- `incident-response.md`; `@rules/workflow-secrets.md`, `@rules/topic-cryptography.md`.

---

_Last validated: not yet drilled (alpha). Owner: TenantForge maintainers._
