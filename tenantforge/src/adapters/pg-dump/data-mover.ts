import { spawn } from 'node:child_process';
import type { TenantDataMover } from '../../ports/tenant-data-mover.js';
import { spawnPgDump, type SpawnPgDumpOptions } from './exporter.js';

/** Options for {@link spawnPgRestore}. */
export interface SpawnPgRestoreOptions {
  /** Path to the `pg_restore` binary. Defaults to `pg_restore` (resolved on PATH). */
  pgRestorePath?: string;
  /** Injectable spawn (for testing). Defaults to `child_process.spawn`. */
  spawnImpl?: typeof spawn;
  /** Kill + fail the restore after this many ms. Defaults to 600000 (10 min). */
  timeoutMs?: number;
}

/**
 * Restore a `pg_dump` custom-format archive into a target database with `pg_restore`.
 *
 * The password is passed via the child's environment (`PGPASSWORD`), **never on argv** (where `ps`
 * would expose it — `workflow-secrets`, `lang-shell`); arguments are a fixed array (no shell, no
 * interpolation — `std-cwe` CWE-78). The archive bytes are fed on **stdin**, not a temp file.
 *
 * @param connectionUri - The target database URI (`postgres://user:pass@host:port/db?sslmode=…`).
 * @param archive - The dump archive bytes (from {@link spawnPgDump}).
 * @param options - Binary path, injectable spawn, and timeout.
 * @returns Resolves when the restore completes; rejects on a non-zero exit / spawn error / timeout.
 */
export function spawnPgRestore(
  connectionUri: string,
  archive: Buffer,
  options: SpawnPgRestoreOptions = {},
): Promise<void> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? 600_000;

  const url = new URL(connectionUri);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return Promise.reject(new Error(`pg_restore: unsupported connection scheme ${url.protocol}`));
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  env['PGHOST'] = url.hostname;
  if (url.port !== '') env['PGPORT'] = url.port;
  if (url.username !== '') env['PGUSER'] = decodeURIComponent(url.username);
  if (url.password !== '') env['PGPASSWORD'] = decodeURIComponent(url.password);
  const database = url.pathname.replace(/^\//, '');
  if (database !== '') env['PGDATABASE'] = database;
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode !== null && sslmode !== '') env['PGSSLMODE'] = sslmode;

  // `--no-owner` so restore doesn't depend on the source's role; `-d` connects-and-restores.
  const args = ['--no-password', '--no-owner'];
  if (database !== '') args.push('-d', database);

  return new Promise<void>((resolvePromise, reject) => {
    const child = spawnImpl(options.pgRestorePath ?? 'pg_restore', args, {
      env,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
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
      finish(() => reject(new Error(`pg_restore timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    child.stderr?.on('data', (chunk: Buffer) => errChunks.push(chunk.toString()));
    child.on('error', (error: Error) => finish(() => reject(error)));
    child.on('close', (code: number | null) => {
      if (code === 0) {
        finish(() => resolvePromise());
      } else {
        finish(() =>
          reject(
            new Error(`pg_restore exited with code ${code}: ${errChunks.join('').slice(0, 200)}`),
          ),
        );
      }
    });

    // Feed the archive on stdin (off argv), then close it so pg_restore proceeds.
    child.stdin?.write(archive);
    child.stdin?.end();
  });
}

/** Options for {@link createPgDataMover}. */
export interface PgDataMoverOptions {
  /** How to dump the source. Defaults to {@link spawnPgDump}; inject a fake in tests. */
  dump?: (connectionUri: string) => Promise<Buffer>;
  /** How to restore into the target. Defaults to {@link spawnPgRestore}; inject a fake in tests. */
  restore?: (connectionUri: string, archive: Buffer) => Promise<void>;
  /** Options forwarded to the default {@link spawnPgDump}. */
  dumpOptions?: SpawnPgDumpOptions;
  /** Options forwarded to the default {@link spawnPgRestore}. */
  restoreOptions?: SpawnPgRestoreOptions;
}

/**
 * Create a {@link TenantDataMover} that copies a tenant's data between databases by piping
 * **`pg_dump` → `pg_restore`** (custom-format archive). This is the concrete data mover the re-home
 * engine (#5) uses, and the restore half of backup/restore (#6) — `pg_dump` already backs the
 * exporter; this adds the matching restore.
 *
 * @param options - Optional dump/restore overrides (tests) and pass-through binary/spawn/timeout opts.
 * @returns A pg-based tenant data mover.
 */
export function createPgDataMover(options: PgDataMoverOptions = {}): TenantDataMover {
  const dumpOptions = options.dumpOptions ?? {};
  const restoreOptions = options.restoreOptions ?? {};
  const dump = options.dump ?? ((uri: string): Promise<Buffer> => spawnPgDump(uri, dumpOptions));
  const restore =
    options.restore ??
    ((uri: string, archive: Buffer): Promise<void> => spawnPgRestore(uri, archive, restoreOptions));

  return {
    async move({ from, to }: { from: string; to: string }): Promise<void> {
      const archive = await dump(from);
      await restore(to, archive);
    },
  };
}
