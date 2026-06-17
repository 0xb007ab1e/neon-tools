# Security Policy

## Supported versions

This collection is pre-1.0 and under active development. Security fixes are applied to the latest
`main` only; there are no maintained release branches yet.

| Version | Supported |
|---|---|
| `main` (latest) | ✅ |
| anything older | ❌ |

## Reporting a vulnerability

**Please do not open public issues for security vulnerabilities.**

Report privately via GitHub's **[Report a vulnerability](https://github.com/0xb007ab1e/neon-tools/security/advisories/new)**
(Security ▸ Advisories ▸ Report a vulnerability). This opens a private advisory only you and the
maintainers can see.

Please include, where possible:

- the affected tool/path (e.g. `vectornest/...`) and version/commit,
- a description and impact, and the conditions required to trigger it,
- reproduction steps or a proof of concept,
- any suggested remediation.

## What to expect

- **Acknowledgement** within **3 business days**.
- **Triage** (severity via CVSS, validity, scope) shortly after.
- **Remediation targets** by severity:
  - Critical (CVSS ≥ 9.0 / actively exploited): **24–72h**
  - High (7.0–8.9): **7 days**
  - Medium (4.0–6.9): **30 days**
  - Low (< 4.0): next maintenance window
- **Coordinated disclosure:** we fix under embargo, then publish an advisory and a patched commit,
  crediting the reporter unless you prefer otherwise.

## Scope & handling

- No secrets are committed to this repository — credentials come from a git-ignored `.env` at
  runtime (see [`vectornest/.env.example`](./vectornest/.env.example)). If you ever find a committed
  secret, report it and treat it as compromised.
- CI runs SAST (CodeQL), dependency audit (SCA), and secret scanning (gitleaks) on every change;
  GitHub Dependabot and secret scanning are enabled on the repository.
- Thanks for helping keep this project and its users safe.
