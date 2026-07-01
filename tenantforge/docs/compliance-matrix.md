# TenantForge — Compliance Control Mapping (SOC 2 · GDPR)

> Closes gap #6. The compliance **evidence layer** (ADR-0011) deliberately emits **framework-agnostic
> attestation facts** (the locked "facts v1" decision) — signed, verifiable statements about the
> fleet. This document is the **mapping layer** that keeps the facts framework-agnostic while showing
> which **control objectives** each artifact _supports_ as audit evidence. Pairs with
> `@rules/std-soc2.md` (Trust Services Criteria) and `@rules/std-privacy.md` (GDPR).

## What this is — and is not

- **Is:** a cross-reference from each signed evidence artifact to the SOC 2 Common/Confidentiality
  criteria and GDPR articles it provides **evidence toward**, so an auditor can locate the technical
  proof behind a control.
- **Is NOT:** a certification, a compliance opinion, or proof of compliance. An artifact _supports_ a
  control; it does not by itself satisfy it. **A qualified assessor / DPO must validate this mapping**
  for the applicable scope — the control IDs below are the standard references (SOC 2 TSC 2017; GDPR
  as enacted), not an assessed SOC 2 report or a completed Record of Processing.
- **Scope note:** GDPR is in scope (`std-privacy.md` is applied). SOC 2 mappings apply **when the
  project is under SOC 2 scope** — enable `@rules/std-soc2.md` then. Physical/organizational/people
  controls (facility security, HR, vendor management) are **out of this layer's scope** — they need
  separate evidence.

## The evidence artifacts (what is attested)

All are **EdDSA/Ed25519-signed JWS**, offline-verifiable with only the published public key,
alg-pinned (no `none`/`HS*` confusion), with a distinct `typ` per class, and carry **no secrets / no
connection URIs** (redacted). Sources: `src/core/{compliance-cert,erasure,erasure-cert,evidence-bundle,evidence-manifest}.ts`;
design in `docs/adr/0011-compliance-evidence-layer.md` and `docs/security/0001-database-per-tenant-physical-isolation.md`.

- **Compliance report** — point-in-time fleet attestation: `inventory` (tenant counts by status),
  `isolation` (each tenant has a dedicated Neon project; lists any `missingProject` / `sharedProjects`),
  `residency` (tenants within the allowed regions/jurisdictions; lists `violations`), and an optional
  redacted `audit` excerpt.
- **Erasure certificate** — per-tenant signed proof that a tenant's data was irreversibly deleted:
  `tenantId`, `reason`, `erasedAt`, and `verified` post-conditions.
- **Evidence bundle** — a fleet- or single-tenant-scoped envelope assembling the attestations above
  plus the embedded (still-independently-verifiable) erasure certificates, with per-artifact content
  hashes. Per-tenant bundles are **BOLA-scoped** to one server-derived tenant id.
- **Evidence manifest** — the at-rest record of a stored bundle: non-guessable `bundleId`, `scope`,
  `storedAt`, `signerKid`, `contentHashes`, and `retentionUntil` (retention math).

## Mapping matrix

Control IDs: SOC 2 = 2017 Trust Services Criteria (CC = Common Criteria, C = Confidentiality,
PI = Processing Integrity). GDPR = article numbers.

| Evidence artifact / fact                                                                                      | Demonstrates                                                                                   | SOC 2 (TSC 2017)                                                                                                            | GDPR                                                                                                      |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Isolation attestation** (dedicated Neon project per tenant; `sharedProjects`/`missingProject` = exceptions) | Tenant data is logically **and physically** segregated — no cross-tenant access path           | **CC6.1** (logical access — restrict access to data), **C1.1** (protect confidential info), **CC6.6** (boundary protection) | **Art. 32** (security of processing — confidentiality), **Art. 25** (data protection by design & default) |
| **Residency attestation** (tenants within `allowedRegions` / jurisdiction; `violations` listed)               | Personal data is stored only in approved regions                                               | **CC6.1**, **C1.1** (where confidential data resides)                                                                       | **Art. 44–49** (Chapter V — international transfers), **Art. 5(1)(f)** (integrity & confidentiality)      |
| **Erasure certificate** (`verified` irreversible deletion, `erasedAt`, `reason`)                              | A data-subject erasure / offboarding was executed and verified                                 | **C1.2** (dispose of confidential info), **P4.2/P4.3** (retention & disposal — Privacy TSC, if in scope)                    | **Art. 17** (right to erasure), **Art. 5(1)(e)** (storage limitation)                                     |
| **Audit excerpt** (redacted `at/event/outcome/actor/tenantId`; erasures + recent)                             | Security-relevant actions are logged and attributable (non-repudiation)                        | **CC7.2** (monitor for anomalies), **CC4.1** (monitor controls), **CC6.1** (accountable access)                             | **Art. 30** (records of processing activities), **Art. 5(2)** (accountability)                            |
| **Inventory** (tenant totals by status)                                                                       | Completeness basis for the isolation/residency claims (the population they cover)              | **CC3.2** (identify/assess assets), **CC6.1**                                                                               | **Art. 30** (records)                                                                                     |
| **Retention** (manifest `retentionUntil`)                                                                     | Evidence is retained/expired per a defined window                                              | **C1.2**, **P4.2** (retention)                                                                                              | **Art. 5(1)(e)** (storage limitation)                                                                     |
| **Signature & integrity** (EdDSA JWS, offline-verifiable, alg-pinned, content hashes, distinct `typ`)         | The evidence is authentic and tamper-evident — an assertion can be trusted and is demonstrable | **PI1.x** (processing integrity), **CC7.1** (detect config/integrity issues)                                                | **Art. 5(2)** (accountability — ability to _demonstrate_ compliance)                                      |
| **Redaction / minimization** (no secrets, no connection URIs, no raw PII in evidence)                         | The evidence itself minimizes and protects data                                                | **C1.1**                                                                                                                    | **Art. 5(1)(c)** (data minimization), **Art. 32**                                                         |
| **Per-tenant BOLA scoping** (server-derived tenant id; non-guessable `bundleId`)                              | A tenant can access only its own evidence                                                      | **CC6.1**, **CC6.3** (least privilege / need-to-know)                                                                       | **Art. 32** (confidentiality), **Art. 5(1)(f)**                                                           |

## What the evidence does NOT cover (honest gaps)

The layer attests to the **fleet's data-isolation, residency, erasure, and audit** posture. It does
**not** by itself evidence: encryption-at-rest/in-transit configuration (attested elsewhere — TLS +
AES-256-GCM sealed secrets, `topic-cryptography`), key-management procedures, backup/restore (see
`docs/runbooks/backup-restore.md`), change management (PR + CI history), or any
physical/organizational/people control. A SOC 2 report or GDPR accountability file draws on those in
addition to these artifacts.

## References

- **SOC 2** — AICPA Trust Services Criteria (2017, rev. 2022); `@rules/std-soc2.md`.
- **GDPR** — Regulation (EU) 2016/679 (esp. Art. 5, 17, 25, 30, 32, 44–49); `@rules/std-privacy.md`.
- **Design** — `docs/adr/0011-compliance-evidence-layer.md`, `docs/security/0001-database-per-tenant-physical-isolation.md`, `docs/security/threat-model.md`.
- Validate this mapping with a qualified SOC 2 assessor / Data Protection Officer before relying on it
  for an audit.

---

_Last reviewed: 2026-07-01 (initial mapping — validate with a qualified assessor for the applicable scope). Owner: TenantForge maintainers._
