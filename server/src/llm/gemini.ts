/**
 * Google Gemini implementation of `LLMClient`.
 *
 * This sits behind the same interface as `AnthropicLLM` and reuses the *same*
 * system prompts, the same JSON Schemas and the same zod validators, so swapping
 * providers changes who generates the text and nothing else: the untrusted-text
 * wrapping, the citation validator, the rubric scoring and the human approval
 * gate are all upstream of this file and are unaffected by the choice.
 *
 * Transport is a plain `fetch` against the REST API rather than an SDK. Two
 * reasons: no new dependency to install this close to a deadline, and it keeps
 * the test seam identical to the Anthropic client — inject a fake `fetch` and
 * assert on the exact bytes we would have sent, without spending anything.
 *
 * Endpoint: POST /v1beta/interactions (the Interactions API). Structured output
 * is requested with `response_format`, which constrains decoding to a JSON
 * object matching the supplied schema, rather than asking the model nicely.
 */

import type { DraftOutput, ExtractionOutput, PlanNarrative } from '@shared/index.js';
import { draftOutputSchema, extractionSchema, planNarrativeSchema } from '@shared/index.js';
import { env } from '../env.js';
import { logger } from '../log.js';
import type { DraftInput, ExtractionInput, LLMClient, LlmResult, LlmTask, PlanInput } from './client.js';
import {
  DRAFT_JSON_SCHEMA,
  EXTRACTION_JSON_SCHEMA,
  PLAN_NARRATIVE_JSON_SCHEMA,
} from './output-schemas.js';
import {
  DRAFT_SYSTEM,
  EXTRACTION_SYSTEM,
  PLAN_SYSTEM,
  buildDraftPrompt,
  buildExtractionPrompt,
  buildPlanPrompt,
  newNonce,
} from './prompts.js';
import { recordUsage, remainingBudgetUsd } from './budget.js';

export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/**
 * Published per-MTok prices (checked against Google's pricing page on
 * 2026-11-11). The Flash introductory rates run to 2026-12-31 and double on
 * 2027-01-01; the higher figure is used for an unrecognised model so that a typo
 * in `LLM_MODEL` can never make the spend cap under-count.
 */
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75 },
  'gemini-3-flash-preview': { input: 0.5, output: 3 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-3.1-flash-lite': { input: 0.3, output: 2.5 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES_PER_MTOK[model] ?? { input: 1.5, output: 7.5 };
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

type JsonObject = Record<string, unknown>;

/**
 * Adapt our JSON Schema to the subset the Interactions API accepts.
 *
 * Nullability is expressed as `type: ['string', 'null']`, which is supported, but
 * our enums then also carry a literal `null` member for the same field. That is
 * redundant once the type union allows null, and an enum of mixed types is not
 * part of the documented subset — so it is dropped here rather than risking a
 * 400 on every call. Length bounds (`minLength` / `maxLength`) are accepted but
 * not enforced by the API; they are left in place because the zod validator
 * downstream enforces them for real.
 */
export function toGeminiSchema<T>(schema: T): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;

    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node as JsonObject)) {
      if (key === 'enum' && Array.isArray(value)) {
        const members = value.filter((v) => v !== null);
        // An enum that was *only* null carries no information; drop the keyword.
        if (members.length > 0) out[key] = members;
        continue;
      }
      out[key] = walk(value);
    }
    return out;
  };
  return walk(schema) as T;
}

/** Mirrors the Anthropic client's effort mapping: copying facts is cheap, judgement is not. */
function thinkingLevelFor(task: LlmTask): 'low' | 'medium' {
  return task === 'extract' ? 'low' : 'medium';
}

interface GeminiStepContent {
  type?: string;
  text?: string;
}
interface GeminiStep {
  type?: string;
  content?: GeminiStepContent[];
}
interface GeminiUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
}
interface GeminiInteraction {
  status?: string;
  steps?: GeminiStep[];
  usage?: GeminiUsage;
}

/** Concatenate the text the model actually produced, ignoring any other step types. */
export function extractText(body: GeminiInteraction): string {
  return (body.steps ?? [])
    .filter((step) => step?.type === 'model_output')
    .flatMap((step) => step.content ?? [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
}

type Validator = { safeParse: (v: unknown) => { success: boolean; data?: unknown } };

/** Drop the internal chain-control flag so callers see a plain result. */
function strip<T>(r: LlmResult<T> & { retryOnNextModel?: boolean }): LlmResult<T> {
  const { retryOnNextModel: _ignored, ...rest } = r;
  return rest;
}

export class GeminiLLM implements LLMClient {
  readonly name = 'gemini';
  readonly enabled = true;
  /** Preferred model first; the rest are tried only when one is unavailable. */
  readonly models: string[];
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly apiKey: string,
    model: string | string[],
    /** Injected in tests to inspect the exact wire request without spending money. */
    fetchImpl?: typeof fetch,
  ) {
    const chain = (Array.isArray(model) ? model : [model]).map((m) => m.trim()).filter(Boolean);
    if (chain.length === 0) throw new Error('GeminiLLM needs at least one model name');
    this.models = [...new Set(chain)];
    this.model = this.models[0]!;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  extract(input: ExtractionInput): Promise<LlmResult<ExtractionOutput>> {
    const nonce = newNonce();
    const prompt = buildExtractionPrompt({
      reason: input.reason,
      items: input.items,
      orderAddress: input.orderAddress,
      nonce,
    });
    return this.call('extract', EXTRACTION_SYSTEM, prompt, EXTRACTION_JSON_SCHEMA, extractionSchema, input.disputeId);
  }

  plan(input: PlanInput): Promise<LlmResult<PlanNarrative>> {
    const nonce = newNonce();
    const prompt = buildPlanPrompt({ ...input, nonce });
    return this.call('plan', PLAN_SYSTEM, prompt, PLAN_NARRATIVE_JSON_SCHEMA, planNarrativeSchema, input.disputeId);
  }

  draft(input: DraftInput): Promise<LlmResult<DraftOutput>> {
    const nonce = newNonce();
    const prompt = buildDraftPrompt({ ...input, nonce });
    return this.call('draft', DRAFT_SYSTEM, prompt, DRAFT_JSON_SCHEMA, draftOutputSchema, input.disputeId);
  }

  /**
   * Walk the model chain.
   *
   * The Flash tiers return a 503 "high demand" under free-tier contention, and
   * that is a property of the moment rather than of the request — the identical
   * call succeeds on a less contended model. Rather than drop straight to the
   * rule-based generator and show a template on screen, we try the next model in
   * the chain. Only a genuinely unusable response (bad request, rejected key,
   * invalid output) stops the walk, and the rule-based generator is still the
   * final net above this.
   */
  private async call<T>(
    task: LlmTask,
    system: string,
    prompt: string,
    jsonSchema: unknown,
    validator: Validator,
    disputeId: string,
  ): Promise<LlmResult<T>> {
    let last: LlmResult<T> | null = null;
    for (const model of this.models) {
      const result = await this.callOnce<T>(task, system, prompt, jsonSchema, validator, disputeId, model);
      if (result.ok || !result.retryOnNextModel) return strip(result);
      logger.warn({ task, model, error: result.error }, 'Model unavailable — trying the next one in the chain');
      last = strip(result);
    }
    return last as LlmResult<T>;
  }

  private async callOnce<T>(
    task: LlmTask,
    system: string,
    prompt: string,
    jsonSchema: unknown,
    validator: Validator,
    disputeId: string,
    model: string,
  ): Promise<LlmResult<T> & { retryOnNextModel?: boolean }> {
    const started = Date.now();
    const base: LlmResult<T> = {
      ok: false,
      value: null,
      generator: 'llm',
      model,
      error: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: 0,
    };

    // Hard spend stop. Checked before the call, not after.
    if ((await remainingBudgetUsd()) <= 0) {
      return {
        ...base,
        error: `LLM daily budget of $${env.llm.dailyCapUsd} is exhausted`,
        durationMs: Date.now() - started,
      };
    }

    const body = {
      model,
      system_instruction: system,
      input: prompt,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: toGeminiSchema(jsonSchema),
      },
      generation_config: {
        max_output_tokens: env.llm.maxTokens,
        thinking_level: thinkingLevelFor(task),
        // We never show the reasoning, so don't pay to have it summarised.
        thinking_summaries: 'none',
      },
    };

    let response: Response;
    try {
      response = await this.fetchImpl(GEMINI_ENDPOINT, {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(env.llm.timeoutMs),
      });
    } catch (err) {
      const durationMs = Date.now() - started;
      // A timeout must not look like a model refusal; it is a transport failure.
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        // An overloaded model often hangs rather than answering, so this is worth
        // retrying elsewhere.
        return { ...base, error: `Model request timed out after ${env.llm.timeoutMs} ms`, durationMs, retryOnNextModel: true };
      }
      const message = err instanceof Error ? err.message : 'unknown';
      return { ...base, error: `Could not reach the model provider: ${message}`, durationMs, retryOnNextModel: true };
    }

    const raw = await response.text();
    const durationMs = Date.now() - started;

    if (!response.ok) {
      // The body can echo the request back, so only the status is logged.
      logger.error({ task, status: response.status }, 'Gemini request rejected');
      if (response.status === 401 || response.status === 403) {
        return { ...base, error: 'GEMINI_API_KEY was rejected', durationMs };
      }
      if (response.status === 429) {
        return { ...base, error: 'Rate limited by the model provider', durationMs, retryOnNextModel: true };
      }
      if (response.status === 404) {
        return { ...base, error: `Model ${model} is not available to this key`, durationMs, retryOnNextModel: true };
      }
      if (response.status >= 500) {
        // 503 is the "currently experiencing high demand" response.
        return {
          ...base,
          error: `Model ${model} is unavailable (${response.status}): ${safeErrorMessage(raw)}`,
          durationMs,
          retryOnNextModel: true,
        };
      }
      if (response.status === 400) {
        return { ...base, error: `Model request rejected: ${safeErrorMessage(raw)}`, durationMs };
      }
      return { ...base, error: `Model provider error ${response.status}`, durationMs };
    }

    let parsedBody: GeminiInteraction;
    try {
      parsedBody = JSON.parse(raw) as GeminiInteraction;
    } catch {
      return { ...base, error: 'Model provider returned a non-JSON response', durationMs };
    }

    const inputTokens = parsedBody.usage?.total_input_tokens ?? 0;
    // Thinking tokens are billed at the output rate, so they are counted as spend.
    const outputTokens =
      (parsedBody.usage?.total_output_tokens ?? 0) + (parsedBody.usage?.total_thought_tokens ?? 0);
    const costUsd = estimateCostUsd(model, inputTokens, outputTokens);
    await recordUsage({ task, model, inputTokens, outputTokens, costUsd, disputeId });

    const withUsage = { ...base, inputTokens, outputTokens, costUsd, durationMs };

    // Truncation is an outcome to report, not a result to parse.
    if (parsedBody.status === 'incomplete') {
      return { ...withUsage, error: 'Model output was truncated before it completed' };
    }
    if (parsedBody.status && parsedBody.status !== 'completed') {
      return { ...withUsage, error: `Model did not complete the request (${parsedBody.status})` };
    }

    const text = extractText(parsedBody);
    if (text.trim() === '') {
      // An empty body with a clean status is how a safety decline surfaces here.
      return { ...withUsage, error: 'The model returned no output for this request' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ...withUsage, error: 'Model returned no parseable structured output' };
    }

    // The schema guaranteed the shape; zod checks the semantics.
    const check = validator.safeParse(parsed);
    if (!check.success) {
      logger.warn({ task, disputeId }, 'Structured output failed validation');
      return { ...withUsage, error: 'Model output failed validation' };
    }

    return { ...withUsage, ok: true, value: check.data as T };
  }
}

/** Pull the provider's message out of an error body without echoing the whole payload. */
function safeErrorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    const message = parsed.error?.message;
    if (typeof message === 'string' && message.length > 0) return message.slice(0, 300);
  } catch {
    // fall through
  }
  return 'see provider response';
}
