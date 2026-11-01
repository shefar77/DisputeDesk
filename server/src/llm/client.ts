/**
 * Provider-agnostic LLM interface (PRD §13) and the Anthropic implementation.
 *
 * Two implementations ship:
 *   - `AnthropicLLM`     — structured outputs (`output_config.format`), so the output
 *                          shape is guaranteed by constrained decoding rather
 *                          than by asking the model to "return only JSON".
 *   - `DeterministicLLM` — rule-based, no network, no key (deterministic.ts).
 *                          It doubles as the "template + checklist" baseline the
 *                          AI eval measures against, which keeps that comparison
 *                          honest: the baseline is real code that really ships.
 *
 * The interface takes *structured* task input rather than a prompt string, so
 * each implementation decides how to consume it. A prompt-string interface would
 * have forced the deterministic generator to parse English back out of a prompt.
 */

import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import type { DisputeAction, DraftOutput, EvidenceItemView, ExtractionOutput, PlanNarrative } from '@shared/index.js';
import { draftOutputSchema, extractionSchema, planNarrativeSchema } from '@shared/index.js';
import { env } from '../env.js';
import { logger } from '../log.js';
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

export type LlmTask = 'extract' | 'plan' | 'draft';

export interface BuyerMessage {
  posted: string;
  by: string;
  content: string;
}

export interface RequirementSummary {
  id: string;
  label: string;
  satisfied: string;
  detail: string;
  critical: boolean;
}

export interface ExtractionInput {
  disputeId: string;
  reason: string;
  items: readonly EvidenceItemView[];
  orderAddress: string | null;
}

export interface PlanInput {
  disputeId: string;
  reason: string;
  amount: string;
  currency: string;
  dueIn: string;
  completeness: number;
  band: string;
  /** True when some evidence actively contradicts the merchant (rubric cap applied). */
  contradicted: boolean;
  requirements: RequirementSummary[];
  availableActions: readonly DisputeAction[];
  items: readonly EvidenceItemView[];
  citations: { id: string; title: string; url: string; snippet: string }[];
  buyerMessages: readonly BuyerMessage[];
}

export interface DraftInput {
  disputeId: string;
  reason: string;
  amount: string;
  currency: string;
  requirements: RequirementSummary[];
  rationale: { claim: string; evidence_ids: string[] }[];
  items: readonly EvidenceItemView[];
  buyerMessages: readonly BuyerMessage[];
  maxChars: number;
}

export interface LlmResult<T> {
  ok: boolean;
  value: T | null;
  /** Surfaced in the UI so a template is never presented as model output. */
  generator: 'llm' | 'deterministic';
  model: string;
  /** Why it failed, when it did. Becomes the "needs manual review" reason. */
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface LLMClient {
  readonly name: string;
  readonly model: string;
  readonly enabled: boolean;
  extract(input: ExtractionInput): Promise<LlmResult<ExtractionOutput>>;
  plan(input: PlanInput): Promise<LlmResult<PlanNarrative>>;
  draft(input: DraftInput): Promise<LlmResult<DraftOutput>>;
}

/**
 * Published per-MTok prices for the models we might be configured with. Used for
 * the spend cap and the cost display. An unknown model is assumed expensive
 * rather than free, so a typo in LLM_MODEL cannot disable the cap.
 */
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES_PER_MTOK[model] ?? { input: 5, output: 25 };
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

type Validator = { safeParse: (v: unknown) => { success: boolean; data?: unknown } };

export class AnthropicLLM implements LLMClient {
  readonly name = 'anthropic';
  readonly enabled = true;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
    /** Injected in tests to inspect the exact wire request without spending money. */
    fetchImpl?: typeof fetch,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
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
   * One call path for all three tasks.
   *
   * Notes on the request shape, which is model-version-sensitive:
   *  - no `temperature`: sampling parameters are rejected with a 400 on current
   *    models. The PRD asked for a low temperature; the equivalent here is
   *    constrained decoding plus scoring done by the rubric, not by the model.
   *  - no `thinking` block: thinking is on by default and cannot be disabled on
   *    these models. Depth is controlled by `output_config.effort` instead.
   *  - effort `low` for extraction (mechanical copying out of text), `medium` for
   *    the two judgement tasks. This is the cost/quality lever.
   */
  private async call<T>(
    task: LlmTask,
    system: string,
    prompt: string,
    jsonSchema: Parameters<typeof jsonSchemaOutputFormat>[0],
    validator: Validator,
    disputeId: string,
  ): Promise<LlmResult<T>> {
    const started = Date.now();
    const base: LlmResult<T> = {
      ok: false,
      value: null,
      generator: 'llm',
      model: this.model,
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

    try {
      // create() rather than parse(): parse() throws on a refusal's empty body before
      // stop_reason can be inspected. The format object still constrains decoding.
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system,
        output_config: {
          format: jsonSchemaOutputFormat(jsonSchema),
          effort: task === 'extract' ? 'low' : 'medium',
        },
        messages: [{ role: 'user', content: prompt }],
      });

      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      const costUsd = estimateCostUsd(this.model, inputTokens, outputTokens);
      await recordUsage({ task, model: this.model, inputTokens, outputTokens, costUsd, disputeId });

      const withUsage = {
        ...base,
        inputTokens,
        outputTokens,
        costUsd,
        durationMs: Date.now() - started,
      };

      // A safety decline is an outcome to report, not an exception to throw.
      if (response.stop_reason === 'refusal') {
        return { ...withUsage, error: 'The model declined this request' };
      }
      if (response.stop_reason === 'max_tokens') {
        return { ...withUsage, error: 'Model output was truncated before it completed' };
      }

      const text = response.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
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
    } catch (err) {
      const durationMs = Date.now() - started;
      if (err instanceof Anthropic.AuthenticationError) {
        return { ...base, error: 'ANTHROPIC_API_KEY was rejected', durationMs };
      }
      if (err instanceof Anthropic.RateLimitError) {
        return { ...base, error: 'Rate limited by the model provider', durationMs };
      }
      if (err instanceof Anthropic.BadRequestError) {
        logger.error({ task, message: err.message }, 'Model request rejected');
        return { ...base, error: `Model request rejected: ${err.message}`, durationMs };
      }
      if (err instanceof Anthropic.APIError) {
        return { ...base, error: `Model provider error ${err.status}`, durationMs };
      }
      return { ...base, error: err instanceof Error ? err.message : 'Unknown model error', durationMs };
    }
  }
}
