/** A `provider/model` name split into its parts. */
export interface ParsedModel {
  /** Provider segment, e.g. `openai`. */
  provider: string;
  /** Model segment, e.g. `text-embedding-3-small`. */
  model: string;
}

/** Known embedding dimensions, so a model can be registered without a network probe. */
const KNOWN_DIMENSIONS: Readonly<Record<string, number>> = {
  // OpenAI
  'openai/text-embedding-3-small': 1536,
  'openai/text-embedding-3-large': 3072,
  'openai/text-embedding-ada-002': 1536,
  // Cloudflare Workers AI (BGE family)
  '@cf/baai/bge-small-en-v1.5': 384,
  '@cf/baai/bge-base-en-v1.5': 768,
  '@cf/baai/bge-large-en-v1.5': 1024,
  // Common local (Ollama) models
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
};

/**
 * Parse a `provider/model` name into its parts.
 *
 * @param name - The full model name, e.g. `openai/text-embedding-3-small`.
 * @returns The provider and model segments.
 * @throws RangeError if `name` is not of the form `provider/model`.
 */
export function parseModelName(name: string): ParsedModel {
  const slash = name.indexOf('/');
  if (slash <= 0 || slash === name.length - 1) {
    throw new RangeError(`model name must be "provider/model", got: ${name}`);
  }
  return { provider: name.slice(0, slash), model: name.slice(slash + 1) };
}

/**
 * Look up the embedding dimension for a known model.
 *
 * @param name - The full `provider/model` name.
 * @returns The dimension, or undefined if the model is not in the known table.
 */
export function knownDimension(name: string): number | undefined {
  return KNOWN_DIMENSIONS[name];
}
