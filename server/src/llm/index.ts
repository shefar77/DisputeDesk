/**
 * LLM factory and the retry/fallback policy (PRD §13 failure handling):
 *
 *   model attempt -> one repair retry -> deterministic generator
 *
 * The fallback result keeps `generator: 'deterministic'` and carries the model's
 * error, so the UI says "AI unavailable — rule-based draft" instead of passing a
 * template off as model output.
 */

import { env } from '../env.js';
import { logger } from '../log.js';
import { AnthropicLLM, type LLMClient, type LlmResult } from './client.js';
import { DeterministicLLM } from './deterministic.js';

let primary: LLMClient | null = null;
const deterministic = new DeterministicLLM();

export function initLlm(): LLMClient {
  if (primary) return primary;
  if (env.llm.provider === 'anthropic' && env.llm.apiKey) {
    primary = new AnthropicLLM(env.llm.apiKey, env.llm.model);
    logger.info({ model: env.llm.model }, 'LLM: Anthropic structured outputs');
  } else {
    primary = deterministic;
    logger.info('LLM: no ANTHROPIC_API_KEY — using the deterministic generator');
  }
  return primary;
}

export function getLlm(): LLMClient {
  return primary ?? initLlm();
}

export function getDeterministic(): DeterministicLLM {
  return deterministic;
}

/** For tests and the eval: force a specific client. */
export function setLlm(client: LLMClient | null): void {
  primary = client;
}

export async function withFallback<T>(
  task: string,
  attempt: (client: LLMClient) => Promise<LlmResult<T>>,
  fallback: (client: DeterministicLLM) => Promise<LlmResult<T>>,
): Promise<LlmResult<T> & { attempts: number; fallbackReason: string | null }> {
  const client = getLlm();
  if (!client.enabled) {
    const r = await fallback(deterministic);
    return { ...r, attempts: 0, fallbackReason: null };
  }

  let last: LlmResult<T> | null = null;
  for (let i = 1; i <= 2; i++) {
    last = await attempt(client);
    if (last.ok) return { ...last, attempts: i, fallbackReason: null };
    logger.warn({ task, attempt: i, error: last.error }, 'LLM task failed');
    // Budget exhaustion will not fix itself on retry.
    if (last.error?.includes('budget')) break;
  }

  const r = await fallback(deterministic);
  return {
    ...r,
    attempts: 2,
    fallbackReason: last?.error ?? 'model unavailable',
    // Spend from the failed attempts is still real spend.
    costUsd: (last?.costUsd ?? 0) + r.costUsd,
  };
}

export type { LLMClient, LlmResult } from './client.js';
