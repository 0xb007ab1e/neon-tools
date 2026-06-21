import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { defineCommand, runMain } from 'citty';
import type { TenantRecord } from '../core/index.js';
import { decodeCursor, encodeCursor } from '../core/index.js';
import { runWithActor } from './actor-context.js';
import { parseLifecycleCommand } from '../adapters/lifecycle-command.js';
import { createPgMessageQueue } from '../adapters/neon-pg/message-queue.js';
import { loadConfig } from './config.js';
import { type TenantForge, tenantForgeFromConfig } from './lib.js';

/**
 * Build a configured TenantForge, run an operation against it, and always close the pool.
 *
 * @param fn - The operation to run.
 * @returns The operation's result.
 */
async function withTenantForge<T>(fn: (tf: TenantForge) => Promise<T>): Promise<T> {
  const tf = tenantForgeFromConfig(loadConfig());
  // Attribute CLI actions to the invoking OS user in the audit stream.
  const actor = { id: `cli:${userInfo().username}`, role: 'admin' };
  try {
    return await runWithActor(actor, () => fn(tf));
  } finally {
    await tf.close();
  }
}

/** Render a tenant record as a single line. Never prints connection secrets (master §5). */
function formatTenant(t: TenantRecord): string {
  return `${t.id}  ${t.slug}  ${t.status}  ${t.region}  project=${t.neonProjectId ?? '-'}`;
}

const migrate = defineCommand({
  meta: { name: 'migrate', description: 'Apply control-plane registry schema migrations' },
  async run() {
    await withTenantForge(async (tf) => {
      await tf.migrate();
      process.stdout.write('migrations applied\n');
    });
  },
});

const provision = defineCommand({
  meta: { name: 'provision', description: 'Provision a tenant (isolated Neon project)' },
  args: {
    slug: {
      type: 'positional',
      description: 'Tenant slug (3–63 chars, [a-z0-9-])',
      required: true,
    },
    region: { type: 'string', description: 'Neon region id (defaults to the configured region)' },
    residency: { type: 'string', description: 'Required residency jurisdiction (us | eu | apac)' },
  },
  async run({ args }) {
    await withTenantForge(async (tf) => {
      await tf.migrate();
      const { tenant, connectionUri } = await tf.provision({
        slug: args.slug,
        ...(args.region ? { region: args.region } : {}),
        ...(args.residency ? { residency: args.residency as 'us' | 'eu' | 'apac' } : {}),
      });
      process.stdout.write(`${formatTenant(tenant)}\n`);
      // The connection URI is a secret: report only whether one was issued, never the value.
      process.stdout.write(
        connectionUri
          ? 'provisioned: connection secret issued (store it in your secret manager)\n'
          : 'already provisioned (idempotent no-op)\n',
      );
    });
  },
});

const list = defineCommand({
  meta: { name: 'list', description: 'List tenants (most recent first)' },
  args: {
    status: { type: 'string', description: 'Filter by status' },
    limit: { type: 'string', description: 'Max rows', default: '100' },
    cursor: { type: 'string', description: 'Opaque next-page token from a previous list' },
  },
  async run({ args }) {
    const limit = Number(args.limit);
    const cursor = args.cursor ? decodeCursor(args.cursor) : null;
    if (args.cursor && cursor === null) {
      process.stderr.write('error: invalid cursor\n');
      process.exitCode = 1;
      return;
    }
    await withTenantForge(async (tf) => {
      const tenants = await tf.listTenants({
        limit,
        ...(args.status ? { status: args.status as TenantRecord['status'] } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (tenants.length === 0) {
        process.stdout.write('no tenants\n');
        return;
      }
      for (const t of tenants) process.stdout.write(`${formatTenant(t)}\n`);
      // Page full → there may be more; print the token to fetch the next page.
      const last = tenants[tenants.length - 1];
      if (tenants.length === limit && last !== undefined) {
        process.stdout.write(
          `next-cursor: ${encodeCursor({ createdAt: last.createdAt, id: last.id })}\n`,
        );
      }
    });
  },
});

const get = defineCommand({
  meta: { name: 'get', description: 'Show a tenant by id' },
  args: { id: { type: 'positional', description: 'Tenant id (UUID)', required: true } },
  async run({ args }) {
    await withTenantForge(async (tf) => {
      const tenant = await tf.getTenant(args.id);
      if (!tenant) {
        process.stdout.write('not found\n');
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${formatTenant(tenant)}\n`);
    });
  },
});

const usage = defineCommand({
  meta: {
    name: 'usage',
    description: "Report a tenant's Neon resource consumption over a period (metering)",
  },
  args: {
    id: { type: 'positional', description: 'Tenant id (UUID)', required: true },
    from: { type: 'string', description: 'Period start (ISO-8601); default 30 days ago' },
    to: { type: 'string', description: 'Period end (ISO-8601); default now' },
  },
  async run({ args }) {
    const to = args.to ? new Date(args.to) : new Date();
    const from = args.from
      ? new Date(args.from)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    await withTenantForge(async (tf) => {
      const u = await tf.usage(args.id, { from, to });
      const c = u.consumption;
      process.stdout.write(
        `${u.tenantId}  project=${u.neonProjectId}  ${u.period.from}..${u.period.to}\n`,
      );
      process.stdout.write(
        `  compute=${c.computeTimeSeconds}s active=${c.activeTimeSeconds}s ` +
          `written=${c.writtenDataBytes}B storage(peak)=${c.syntheticStorageBytes}B\n`,
      );
    });
  },
});

const suspend = defineCommand({
  meta: { name: 'suspend', description: 'Suspend an active tenant (reversible)' },
  args: { id: { type: 'positional', description: 'Tenant id (UUID)', required: true } },
  async run({ args }) {
    await withTenantForge(async (tf) => {
      const tenant = await tf.suspend(args.id);
      process.stdout.write(`${formatTenant(tenant)}\n`);
    });
  },
});

const resume = defineCommand({
  meta: { name: 'resume', description: 'Resume a suspended tenant back to active' },
  args: { id: { type: 'positional', description: 'Tenant id (UUID)', required: true } },
  async run({ args }) {
    await withTenantForge(async (tf) => {
      const tenant = await tf.resume(args.id);
      process.stdout.write(`${formatTenant(tenant)}\n`);
    });
  },
});

const offboard = defineCommand({
  meta: {
    name: 'offboard',
    description: 'Offboard a tenant: archive (retain, scale-to-zero), reversible until purge',
  },
  args: {
    id: { type: 'positional', description: 'Tenant id (UUID)', required: true },
    refund: {
      type: 'boolean',
      description: 'Also refund the unused (prorated) portion of the latest charge — moves money',
      default: false,
    },
    reason: { type: 'string', description: 'Reason recorded on the proration refund' },
    yes: {
      type: 'boolean',
      description: 'Confirm the refund — required with --refund (it returns real money).',
      default: false,
    },
  },
  async run({ args }) {
    if (args.refund && !args.yes) {
      process.stderr.write('refusing to refund without --yes (this returns real money)\n');
      process.exitCode = 1;
      return;
    }
    await withTenantForge(async (tf) => {
      const { tenant, archive } = await tf.offboard(args.id);
      process.stdout.write(`${formatTenant(tenant)}\n`);
      process.stdout.write(
        `archived (retained, pending purge): ${archive ? archive.location : 'n/a'}\n`,
      );
      // Refund the unused period as a separate, explicitly-gated step (offboard itself is money-free).
      if (args.refund) {
        const refund = await tf.refundUnusedPeriod(args.id, {
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        });
        process.stdout.write(
          refund === null
            ? 'proration refund: nothing owed (no prior charge, or the period is fully consumed)\n'
            : `proration refund: ${refund.provider} ${refund.id} ${refund.status} ` +
                `${refund.amountMinor} ${refund.currency}\n`,
        );
      }
    });
  },
});

const purge = defineCommand({
  meta: {
    name: 'purge',
    description: 'IRREVERSIBLY delete an offboarded tenant (project + connection secret)',
  },
  args: {
    id: { type: 'positional', description: 'Tenant id (UUID)', required: true },
    yes: { type: 'boolean', description: 'Confirm the irreversible deletion', default: false },
  },
  async run({ args }) {
    if (!args.yes) {
      process.stdout.write('refusing to purge without --yes (this deletes the tenant DB)\n');
      process.exitCode = 1;
      return;
    }
    await withTenantForge(async (tf) => {
      const tenant = await tf.purge(args.id);
      process.stdout.write(`${formatTenant(tenant)}\n`);
    });
  },
});

const purgeExpired = defineCommand({
  meta: {
    name: 'purge-expired',
    description:
      'Purge archived tenants past their retention window (the scheduled retention sweep)',
  },
  args: {
    'retention-days': {
      type: 'string',
      description: 'Override the retention window in days (default: TENANTFORGE_RETENTION_DAYS)',
    },
    yes: { type: 'boolean', description: 'Confirm the irreversible deletions', default: false },
  },
  async run({ args }) {
    if (!args.yes) {
      process.stdout.write('refusing to sweep without --yes (this deletes tenant DBs)\n');
      process.exitCode = 1;
      return;
    }
    const retentionDays =
      args['retention-days'] !== undefined
        ? Number(args['retention-days'])
        : loadConfig().retentionDays;
    await withTenantForge(async (tf) => {
      const report = await tf.purgeExpired({ retentionDays });
      process.stdout.write(
        `purge sweep: ${report.purged.length} purged, ${report.failed.length} failed ` +
          `of ${report.scanned} archived tenant(s) (retention ${retentionDays}d)\n`,
      );
      for (const f of report.failed) process.stdout.write(`  FAILED ${f.tenantId}: ${f.error}\n`);
      if (report.failed.length > 0) process.exitCode = 1;
    });
  },
});

const migrateFleet = defineCommand({
  meta: {
    name: 'migrate-fleet',
    description: 'Apply a versioned SQL migration across all active tenants (batched, resumable)',
  },
  args: {
    version: {
      type: 'positional',
      description: 'Migration version (e.g. 0002_add_audit)',
      required: true,
    },
    file: { type: 'positional', description: 'Path to the migration .sql file', required: true },
    batch: {
      type: 'string',
      description: 'Max tenants applied concurrently per batch',
      default: '10',
    },
  },
  async run({ args }) {
    const sql = readFileSync(args.file, 'utf8');
    await withTenantForge(async (tf) => {
      await tf.migrate();
      const report = await tf.migrateFleet(
        { version: args.version, sql },
        { batchSize: Number(args.batch) },
      );
      process.stdout.write(
        `fleet migration ${report.version}: ${report.succeeded.length} applied, ` +
          `${report.failed.length} failed, ${report.alreadyApplied} already-applied ` +
          `of ${report.total} active tenant(s)\n`,
      );
      for (const f of report.failed) process.stdout.write(`  FAILED ${f.tenantId}: ${f.error}\n`);
      if (report.failed.length > 0) process.exitCode = 1;
    });
  },
});

/** Read an ordered migration catalog from a directory of `*.sql` files (sorted by filename). */
function readMigrationCatalog(dir: string): { version: string; sql: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => ({ version: f.replace(/\.sql$/, ''), sql: readFileSync(join(dir, f), 'utf8') }));
}

const reconcileFleet = defineCommand({
  meta: {
    name: 'reconcile-fleet',
    description:
      'Bring behind/failed tenants up to the target version by applying their missing migrations',
  },
  args: {
    dir: {
      type: 'positional',
      description: 'Directory of ordered migration .sql files (the catalog)',
      required: true,
    },
    plan: { type: 'boolean', description: 'Preview only — show the plan, apply nothing' },
    target: { type: 'string', description: 'Reconcile up to this version (default: latest)' },
    canary: {
      type: 'string',
      description: 'Reconcile this tenant first; abort the fleet if it fails',
    },
    batch: {
      type: 'string',
      description: 'Max tenants reconciled concurrently per batch',
      default: '10',
    },
  },
  async run({ args }) {
    const specs = readMigrationCatalog(args.dir);
    const options = {
      batchSize: Number(args.batch),
      ...(args.target !== undefined ? { targetVersion: args.target } : {}),
      ...(args.canary !== undefined ? { canaryTenantId: args.canary } : {}),
    };
    await withTenantForge(async (tf) => {
      await tf.migrate();
      if (args.plan) {
        const plan = await tf.reconcilePlan(options);
        process.stdout.write(
          `reconcile plan → target ${plan.target ?? 'none'}: ${plan.pendingTenants.length} tenant(s) ` +
            `behind (${plan.totalMissing} migration application(s)), ${plan.upToDate.length} up to date\n`,
        );
        for (const t of plan.perTenant) {
          process.stdout.write(`  ${t.tenantId}: ${t.missing.join(', ')}\n`);
        }
        return;
      }
      const report = await tf.reconcileFleet(specs, options);
      process.stdout.write(
        `fleet reconcile → target ${report.target ?? 'none'}: ${report.reconciled.length} reconciled, ` +
          `${report.partial.length} with failures, ${report.alreadyAtLatest} already at target ` +
          `(${report.total} behind)${report.canaryAborted === true ? ' — CANARY ABORTED' : ''}\n`,
      );
      for (const p of report.partial) {
        process.stdout.write(
          `  FAILED ${p.tenantId} at ${p.failed?.version}: ${p.failed?.error}\n`,
        );
      }
      if (report.partial.length > 0 || report.canaryAborted === true) process.exitCode = 1;
    });
  },
});

const enqueue = defineCommand({
  meta: {
    name: 'enqueue',
    description: 'Enqueue a lifecycle command for the worker to apply asynchronously',
  },
  args: {
    type: {
      type: 'positional',
      description: 'Command: provision | suspend | resume | offboard',
      required: true,
    },
    slug: { type: 'string', description: 'Tenant slug (provision)' },
    'tenant-id': { type: 'string', description: 'Tenant id (suspend/resume/offboard)' },
    region: { type: 'string', description: 'Neon region id (provision)' },
    residency: { type: 'string', description: 'Required residency jurisdiction (provision)' },
  },
  async run({ args }) {
    // Validate before enqueuing — never put a malformed command on the queue (fail closed).
    const command = parseLifecycleCommand({
      id: randomUUID(),
      type: args.type,
      ...(args.slug ? { slug: args.slug } : {}),
      ...(args['tenant-id'] ? { tenantId: args['tenant-id'] } : {}),
      ...(args.region ? { region: args.region } : {}),
      ...(args.residency ? { residency: args.residency } : {}),
    });
    const cfg = loadConfig();
    const queue = createPgMessageQueue({
      connectionString: cfg.databaseUrl,
      allowInsecure: cfg.allowInsecureDb,
    });
    try {
      const messageId = await queue.enqueue(command);
      process.stdout.write(
        `enqueued ${command.type} (command ${command.id}, message ${messageId})\n`,
      );
    } finally {
      await queue.close();
    }
  },
});

const snapshot = defineCommand({
  meta: {
    name: 'snapshot',
    description: 'Take a point-in-time snapshot (Neon branch) of a tenant',
  },
  args: { id: { type: 'positional', description: 'Tenant id (UUID)', required: true } },
  async run({ args }) {
    await withTenantForge(async (tf) => {
      const { snapshot: snap } = await tf.snapshot(args.id);
      process.stdout.write(`snapshot ${snap.name} (${snap.id}) created for tenant ${args.id}\n`);
    });
  },
});

const snapshotFleet = defineCommand({
  meta: {
    name: 'snapshot-fleet',
    description: 'Snapshot every active tenant (the scheduled backup sweep)',
  },
  async run() {
    await withTenantForge(async (tf) => {
      const report = await tf.snapshotFleet();
      process.stdout.write(
        `snapshot sweep: ${report.succeeded.length} snapshotted, ${report.failed.length} failed ` +
          `of ${report.scanned} active tenant(s)\n`,
      );
      for (const f of report.failed) process.stdout.write(`  FAILED ${f.tenantId}: ${f.error}\n`);
      if (report.failed.length > 0) process.exitCode = 1;
    });
  },
});

const pruneSnapshots = defineCommand({
  meta: {
    name: 'prune-snapshots',
    description: 'Prune old tenant snapshots per retention (the scheduled retention sweep)',
  },
  args: {
    'max-count': {
      type: 'string',
      description: 'Keep at most this many newest snapshots per tenant',
    },
    'max-age-days': { type: 'string', description: 'Prune snapshots older than this many days' },
  },
  async run({ args }) {
    const policy: { maxCount?: number; maxAgeMs?: number } = {};
    if (args['max-count'] !== undefined) policy.maxCount = Number(args['max-count']);
    if (args['max-age-days'] !== undefined)
      policy.maxAgeMs = Number(args['max-age-days']) * 86_400_000;
    await withTenantForge(async (tf) => {
      const report = await tf.pruneSnapshots(Object.keys(policy).length > 0 ? { policy } : {});
      process.stdout.write(
        `prune sweep: ${report.succeeded.length} pruned, ${report.failed.length} failed ` +
          `of ${report.scanned} active tenant(s)\n`,
      );
      for (const f of report.failed) process.stdout.write(`  FAILED ${f.tenantId}: ${f.error}\n`);
      if (report.failed.length > 0) process.exitCode = 1;
    });
  },
});

const restoreSnapshot = defineCommand({
  meta: {
    name: 'restore-snapshot',
    description: 'Restore a tenant to a snapshot (DESTRUCTIVE — overwrites live data)',
  },
  args: {
    id: { type: 'positional', description: 'Tenant id (UUID)', required: true },
    snapshot: { type: 'positional', description: 'Snapshot (branch) id', required: true },
    yes: { type: 'boolean', description: 'Confirm the destructive restore', default: false },
  },
  async run({ args }) {
    if (!args.yes) {
      process.stdout.write(
        'refusing to restore without --yes (this overwrites live tenant data)\n',
      );
      process.exitCode = 1;
      return;
    }
    await withTenantForge(async (tf) => {
      await tf.restoreSnapshot(args.id, args.snapshot);
      process.stdout.write(`tenant ${args.id} restored to snapshot ${args.snapshot}\n`);
    });
  },
});

const archive = defineCommand({
  meta: {
    name: 'archive',
    description: 'Archive a tenant off-Neon (pg_dump → object store) — durable long-term backup',
  },
  args: { id: { type: 'positional', description: 'Tenant id (UUID)', required: true } },
  async run({ args }) {
    await withTenantForge(async (tf) => {
      const { archive: result } = await tf.archive(args.id);
      process.stdout.write(`archived tenant ${args.id} → ${result.location}\n`);
    });
  },
});

const archiveFleet = defineCommand({
  meta: {
    name: 'archive-fleet',
    description: 'Archive every active tenant off-Neon (the scheduled long-term backup sweep)',
  },
  async run() {
    await withTenantForge(async (tf) => {
      const report = await tf.archiveFleet();
      process.stdout.write(
        `archive sweep: ${report.succeeded.length} archived, ${report.failed.length} failed ` +
          `of ${report.scanned} active tenant(s)\n`,
      );
      for (const f of report.failed) process.stdout.write(`  FAILED ${f.tenantId}: ${f.error}\n`);
      if (report.failed.length > 0) process.exitCode = 1;
    });
  },
});

const checkQuotas = defineCommand({
  meta: {
    name: 'check-quotas',
    description:
      'Check active tenants against resource quotas for the current month (the scheduled sweep)',
  },
  args: {
    'max-storage-gb': { type: 'string', description: 'Max peak storage per tenant, in GB' },
    'max-compute-seconds': { type: 'string', description: 'Max CPU-seconds per tenant' },
    enforce: {
      type: 'boolean',
      description: 'Suspend over-quota tenants (reversible) instead of only reporting',
      default: false,
    },
  },
  async run({ args }) {
    const quota: { maxStorageBytes?: number; maxComputeTimeSeconds?: number } = {};
    if (args['max-storage-gb'] !== undefined) {
      quota.maxStorageBytes = Number(args['max-storage-gb']) * 1_000_000_000;
    }
    if (args['max-compute-seconds'] !== undefined) {
      quota.maxComputeTimeSeconds = Number(args['max-compute-seconds']);
    }
    if (Object.keys(quota).length === 0) {
      process.stdout.write('no limits given (set --max-storage-gb and/or --max-compute-seconds)\n');
      process.exitCode = 1;
      return;
    }
    // Meter the current calendar month to now.
    const to = new Date();
    const from = new Date(to.getFullYear(), to.getMonth(), 1);
    await withTenantForge(async (tf) => {
      const report = await tf.checkQuotas({ from, to }, quota, { enforce: args.enforce });
      process.stdout.write(
        `quota sweep: ${report.exceeded.length} over quota` +
          (args.enforce ? ` (${report.enforced.length} suspended)` : '') +
          `, ${report.failed.length} failed of ${report.scanned} active tenant(s)\n`,
      );
      for (const id of report.exceeded) process.stdout.write(`  OVER QUOTA ${id}\n`);
      for (const f of report.failed) process.stdout.write(`  FAILED ${f.tenantId}: ${f.error}\n`);
      if (report.failed.length > 0) process.exitCode = 1;
    });
  },
});

const complianceReport = defineCommand({
  meta: {
    name: 'compliance-report',
    description: 'Fleet compliance attestation (isolation + residency) with an integrity digest',
  },
  args: { json: { type: 'boolean', description: 'Emit the full report as JSON', default: false } },
  async run({ args }) {
    await withTenantForge(async (tf) => {
      const { report, digest } = await tf.complianceReport();
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ report, digest }, null, 2)}\n`);
      } else {
        const iso = report.isolation;
        const res = report.residency;
        process.stdout.write(
          `compliance report (${report.inventory.total} tenants) digest=${digest.slice(0, 12)}…\n` +
            `  isolation: ${iso.compliant ? 'OK' : 'VIOLATION'} ` +
            `(missing-project=${iso.missingProject.length}, shared-project=${iso.sharedProjects.length})\n` +
            `  residency: ${res.compliant ? 'OK' : 'VIOLATION'} ` +
            `(${res.violations.length} violation(s); allow-list=${res.allowedRegions.length || 'unrestricted'})\n`,
        );
        for (const v of res.violations) {
          process.stdout.write(`    ${v.tenantId} region=${v.region}: ${v.reason}\n`);
        }
      }
      // Non-zero exit on any violation so CI / cron can gate on it.
      if (!report.isolation.compliant || !report.residency.compliant) process.exitCode = 1;
    });
  },
});

const costReport = defineCommand({
  meta: {
    name: 'cost-report',
    description: 'Per-tenant cost vs. price (margin) for the current month — read-only estimate',
  },
  args: { json: { type: 'boolean', description: 'Emit the full report as JSON', default: false } },
  async run({ args }) {
    const to = new Date();
    const from = new Date(to.getFullYear(), to.getMonth(), 1);
    await withTenantForge(async (tf) => {
      const r = await tf.costReport({ from, to });
      if (args.json) {
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        return;
      }
      const t = r.totals;
      process.stdout.write(
        `cost report (${t.tenants} tenants): cost $${t.costUsd} · price $${t.priceUsd} · ` +
          `margin $${t.marginUsd} · ${t.unprofitable} unprofitable · ${t.unpriced} unpriced` +
          (r.unmetered.length > 0 ? ` · ${r.unmetered.length} unmetered` : '') +
          '\n',
      );
      for (const row of r.rows) {
        const margin = row.marginUsd === null ? 'n/a' : `$${row.marginUsd}`;
        const flag = row.unprofitable ? ' (UNPROFITABLE)' : '';
        process.stdout.write(`  ${row.tenantId}: cost $${row.costUsd} margin ${margin}${flag}\n`);
      }
    });
  },
});

/** Parse `--from`/`--to` into a period defaulting to the current calendar month. */
function monthPeriod(from?: string, to?: string): { from: Date; to: Date } {
  const end = to !== undefined ? new Date(to) : new Date();
  const start =
    from !== undefined ? new Date(from) : new Date(end.getFullYear(), end.getMonth(), 1);
  return { from: start, to: end };
}

const invoice = defineCommand({
  meta: {
    name: 'invoice',
    description: 'Generate an invoice document for a tenant (usage × billing rates + plan fee)',
  },
  args: {
    id: { type: 'positional', description: 'Tenant id (UUID)', required: true },
    from: { type: 'string', description: 'Period start (ISO-8601); default month start' },
    to: { type: 'string', description: 'Period end (ISO-8601); default now' },
    json: { type: 'boolean', description: 'Emit the invoice as JSON', default: false },
  },
  async run({ args }) {
    await withTenantForge(async (tf) => {
      const inv = await tf.invoice(args.id, monthPeriod(args.from, args.to));
      if (args.json) {
        process.stdout.write(`${JSON.stringify(inv, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `invoice ${inv.tenantId}  ${inv.periodStart}..${inv.periodEnd}  total ${inv.currency} ${inv.totalUsd}\n`,
      );
      for (const li of inv.lineItems) {
        process.stdout.write(`  ${li.description}: ${li.quantity} ${li.unit} → $${li.amountUsd}\n`);
      }
    });
  },
});

const invoiceFleet = defineCommand({
  meta: {
    name: 'invoice-fleet',
    description: 'Generate invoices for every active tenant (failure-isolated)',
  },
  args: {
    from: { type: 'string', description: 'Period start (ISO-8601); default month start' },
    to: { type: 'string', description: 'Period end (ISO-8601); default now' },
    json: { type: 'boolean', description: 'Emit the full report as JSON', default: false },
  },
  async run({ args }) {
    await withTenantForge(async (tf) => {
      const report = await tf.invoiceFleet(monthPeriod(args.from, args.to));
      if (args.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `invoices: ${report.invoices.length} generated` +
          (report.unmetered.length > 0 ? ` · ${report.unmetered.length} unmetered` : '') +
          '\n',
      );
      for (const inv of report.invoices) {
        process.stdout.write(`  ${inv.tenantId}: ${inv.currency} ${inv.totalUsd}\n`);
      }
    });
  },
});

const charge = defineCommand({
  meta: {
    name: 'charge',
    description:
      'Charge a tenant for its invoice via the configured PSP (money movement; --yes gated)',
  },
  args: {
    id: { type: 'positional', description: 'Tenant id (UUID)', required: true },
    from: { type: 'string', description: 'Period start (ISO-8601); default month start' },
    to: { type: 'string', description: 'Period end (ISO-8601); default now' },
    yes: {
      type: 'boolean',
      description: 'Confirm — this moves real money. Required.',
      default: false,
    },
  },
  async run({ args }) {
    if (!args.yes) {
      process.stderr.write('refusing to charge without --yes (this moves real money)\n');
      process.exitCode = 1;
      return;
    }
    await withTenantForge(async (tf) => {
      const result = await tf.chargeInvoice(args.id, monthPeriod(args.from, args.to));
      process.stdout.write(
        `charged ${args.id}: ${result.provider} ${result.id} ${result.status} ` +
          `${result.amountMinor} ${result.currency}\n`,
      );
    });
  },
});

const chargeFleet = defineCommand({
  meta: {
    name: 'charge-fleet',
    description:
      'Charge every active tenant with a billing customer ref (the billing run; --yes gated)',
  },
  args: {
    from: { type: 'string', description: 'Period start (ISO-8601); default month start' },
    to: { type: 'string', description: 'Period end (ISO-8601); default now' },
    json: { type: 'boolean', description: 'Emit the full report as JSON', default: false },
    yes: {
      type: 'boolean',
      description: 'Confirm — this charges the fleet. Required.',
      default: false,
    },
  },
  async run({ args }) {
    if (!args.yes) {
      process.stderr.write('refusing to charge the fleet without --yes (this moves real money)\n');
      process.exitCode = 1;
      return;
    }
    await withTenantForge(async (tf) => {
      const report = await tf.chargeInvoiceFleet(monthPeriod(args.from, args.to));
      if (args.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(
          `charge run: ${report.charged.length} charged, ${report.skipped.length} skipped, ` +
            `${report.failed.length} failed\n`,
        );
        for (const f of report.failed) process.stdout.write(`  FAILED ${f.tenantId}: ${f.error}\n`);
      }
      if (report.failed.length > 0) process.exitCode = 1;
    });
  },
});

const dunning = defineCommand({
  meta: {
    name: 'dunning',
    description:
      'Retry failed charges / suspend the exhausted across the fleet (dunning run; --yes gated)',
  },
  args: {
    from: { type: 'string', description: 'Period start (ISO-8601); default month start' },
    to: { type: 'string', description: 'Period end (ISO-8601); default now' },
    'max-attempts': {
      type: 'string',
      description: 'Consecutive failures before suspending (default 4)',
    },
    'min-hours': {
      type: 'string',
      description: 'Minimum hours between retry attempts (default 24)',
    },
    json: { type: 'boolean', description: 'Emit the full report as JSON', default: false },
    yes: {
      type: 'boolean',
      description: 'Confirm — this retries charges (moves real money) and may suspend tenants.',
      default: false,
    },
  },
  async run({ args }) {
    if (!args.yes) {
      process.stderr.write(
        'refusing to run dunning without --yes (this retries charges and may suspend tenants)\n',
      );
      process.exitCode = 1;
      return;
    }
    const schedule =
      args['max-attempts'] !== undefined || args['min-hours'] !== undefined
        ? {
            maxAttempts: args['max-attempts'] !== undefined ? Number(args['max-attempts']) : 4,
            minHoursBetweenAttempts:
              args['min-hours'] !== undefined ? Number(args['min-hours']) : 24,
          }
        : undefined;
    await withTenantForge(async (tf) => {
      const report = await tf.runDunning(monthPeriod(args.from, args.to), schedule);
      if (args.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(
          `dunning run: ${report.retried.length} retried, ${report.suspended.length} suspended, ` +
            `${report.failed.length} failed, ${report.skipped.length} skipped\n`,
        );
        for (const s of report.suspended) {
          process.stdout.write(`  SUSPENDED ${s.tenantId} (${s.failures} failures)\n`);
        }
        for (const f of report.failed) {
          process.stdout.write(`  FAILED ${f.tenantId} (attempt ${f.attempt}): ${f.error}\n`);
        }
      }
      if (report.failed.length > 0) process.exitCode = 1;
    });
  },
});

const billingRun = defineCommand({
  meta: {
    name: 'billing-run',
    description:
      'Full billing run for the period: charge the fleet, then dun failures (--yes gated; for a cron)',
  },
  args: {
    from: { type: 'string', description: 'Period start (ISO-8601); default month start' },
    to: { type: 'string', description: 'Period end (ISO-8601); default now' },
    'skip-dunning': {
      type: 'boolean',
      description: 'Charge only — skip the dunning sweep',
      default: false,
    },
    'max-attempts': {
      type: 'string',
      description: 'Dunning: consecutive failures before suspending (default 4)',
    },
    'min-hours': {
      type: 'string',
      description: 'Dunning: minimum hours between retry attempts (default 24)',
    },
    json: { type: 'boolean', description: 'Emit the full report as JSON', default: false },
    yes: {
      type: 'boolean',
      description: 'Confirm — this charges the fleet (moves real money) and may suspend tenants.',
      default: false,
    },
  },
  async run({ args }) {
    if (!args.yes) {
      process.stderr.write(
        'refusing to run billing without --yes (this charges the fleet and may suspend tenants)\n',
      );
      process.exitCode = 1;
      return;
    }
    const dunningSchedule =
      args['max-attempts'] !== undefined || args['min-hours'] !== undefined
        ? {
            maxAttempts: args['max-attempts'] !== undefined ? Number(args['max-attempts']) : 4,
            minHoursBetweenAttempts:
              args['min-hours'] !== undefined ? Number(args['min-hours']) : 24,
          }
        : undefined;
    await withTenantForge(async (tf) => {
      const report = await tf.billingRun(monthPeriod(args.from, args.to), {
        skipDunning: args['skip-dunning'],
        ...(dunningSchedule !== undefined ? { dunningSchedule } : {}),
      });
      if (args.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        const c = report.charge;
        process.stdout.write(
          `billing run ${report.period.from}..${report.period.to}\n` +
            `  charge: ${c.charged.length} charged, ${c.skipped.length} skipped, ${c.failed.length} failed\n`,
        );
        if (report.dunning) {
          const d = report.dunning;
          process.stdout.write(
            `  dunning: ${d.retried.length} retried, ${d.suspended.length} suspended, ${d.failed.length} failed\n`,
          );
        } else {
          process.stdout.write('  dunning: skipped\n');
        }
      }
      const failed = report.charge.failed.length + (report.dunning?.failed.length ?? 0);
      if (failed > 0) process.exitCode = 1;
    });
  },
});

const refund = defineCommand({
  meta: {
    name: 'refund',
    description: 'Refund (credit) a prior charge, full or partial, via the PSP (--yes gated)',
  },
  args: {
    chargeId: {
      type: 'positional',
      description: 'PSP charge id to refund (from charge history)',
      required: true,
    },
    amount: {
      type: 'string',
      description: 'Partial refund amount in MINOR units (e.g. cents); omit for a full refund',
    },
    currency: {
      type: 'string',
      description:
        'Currency (lowercase ISO 4217); required only if the charge predates the audit trail',
    },
    reason: {
      type: 'string',
      description: 'Human reason for the refund (recorded; no secrets/PII)',
    },
    'tenant-id': {
      type: 'string',
      description: 'Tenant id for attribution (else derived from the charge)',
    },
    yes: {
      type: 'boolean',
      description: 'Confirm — this returns real money to the customer. Required.',
      default: false,
    },
  },
  async run({ args }) {
    if (!args.yes) {
      process.stderr.write('refusing to refund without --yes (this returns real money)\n');
      process.exitCode = 1;
      return;
    }
    await withTenantForge(async (tf) => {
      const result = await tf.refundCharge(args.chargeId, {
        ...(args.amount !== undefined ? { amountMinor: Number(args.amount) } : {}),
        ...(args.currency !== undefined ? { currency: args.currency } : {}),
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
        ...(args['tenant-id'] !== undefined ? { tenantId: args['tenant-id'] } : {}),
      });
      process.stdout.write(
        `refunded ${args.chargeId}: ${result.provider} ${result.id} ${result.status} ` +
          `${result.amountMinor} ${result.currency}\n`,
      );
    });
  },
});

const planChange = defineCommand({
  meta: {
    name: 'plan-change',
    description:
      "Change a tenant's plan price; --settle prorates the delta (charge/refund, --yes gated)",
  },
  args: {
    id: { type: 'positional', description: 'Tenant id (UUID)', required: true },
    price: { type: 'string', description: 'New flat plan price in USD (>= 0)', required: true },
    from: { type: 'string', description: 'Period start (ISO-8601); default month start' },
    to: { type: 'string', description: 'Period end (ISO-8601); default now' },
    settle: {
      type: 'boolean',
      description: 'Settle the prorated delta now (charge an upgrade / refund a downgrade)',
      default: false,
    },
    yes: {
      type: 'boolean',
      description: 'Confirm settlement — required with --settle (it moves real money).',
      default: false,
    },
  },
  async run({ args }) {
    if (args.settle && !args.yes) {
      process.stderr.write('refusing to settle without --yes (this moves real money)\n');
      process.exitCode = 1;
      return;
    }
    const price = Number(args.price);
    await withTenantForge(async (tf) => {
      const report = await tf.changePlan(args.id, price, {
        ...(args.from !== undefined || args.to !== undefined
          ? { period: monthPeriod(args.from, args.to) }
          : {}),
        settle: args.settle,
      });
      process.stdout.write(
        `plan changed ${args.id}: $${report.oldPriceUsd} → $${report.newPriceUsd} ` +
          `(prorated delta ${report.proratedDeltaMinor} minor units, settlement: ${report.settlement}` +
          `${report.settlementId !== undefined ? ` ${report.settlementId}` : ''})\n`,
      );
    });
  },
});

const main = defineCommand({
  meta: {
    name: 'tenantforge',
    description: 'Control plane for database-per-tenant SaaS on Neon',
  },
  subCommands: {
    migrate,
    provision,
    list,
    get,
    usage,
    suspend,
    resume,
    offboard,
    enqueue,
    purge,
    'purge-expired': purgeExpired,
    'migrate-fleet': migrateFleet,
    'reconcile-fleet': reconcileFleet,
    snapshot,
    'snapshot-fleet': snapshotFleet,
    'prune-snapshots': pruneSnapshots,
    'restore-snapshot': restoreSnapshot,
    archive,
    'archive-fleet': archiveFleet,
    'check-quotas': checkQuotas,
    'compliance-report': complianceReport,
    'cost-report': costReport,
    invoice,
    'invoice-fleet': invoiceFleet,
    charge,
    'charge-fleet': chargeFleet,
    dunning,
    'billing-run': billingRun,
    refund,
    'plan-change': planChange,
  },
});

void runMain(main);
