# Security Policy

## Supported versions

This collection is pre-1.0 and under active development. Security fixes are applied to the latest
`main` only; there are no maintained release branches yet.

| Version         | Supported |
| --------------- | --------- |
| `main` (latest) | ✅        |
| anything older  | ❌        |

## Verifying releases

Releases are published per tool as **signed** Git tags named `<tool>-v<MAJOR.MINOR.PATCH>` (e.g.
`tenantforge-v0.4.1`), each with a matching GitHub Release.

- **Tags are signed** with the maintainer's SSH signing key —
  fingerprint `SHA256:fglfBxWu1U677tWw//+DqydeTTjI/OFw2UUh1yVnL2Y`. The public key is listed at
  the GitHub signing-keys API: <https://api.github.com/users/0xb007ab1e/ssh_signing_keys>.
- **Commits are signed and show as _Verified_ on GitHub.** Changes land via squash-merge, so the
  commit on `main` is re-signed by GitHub's web-flow key while the **author** remains the
  maintainer's `…@users.noreply.github.com` identity (GitHub reports `verified=true`).

**Easiest check:** on GitHub, the release tag and its commit both display a green **Verified** badge.

**Verify a tag locally** (SSH-signed):

```sh
# Trust the maintainer's SSH signing key (confirm it matches the fingerprint above):
printf '134006168+0xb007ab1e@users.noreply.github.com namespaces="git" %s\n' \
  "$(curl -s https://api.github.com/users/0xb007ab1e/ssh_signing_keys | sed -n 's/.*"key": *"\([^"]*\)".*/\1/p' | head -1)" \
  > /tmp/tf_allowed_signers
git config gpg.ssh.allowedSignersFile /tmp/tf_allowed_signers

git verify-tag tenantforge-v0.4.1
# expect: Good "git" signature for 134006168+0xb007ab1e@users.noreply.github.com with ED25519 key SHA256:fglf…
```

> Local commit verification can show `git: No public key` because the **commit** signature is
> GitHub's (web-flow GPG key `B5690EEEBB952194`), not in your keyring — that's a missing-key result,
> not an unsigned commit. GitHub's _Verified_ badge / the commits API (`.commit.verification`) is the
> source of truth for commit signatures. A CI gate also asserts the release version is identical
> across every version site, so a tampered/partial bump fails the build.

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
