import { spawn } from 'node:child_process';
import type { TenantRecord } from '../../core/index.js';
import type { ObjectStore } from '../../ports/object-store.js';
import type { ExportResult, TenantExporter } from '../../ports/tenant-exporter.js';

/** Dump a tenant database to a `pg_dump` custom-format archive, given its connection URI. */
export type DumpFn = (connectionUri: string) => Promise<Buffer>;

/** Collaborators for {@link createPgDumpExporter}. */
export interface PgDumpExporterDeps {
  /** Resolve a tenant's database connection URI (e.g. from the SecretStore). */
  resolveConnectionUri: (tenant: TenantRecord) => Promise<string | null>;
  /** Where the dump artifact is written (filesystem / S3 / GCS — behind the ObjectStore port). */
  objectStore: ObjectStore;
  /** How to produce the dump bytes. Use {@link spawnPgDump} in production; inject a fake in tests. */
  dump: DumpFn;
  /** Object-key prefix. Defaults to `tenants`. */
  keyPrefix?: string;
  /** Injectable clock (for a deterministic artifact key). Defaults to `() => new Date()`. */
  now?: () => Date;
}

/**
 * Create a {@link TenantExporter} that **`pg_dump`s a tenant's database** to an object store — the
 * off-Neon, real-data-movement alternative to the retain-the-project Neon archiver.
 *
 * Export is fail-closed (`tenant-exporter` contract): a tenant with no resolvable connection throws,
 * so offboarding aborts before the irreversible delete rather than losing un-exported data. A
 * never-provisioned tenant has nothing to dump and returns a `none:` reference.
 *
 * @param deps - Connection resolver, object store, dump function, and optional key prefix / clock.
 * @returns A pg_dump-to-object-store exporter.
 */
export function createPgDumpExporter(deps: PgDumpExporterDeps): TenantExporter {
  const keyPrefix = (deps.keyPrefix ?? 'tenants').replace(/^\/+|\/+$/g, '');
  const now = deps.now ?? ((): Date => new Date());

  return {
    async exportTenant(tenant: TenantRecord): Promise<ExportResult> {
      if (tenant.neonProjectId === null) {
        return { location: 'none:unprovisioned' }; // never provisioned — nothing to dump
      }
      const connectionUri = await deps.resolveConnectionUri(tenant);
      if (connectionUri === null) {
        // Fail closed: without a connection we cannot export, so offboard must not proceed to delete.
        throw new Error(`pg_dump export: no connection secret for tenant ${tenant.id}`);
      }
      const body = await deps.dump(connectionUri);
      const stamp = now().toISOString().replace(/[:.]/g, '-');
      const result = await deps.objectStore.put(`${keyPrefix}/${tenant.id}/${stamp}.dump`, body);
      return { location: result.location, bytes: result.bytes };
    },
  };
}

/** Options for {@link spawnPgDump}. */
export interface SpawnPgDumpOptions {
  /** Path to the `pg_dump` binary. Defaults to `pg_dump` (resolved on PATH). */
  pgDumpPath?: string;
  /** Injectable spawn (for testing). Defaults to `child_process.spawn`. */
  spawnImpl?: typeof spawn;
  /** Kill + fail the dump after this many ms. Defaults to 600000 (10 min). */
  timeoutMs?: number;
}

/**
 * Run `pg_dump` securely and buffer its custom-format output.
 *
 * The password is passed via the child's environment (`PGPASSWORD`), **never on argv** (where `ps`
 * would expose it — `workflow-secrets`, `lang-shell`); arguments are a fixed array (no shell, no
 * interpolation — `std-cwe` CWE-78). Connection details come from the parsed URI as `PG*` env vars.
 *
 * @param connectionUri - The tenant database URI (`postgres://user:pass@host:port/db?sslmode=…`).
 * @param options - Binary path, injectable spawn, and timeout.
 * @returns The dump archive bytes.
 */
export function spawnPgDump(
  connectionUri: string,
  options: SpawnPgDumpOptions = {},
): Promise<Buffer> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? 600_000;

  const url = new URL(connectionUri);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return Promise.reject(new Error(`pg_dump: unsupported connection scheme ${url.protocol}`));
  }

  // Per-component PG* env so the password never reaches argv. Inherit PATH etc. from the parent.
  const env: NodeJS.ProcessEnv = { ...process.env };
  env['PGHOST'] = url.hostname;
  if (url.port !== '') env['PGPORT'] = url.port;
  if (url.username !== '') env['PGUSER'] = decodeURIComponent(url.username);
  if (url.password !== '') env['PGPASSWORD'] = decodeURIComponent(url.password);
  const database = url.pathname.replace(/^\//, '');
  if (database !== '') env['PGDATABASE'] = database;
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode !== null && sslmode !== '') env['PGSSLMODE'] = sslmode;

  return new Promise<Buffer>((resolvePromise, reject) => {
    // `-Fc` = custom (compressed, restorable) format; `--no-password` never prompts interactively.
    const child = spawnImpl(options.pgDumpPath ?? 'pg_dump', ['-Fc', '--no-password'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const errChunks: string[] = [];
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`pg_dump timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => errChunks.push(chunk.toString()));
    child.on('error', (error: Error) => finish(() => reject(error)));
    child.on('close', (code: number | null) => {
      if (code === 0) {
        finish(() => resolvePromise(Buffer.concat(out)));
      } else {
        finish(() =>
          reject(
            new Error(`pg_dump exited with code ${code}: ${errChunks.join('').slice(0, 200)}`),
          ),
        );
      }
    });
  });
}
