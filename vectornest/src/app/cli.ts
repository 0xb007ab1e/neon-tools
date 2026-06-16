import { defineCommand, runMain } from 'citty';
import { loadConfig } from './config.js';
import { type VectorNest, vectorNestFromConfig } from './lib.js';

/**
 * Build a configured VectorNest, run an operation against it, and always close the pool.
 *
 * @param fn - The operation to run.
 * @returns The operation's result.
 */
async function withVectorNest<T>(fn: (vn: VectorNest) => Promise<T>): Promise<T> {
  const vn = vectorNestFromConfig(loadConfig());
  try {
    return await fn(vn);
  } finally {
    await vn.close();
  }
}

const migrate = defineCommand({
  meta: { name: 'migrate', description: 'Apply database schema migrations' },
  async run() {
    await withVectorNest(async (vn) => {
      await vn.migrate();
      process.stdout.write('migrations applied\n');
    });
  },
});

const ingest = defineCommand({
  meta: { name: 'ingest', description: 'Ingest documents from a file or directory' },
  args: {
    source: { type: 'positional', description: 'File or directory to ingest', required: true },
    collection: { type: 'string', description: 'Collection name', default: 'default' },
  },
  async run({ args }) {
    await withVectorNest(async (vn) => {
      await vn.migrate();
      const summary = await vn.ingest(args.source, { collection: args.collection });
      process.stdout.write(
        `ingested ${summary.documents} document(s), ${summary.chunks} chunk(s); skipped ${summary.skipped}\n`,
      );
    });
  },
});

const query = defineCommand({
  meta: { name: 'query', description: 'Semantic search over a collection' },
  args: {
    text: { type: 'positional', description: 'Query text', required: true },
    collection: { type: 'string', description: 'Collection name', default: 'default' },
    k: { type: 'string', description: 'Number of results', default: '5' },
  },
  async run({ args }) {
    const k = Number(args.k);
    await withVectorNest(async (vn) => {
      const hits = await vn.query(args.text, { collection: args.collection, k });
      if (hits.length === 0) {
        process.stdout.write('no results\n');
        return;
      }
      for (const hit of hits) {
        const preview = hit.text.replace(/\s+/g, ' ').slice(0, 120);
        process.stdout.write(
          `${hit.score.toFixed(4)}  ${hit.sourceUri}#${hit.ordinal}  ${preview}\n`,
        );
      }
    });
  },
});

const main = defineCommand({
  meta: {
    name: 'vectornest',
    description: 'RAG vector store on the Neon Postgres you already run',
  },
  subCommands: { migrate, ingest, query },
});

void runMain(main);
