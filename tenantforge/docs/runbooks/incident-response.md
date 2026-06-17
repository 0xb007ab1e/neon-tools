# Runbook: Incident Response

> Security incident or major outage of the TenantForge control plane. Rules:
> `@rules/workflow-incident-response.md`, `@rules/std-privacy.md`.

## When to use

- A suspected breach, active exploitation, or major outage. When in doubt, declare. The
  TenantForge-defining critical incidents are a **cross-tenant data leak** and a **Neon API key
  compromise**.

## Severity / impact

- **SEV1:** cross-tenant data exposure, Neon API key compromise (can create/delete _every_ tenant's
  project → mass data loss), or full control-plane outage.
- **SEV2:** contained incident / significant degradation.

## Steps

1. **Declare** + open the incident channel; assign Incident Commander + scribe; start a timeline.
2. **Assess** scope from telemetry (`@rules/topic-logging-observability.md`) — which tenants, which
   boundary. Per-tenant migration/provision state is in the registry (`tf_tenants`,
   `tf_tenant_migrations`).
3. **Contain** by vector:
   - **Neon API key compromised:** revoke + rotate it immediately ([`secret-rotation.md`](./secret-rotation.md));
     review Neon org audit/activity for unexpected project create/delete; freeze provisioning.
   - **Control-plane DB compromised:** rotate the `DATABASE_URL` credential. Note the design payoff —
     connection secrets live in the `SecretStore`, **not** the registry, so registry compromise
     alone does **not** disclose tenant connection URIs.
   - **Cross-tenant leak (routing/authz bug):** the router is fail-closed and tenant ids are
     server-derived — find the bypassed check, suspend affected tenants (`tenantforge suspend …`),
     fix, and add a cross-tenant abuse test (`@rules/topic-multi-tenancy.md`).
   - **Per-tenant secret exposure:** rotate that tenant's connection secret ([`secret-rotation.md`](./secret-rotation.md)).
   - **Preserve logs/evidence before wiping.**
4. **Eradicate** root cause (patch — [`dependency-patch.md`](./dependency-patch.md); fix misconfig/bug).
5. **Recover** from known-good ([`backup-restore.md`](./backup-restore.md)); verify; monitor.
6. **Notify** per breach duties (GDPR 72h, etc. — `@rules/std-privacy.md`).

## Verification

- Attacker access revoked (keys rotated); symptom resolved; monitoring confirms no recurrence.

## Escalation

- IC pages `<security lead>` / `<eng lead>`; legal + comms for SEV1 breach.

## Post-incident

- Blameless post-mortem within `<N>` days; tracked action items; update this runbook.

## Related

- `secret-rotation.md`, `backup-restore.md`, `dependency-patch.md`; `@rules/workflow-incident-response.md`.

---

_Last validated: not yet drilled (alpha). Owner: TenantForge maintainers._
