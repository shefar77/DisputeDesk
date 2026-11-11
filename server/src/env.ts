/**
 * Configuration.
 *
 * Design rule (PRD §18): every integration is optional and every absence has a
 * documented fallback. A fresh clone with no secrets at all must boot and run the
 * complete P0 loop in demo mode — that is both the judge path (R9) and the test
 * path. Adding a key upgrades one subsystem and nothing else.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../..');

/** Minimal .env loader — avoids a dependency for one function. */
function loadDotEnv(): void {
  for (const file of ['.env', '.env.local']) {
    try {
      const text = readFileSync(resolve(repoRoot, file), 'utf8');
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      // absent .env is the normal case for a fresh clone
    }
  }
}
loadDotEnv();

const str = (k: string): string | null => {
  const v = process.env[k];
  return v && v.trim() !== '' ? v.trim() : null;
};
const num = (k: string, dflt: number): number => {
  const v = str(k);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const bool = (k: string, dflt: boolean): boolean => {
  const v = str(k);
  if (v === null) return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

const anthropicKey = str('ANTHROPIC_API_KEY');
const geminiKey = str('GEMINI_API_KEY');

/**
 * Which provider generates the text.
 *
 * An explicit `LLM_PROVIDER` always wins, so a key left in the environment can
 * never silently override a deliberate choice. Otherwise whichever key is
 * present decides, and with neither we run the rule-based generator — which is
 * a supported mode, not an error: a fresh clone with no secrets must still work.
 */
export type LlmProvider = 'gemini' | 'anthropic' | 'none';
const requestedProvider = (str('LLM_PROVIDER') ?? '').toLowerCase();
const llmProvider: LlmProvider =
  requestedProvider === 'gemini' || requestedProvider === 'anthropic'
    ? requestedProvider
    : geminiKey
      ? 'gemini'
      : anthropicKey
        ? 'anthropic'
        : 'none';

/** Flash is the right tier here: the tasks are short, schema-constrained and high-volume. */
const DEFAULT_MODEL: Record<LlmProvider, string> = {
  gemini: 'gemini-3-flash-preview',
  anthropic: 'claude-opus-5-5',
  none: 'rules-v1',
};

/**
 * Models to try when the preferred one is unavailable.
 *
 * The newest Flash tiers answer a free-tier request with a 503 "currently
 * experiencing high demand" whenever they are busy, which is a property of the
 * moment and not of the request. Falling back to a less contended model keeps
 * real AI output on screen instead of dropping to the rule-based template.
 */
const DEFAULT_FALLBACK_MODELS: Record<LlmProvider, string[]> = {
  gemini: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'],
  anthropic: [],
  none: [],
};

const csv = (k: string): string[] | null => {
  const v = str(k);
  return v === null ? null : v.split(',').map((x) => x.trim()).filter(Boolean);
};

const paypalClientId = str('PAYPAL_CLIENT_ID');
const paypalClientSecret = str('PAYPAL_CLIENT_SECRET');

/**
 * `demo`    — no PayPal credentials. Fixture disputes, fixture carrier pages.
 *             Every write is recorded locally and clearly marked as not sent.
 * `sandbox` — real PayPal sandbox credentials present. Real reads and real writes
 *             against sandbox objects. Test money only.
 * `live`    — refused. DisputeDesk is a hackathon project; it has no business
 *             touching real disputes, and PRD §7 lists production money movement
 *             as an explicit non-goal.
 */
export type RunMode = 'demo' | 'sandbox' | 'live';

const requestedEnv = (str('PAYPAL_ENV') ?? 'sandbox').toLowerCase();
const hasPayPalCreds = Boolean(paypalClientId && paypalClientSecret);
const forceDemo = bool('DEMO_MODE', false);

let mode: RunMode;
if (forceDemo || !hasPayPalCreds) mode = 'demo';
else if (requestedEnv === 'live') mode = 'live';
else mode = 'sandbox';

export const env = {
  mode,
  /** True when no outbound PayPal write may leave the process. */
  isDemo: mode === 'demo',
  nodeEnv: str('NODE_ENV') ?? 'development',
  port: num('PORT', 8787),
  host: str('HOST') ?? '0.0.0.0',
  version: '1.0.0',

  /** Reason demo mode is active, surfaced in /api/health and the UI banner. */
  demoReason: forceDemo
    ? 'DEMO_MODE is set'
    : hasPayPalCreds
      ? null
      : 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set',

  paypal: {
    clientId: paypalClientId,
    clientSecret: paypalClientSecret,
    webhookId: str('PAYPAL_WEBHOOK_ID'),
    /** Hard-coded to sandbox unless explicitly overridden; see RunMode above. */
    baseUrl:
      mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
    /** When false, an unverifiable webhook is rejected (FR-1). Never relax in sandbox+. */
    requireWebhookSignature: bool('PAYPAL_REQUIRE_WEBHOOK_SIGNATURE', mode !== 'demo'),
    pollIntervalMinutes: num('POLL_INTERVAL_MINUTES', 10),
    pollEnabled: bool('POLL_ENABLED', true),
  },

  db: {
    /** Set -> real Postgres (Render, docker compose). Unset -> embedded PGlite. */
    url: str('DATABASE_URL'),
    /** Where PGlite keeps its data directory. */
    pgliteDir: str('PGLITE_DIR') ?? resolve(repoRoot, '.data/pglite'),
  },

  llm: {
    provider: llmProvider,
    /** The key for the selected provider only; the other one is never read. */
    apiKey: llmProvider === 'gemini' ? geminiKey : llmProvider === 'anthropic' ? anthropicKey : null,
    model: str('LLM_MODEL') ?? DEFAULT_MODEL[llmProvider],
    /** Tried in order, only when the preferred model is unavailable. */
    fallbackModels: csv('LLM_FALLBACK_MODELS') ?? DEFAULT_FALLBACK_MODELS[llmProvider],
    /**
     * A hung provider must not hold a dispute workflow open indefinitely. Kept
     * tight because an overloaded model tends to hang rather than answer, and
     * the next model in the chain is usually seconds away.
     */
    timeoutMs: num('LLM_TIMEOUT_MS', 30_000),
    /**
     * Thinking is always on for current models and its tokens count towards this
     * ceiling, so a tight limit truncates the answer and silently demotes the
     * result to the rule-based generator. 8k leaves room for all three tasks.
     * No `temperature`: current models reject sampling parameters with a 400.
     */
    maxTokens: num('LLM_MAX_TOKENS', 8192),
    /** PRD §13: hard stop in code, not a warning. */
    dailyCapUsd: num('LLM_DAILY_CAP_USD', 5),
  },

  elastic: {
    url: str('ELASTIC_URL') ?? str('ELASTICSEARCH_URL'),
    apiKey: str('ELASTIC_API_KEY'),
    cloudId: str('ELASTIC_CLOUD_ID'),
    policiesIndex: str('ELASTIC_POLICIES_INDEX') ?? 'disputedesk-policies',
  },

  kernel: {
    apiKey: str('KERNEL_API_KEY'),
    baseUrl: str('KERNEL_BASE_URL') ?? 'https://api.onkernel.com',
    timeoutMs: num('KERNEL_TIMEOUT_MS', 45_000),
  },

  zapier: {
    mcpUrl: str('ZAPIER_MCP_URL'),
    /** PRD FR-15: the tool call happens only after the merchant approves it. */
    requireApproval: true,
  },

  storage: {
    uploadsDir: str('UPLOADS_DIR') ?? resolve(repoRoot, '.data/uploads'),
    capturesDir: str('CAPTURES_DIR') ?? resolve(repoRoot, '.data/captures'),
  },

  auth: {
    /** Single shared demo credential (PRD §18). Absent -> no login required. */
    demoPassword: str('DEMO_PASSWORD'),
    sessionSecret: str('SESSION_SECRET') ?? 'disputedesk-dev-only-not-a-secret',
  },

  /** Shared secret for the Render cron job calling POST /api/cron/poll. */
  cronSecret: str('CRON_SECRET'),

  /**
   * Run the evidence workflow for every dispute during boot.
   *
   * On by default so a fresh clone shows a populated queue. It uses the
   * rule-based generator (see index.ts), so it costs nothing and needs no
   * network; set it to false on a very small instance if even that is too much.
   */
  gatherOnBoot: bool('GATHER_ON_BOOT', true),

  /** Approver identity recorded on every approval row. */
  operator: str('OPERATOR_NAME') ?? 'Demo Merchant',
} as const;

/** SSRF control (PRD §18): KERNEL may only ever open these hosts. */
export const CARRIER_HOST_ALLOWLIST: readonly string[] = [
  'www.ups.com',
  'wwwapps.ups.com',
  'tools.usps.com',
  'www.fedex.com',
  'www.dhl.com',
  'www.royalmail.com',
  'www.parcelforce.com',
  'www.canadapost-postescanada.ca',
  // Deterministic public test page used by the demo and the e2e tests.
  'httpbin.org',
  'example.com',
];

export function isAllowedCarrierHost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return CARRIER_HOST_ALLOWLIST.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

if (env.mode === 'live') {
  // Fail loudly rather than quietly pointing a hackathon build at real disputes.
  throw new Error(
    'PAYPAL_ENV=live is refused. DisputeDesk is sandbox-only by design (PRD §7 non-goals). ' +
      'Unset PAYPAL_ENV or set it to "sandbox".',
  );
}
