import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embedMany, type EmbeddingModel } from "ai";

/**
 * PRISM-37: embeddings are a separate, optional configuration from the chat
 * LLM (EMBEDDING_* vs LLM_*) — a bundle can have a chat model, an embeddings
 * model, both, or neither. Reuses the exact createOpenAICompatible() factory
 * PRISM-14 established for chat; no new provider abstraction. OpenAI-format
 * /embeddings only for v1 — the ticket's own examples (OpenAI, Voyage) are
 * both reachable through an OpenAI-compatible endpoint; Anthropic has no
 * embeddings API to target, so there's no "format" choice to make here.
 */
export interface EmbeddingConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export function resolveEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig | undefined {
  const baseURL = env.EMBEDDING_API_BASE_URL;
  const model = env.EMBEDDING_MODEL;
  if (!baseURL || !model) return undefined;
  return { baseURL, apiKey: env.EMBEDDING_API_KEY ?? "not-needed", model };
}

/** Ensure the URL ends in /v1 — matches providers/index.ts's normalizeV1. */
function normalizeV1(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

const modelCache = new Map<string, EmbeddingModel<string>>();

function embeddingModel(config: EmbeddingConfig): EmbeddingModel<string> {
  const key = `${config.baseURL}|${config.model}`;
  const cached = modelCache.get(key);
  if (cached) return cached;
  const model = createOpenAICompatible({
    name: "custom-embeddings",
    baseURL: normalizeV1(config.baseURL),
    apiKey: config.apiKey,
  }).textEmbeddingModel(config.model);
  modelCache.set(key, model);
  return model;
}

// Most OpenAI-compatible /embeddings endpoints cap batch size well above
// this; kept conservative so one oversized bundle can't produce one
// enormous, easy-to-time-out request.
const MAX_BATCH = 64;

/** Embed many texts in order, chunked to a sane per-request batch size. */
export async function embedTexts(config: EmbeddingConfig, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const model = embeddingModel(config);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const chunk = texts.slice(i, i + MAX_BATCH);
    const { embeddings } = await embedMany({ model, values: chunk });
    out.push(...embeddings);
  }
  return out;
}

const QUERY_CACHE_TTL_MS = 5 * 60_000;
const QUERY_CACHE_MAX = 200;
const queryCache = new Map<string, { vector: number[]; expiresAt: number }>();

/**
 * Embed a single query at search time. The one embedding call PRISM-37's
 * design doesn't move off the request path — background maintenance only
 * covers concept embeddings, and a search needs the query's own vector to
 * compare against them. Small TTL cache so repeatedly searching the same
 * term (a user refining a query, a UI re-issuing the same search) doesn't
 * re-pay the round trip every time.
 */
export async function embedQuery(config: EmbeddingConfig, query: string): Promise<number[]> {
  const key = `${config.baseURL}|${config.model}|${query}`;
  const cached = queryCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.vector;
  const [vector] = await embedTexts(config, [query]);
  if (queryCache.size >= QUERY_CACHE_MAX) {
    const oldest = queryCache.keys().next().value;
    if (oldest !== undefined) queryCache.delete(oldest);
  }
  queryCache.set(key, { vector, expiresAt: Date.now() + QUERY_CACHE_TTL_MS });
  return vector;
}
