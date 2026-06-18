import { readFileSync } from 'node:fs';
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
  args: { id: { type: 'positional', description: 'Tenant id (UUID)', required: true } },
  async run({ args }) {
    await withTenantForge(async (tf) => {
      const { tenant, archive } = await tf.offboard(args.id);
      process.stdout.write(`${formatTenant(tenant)}\n`);
      process.stdout.write(
        `archived (retained, pending purge): ${archive ? archive.location : 'n/a'}\n`,
      );
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
    const queue = createPgMessageQueue({ connectionString: loadConfig().databaseUrl });
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
    snapshot,
    'snapshot-fleet': snapshotFleet,
    'prune-snapshots': pruneSnapshots,
    'restore-snapshot': restoreSnapshot,
    archive,
    'archive-fleet': archiveFleet,
    'check-quotas': checkQuotas,
  },
});

void runMain(main);
