# Runbook: Dependency / CVE Patch

> Patching a vulnerable dependency. Rules: `@rules/workflow-cve-management.md`,
> `@rules/workflow-vuln-mgmt.md`.

## When to use

- SCA / Dependabot / an advisory / a new CISA KEV entry flags a dependency in the workspace.

## Severity / impact

- Score with CVSS + EPSS + KEV and assess **reachability**: is it a runtime (prod) dep or dev-only
  tooling? `pnpm audit --prod` shows prod-only impact; Dependabot scans the whole lockfile. Set the
  SLA (Critical/KEV: 24–72h).

## Prerequisites & access

- Repo write + CI access. This is a **pnpm workspace** — one lockfile (`pnpm-lock.yaml`) and
  per-package `package.json`; overrides live in `pnpm-workspace.yaml`.

## Steps

1. **Confirm exposure / VEX:** is the vulnerable code path reachable? Record `affected` /
   `not affected` (+ justification).
2. **Find the fixed version** (OSV/GHSA/NVD).
3. **Upgrade (preferred):** bump the dep in the owning `package.json` (or, for a transitive dep,
   add/raise an entry under `overrides:` in `pnpm-workspace.yaml`). Then `pnpm install`.
   - **Pin overrides deterministically** — open-ended `>=` ranges can re-resolve to a bad version.
     (Precedent: the vitest/vite/esbuild remediation pins `vitest ^3.2.6` / `vite ^8.0.16` /
     `esbuild ^0.28.1` in `pnpm-workspace.yaml`.)
4. **Verify the resolved tree:** `grep -E "^  (<pkg>)@" pnpm-lock.yaml | sort -u` shows only the
   patched version(s); `pnpm audit` (and `pnpm audit --prod`) report no known vulnerabilities.
5. **Gates:** `pnpm -r lint && pnpm -r typecheck && pnpm -r test`; check for breaking changes (a
   major bump like vitest 2→3 needs the suite re-run).
6. Deploy via [`deploy.md`](./deploy.md); expedite for actively-exploited (KEV) issues.

## Verification

- The advisory is cleared for all affected packages; lockfile pins the fix; a regression/security
  test added where applicable; the tracked finding closed with evidence.

## Escalation

- Actively-exploited / breach evidence → [`incident-response.md`](./incident-response.md) and rotate
  any potentially exposed secrets ([`secret-rotation.md`](./secret-rotation.md)).

## Related

- `deploy.md`, `incident-response.md`; `@rules/workflow-cve-management.md`.

---

_Last validated: exercised in the vitest/vite/esbuild remediation. Owner: TenantForge maintainers._
