# syntax=docker/dockerfile:1
#
# TenantForge HTTP control-plane image. Multi-stage + distroless + non-root (CIS / std-supplychain).
# Build context is the REPO ROOT (monorepo: single lockfile + workspace), e.g. from the repo root:
#   docker build -f tenantforge/Dockerfile -t tenantforge .
# Base images are pinned by digest (reproducible; supply-chain). Update digests deliberately.

# ---- builder: install (incl. dev), build, then emit a prod-only, self-contained deploy bundle ----
FROM node:22-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2 AS builder
WORKDIR /repo
ENV CI=1
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
# Workspace manifests first so the dependency layer caches across source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY tenantforge/package.json ./tenantforge/package.json
RUN pnpm install --frozen-lockfile --filter tenantforge...
# Source, then build (tsc → dist/, vite → dashboard/dist/).
COPY tenantforge/ ./tenantforge/
RUN pnpm --filter tenantforge build
# Self-contained bundle at /app: dist/ + dashboard/dist/ + migrations/ + package.json + prod
# node_modules (the package `files` field scopes what's copied). No dev deps, no pnpm at runtime.
RUN pnpm --filter tenantforge deploy --legacy --prod /app

# ---- runtime: distroless (no shell, no package manager), non-root ----
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e AS runtime
WORKDIR /app
ENV NODE_ENV=production TENANTFORGE_PORT=3000
COPY --from=builder --chown=nonroot:nonroot /app /app
EXPOSE 3000
USER nonroot
# No shell in distroless → a Node-based liveness probe against /health (unauthenticated).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.TENANTFORGE_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# distroless/nodejs ENTRYPOINT is `node`; this runs `node dist/app/http.js` from /app.
CMD ["dist/app/http.js"]
