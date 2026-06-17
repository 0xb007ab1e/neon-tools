import { defineCommand, runMain } from 'citty';
import type { TenantRecord } from '../core/index.js';
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
  try {
    return await fn(tf);
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
  },
  async run({ args }) {
    await withTenantForge(async (tf) => {
      await tf.migrate();
      const { tenant, connectionUri } = await tf.provision({
        slug: args.slug,
        ...(args.region ? { region: args.region } : {}),
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
  },
  async run({ args }) {
    await withTenantForge(async (tf) => {
      const tenants = await tf.listTenants({
        limit: Number(args.limit),
        ...(args.status ? { status: args.status as TenantRecord['status'] } : {}),
      });
      if (tenants.length === 0) {
        process.stdout.write('no tenants\n');
        return;
      }
      for (const t of tenants) process.stdout.write(`${formatTenant(t)}\n`);
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
    description: 'Offboard a tenant: export then IRREVERSIBLY delete its Neon project',
  },
  args: {
    id: { type: 'positional', description: 'Tenant id (UUID)', required: true },
    yes: { type: 'boolean', description: 'Confirm the irreversible deletion', default: false },
    'skip-export': {
      type: 'boolean',
      description: 'Skip the export-before-delete step (no exporter wired yet in this build)',
      default: false,
    },
    reason: { type: 'string', description: 'Why export was skipped (required with --skip-export)' },
  },
  async run({ args }) {
    if (!args.yes) {
      process.stdout.write('refusing to offboard without --yes (this deletes the tenant DB)\n');
      process.exitCode = 1;
      return;
    }
    await withTenantForge(async (tf) => {
      const { tenant, export: exported } = await tf.offboard(args.id, {
        skipExport: args['skip-export'],
        ...(args.reason ? { reason: args.reason } : {}),
      });
      process.stdout.write(`${formatTenant(tenant)}\n`);
      process.stdout.write(exported ? `exported to ${exported.location}\n` : 'export skipped\n');
    });
  },
});

const main = defineCommand({
  meta: {
    name: 'tenantforge',
    description: 'Control plane for database-per-tenant SaaS on Neon',
  },
  subCommands: { migrate, provision, list, get, suspend, resume, offboard },
});

void runMain(main);
