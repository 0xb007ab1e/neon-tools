import { readFileSync } from 'node:fs';
import { defineCommand, runMain } from 'citty';
import { z } from 'zod';
import type { EvalCase, EvalThresholds } from '../core/index.js';
import { loadConfig } from './config.js';
import { type VectorNest, vectorNestFromConfig } from './lib.js';

/** Schema for a JSON eval set: a non-empty array of {query, relevant[]} cases. */
const EvalSetSchema = z
  .array(z.object({ query: z.string().min(1), relevant: z.array(z.string().min(1)).min(1) }))
  .min(1);

/**
 * Load and validate a labeled eval set from a JSON file.
 *
 * @param path - Path to the eval set JSON.
 * @returns The validated eval cases.
 */
function loadEvalSet(path: string): EvalCase[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return EvalSetSchema.parse(parsed);
}

/**
 * Build eval thresholds from optional CLI string flags.
 *
 * @param recall - Minimum recall@k, as a string, or undefined.
 * @param mrr - Minimum MRR, as a string, or undefined.
 * @returns The thresholds object.
 */
function buildThresholds(recall?: string, mrr?: string): EvalThresholds {
  const thresholds: EvalThresholds = {};
  if (recall) thresholds.minRecall = Number(recall);
  if (mrr) thresholds.minMrr = Number(mrr);
  return thresholds;
}

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

const reembed = defineCommand({
  meta: {
    name: 'reembed',
    description:
      'Re-embed the corpus under a model, alongside the active one (optionally activate)',
  },
  args: {
    model: {
      type: 'positional',
      description: 'provider/model string to embed with',
      required: true,
    },
    dim: { type: 'string', description: 'embedding dimension (only if the model is unknown)' },
    activate: {
      type: 'boolean',
      description: 'activate the model once fully embedded (zero-downtime swap)',
      default: false,
    },
    rehearse: {
      type: 'boolean',
      description: 'rehearse on a throwaway Neon branch first; abort if it does not pass',
      default: false,
    },
    eval: {
      type: 'string',
      description: 'path to an eval set to run on the rehearsal branch (implies --rehearse)',
    },
    recall: { type: 'string', description: 'min recall@k for the rehearsal eval gate' },
    mrr: { type: 'string', description: 'min MRR for the rehearsal eval gate' },
  },
  async run({ args }) {
    const options = {
      activate: args.activate,
      rehearse: args.rehearse,
      ...(args.dim ? { dim: Number(args.dim) } : {}),
      ...(args.eval ? { evalSet: loadEvalSet(args.eval) } : {}),
      ...(args.recall || args.mrr ? { thresholds: buildThresholds(args.recall, args.mrr) } : {}),
    };
    await withVectorNest(async (vn) => {
      await vn.migrate();
      const s = await vn.reembed(args.model, options);
      process.stdout.write(
        `re-embedded ${s.embedded} chunk(s); coverage ${s.coverage}/${s.total}; ${s.activated ? 'ACTIVATED' : 'not activated'}\n`,
      );
    });
  },
});

const rehearse = defineCommand({
  meta: {
    name: 'rehearse',
    description: 'Rehearse a model on a throwaway Neon branch (no production changes)',
  },
  args: {
    model: { type: 'positional', description: 'provider/model string to rehearse', required: true },
    dim: { type: 'string', description: 'embedding dimension (only if the model is unknown)' },
  },
  async run({ args }) {
    const options = args.dim ? { dim: Number(args.dim) } : {};
    await withVectorNest(async (vn) => {
      const r = await vn.rehearse(args.model, options);
      process.stdout.write(
        `rehearsed ${r.model} on branch ${r.branchId}: ${r.coverage}/${r.total} embedded in ${r.elapsedMs}ms — ${r.complete ? 'PASS' : 'INCOMPLETE'}\n`,
      );
    });
  },
});

const evaluate = defineCommand({
  meta: {
    name: 'eval',
    description:
      'Evaluate a model against a labeled query set (recall@k, MRR); exits 1 if below thresholds',
  },
  args: {
    model: { type: 'positional', description: 'model to evaluate', required: true },
    set: {
      type: 'positional',
      description: 'path to a JSON eval set: [{ "query": "...", "relevant": ["uri-substr"] }]',
      required: true,
    },
    k: { type: 'string', description: 'retrieval depth', default: '5' },
    recall: { type: 'string', description: 'fail if recall@k is below this (0..1)' },
    mrr: { type: 'string', description: 'fail if MRR is below this (0..1)' },
  },
  async run({ args }) {
    const evalSet = loadEvalSet(args.set);
    const thresholds = buildThresholds(args.recall, args.mrr);
    await withVectorNest(async (vn) => {
      const r = await vn.evaluate(args.model, evalSet, { k: Number(args.k), thresholds });
      process.stdout.write(
        `eval ${r.model}: recall@${r.report.k}=${r.report.recallAtK.toFixed(3)} mrr=${r.report.mrr.toFixed(3)} over ${r.report.cases} case(s) in ${r.elapsedMs}ms — ${r.passed ? 'PASS' : 'FAIL'}\n`,
      );
      if (!r.passed) process.exitCode = 1;
    });
  },
});

const activate = defineCommand({
  meta: { name: 'activate', description: 'Activate a fully-embedded model (swap / rollback)' },
  args: { model: { type: 'positional', description: 'model to activate', required: true } },
  async run({ args }) {
    await withVectorNest(async (vn) => {
      await vn.activateModel(args.model);
      process.stdout.write(`active model is now ${args.model}\n`);
    });
  },
});

const models = defineCommand({
  meta: { name: 'models', description: 'List registered models with coverage (* = active)' },
  async run() {
    await withVectorNest(async (vn) => {
      const list = await vn.models();
      if (list.length === 0) {
        process.stdout.write('no models registered\n');
        return;
      }
      for (const m of list) {
        process.stdout.write(
          `${m.isActive ? '*' : ' '} ${m.name}  dim=${m.dim}  coverage=${m.coverage}/${m.total}\n`,
        );
      }
    });
  },
});

const dropModel = defineCommand({
  meta: { name: 'drop-model', description: "Delete a non-active model's embeddings (cleanup)" },
  args: {
    model: { type: 'positional', description: 'model whose embeddings to drop', required: true },
  },
  async run({ args }) {
    await withVectorNest(async (vn) => {
      const removed = await vn.dropModel(args.model);
      process.stdout.write(`dropped ${removed} embedding row(s) for ${args.model}\n`);
    });
  },
});

const main = defineCommand({
  meta: {
    name: 'vectornest',
    description: 'RAG vector store on the Neon Postgres you already run',
  },
  subCommands: {
    migrate,
    ingest,
    query,
    reembed,
    rehearse,
    eval: evaluate,
    activate,
    models,
    'drop-model': dropModel,
  },
});

void runMain(main);
