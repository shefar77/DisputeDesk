/**
 * Logging with redaction.
 *
 * PRD §18 requires that logs never carry `Authorization` headers, bearer tokens,
 * API keys or buyer email addresses. Redaction is applied here rather than at the
 * call sites, because a rule that depends on every caller remembering it is not a
 * rule. Fastify's logger is configured with the same `redact` paths in app.ts.
 */

const SENSITIVE_KEY_RE =
  /^(authorization|cookie|set-cookie|password|secret|token|access_token|client_secret|api_?key|apikey|session|paypal-transmission-sig)$/i;

const SECRET_VALUE_RES: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._\-]{12,}/gi,
  /\bA2[13][A-Za-z0-9._\-]{20,}/g, // PayPal access tokens
  /\bsk-ant-[A-Za-z0-9._\-]{16,}/g, // Anthropic keys
  /\bAIza[A-Za-z0-9_\-]{20,}/g, // Google / Gemini API keys
  /\bAQ\.[A-Za-z0-9_\-.]{20,}/g, // Google AI Studio keys (newer AQ. format)
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // email addresses
];

export function redactValue(value: string): string {
  let out = value;
  for (const re of SECRET_VALUE_RES) out = out.replace(re, '[redacted]');
  return out;
}

/** Deep-redacts an object for logging or for the audit log. */
export function redact(input: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]';
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return redactValue(input);
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  if (Buffer.isBuffer(input)) return `[buffer ${input.byteLength}B]`;
  if (Array.isArray(input)) return input.map((v) => redact(v, depth + 1));
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '[redacted]' : redact(value, depth + 1);
    }
    return out;
  }
  return '[unserialisable]';
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

function emit(level: Level, context: unknown, message: string): void {
  if (LEVELS[level] < threshold) return;
  const line = {
    level,
    time: new Date().toISOString(),
    msg: redactValue(message),
    ...(context && typeof context === 'object' ? (redact(context) as object) : {}),
  };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(line)}\n`);
}

function make(level: Level) {
  return (contextOrMessage: unknown, message?: string): void => {
    if (typeof contextOrMessage === 'string') emit(level, null, contextOrMessage);
    else emit(level, contextOrMessage, message ?? '');
  };
}

export const logger = {
  debug: make('debug'),
  info: make('info'),
  warn: make('warn'),
  error: make('error'),
};

/** Fastify `redact.paths` — belt and braces alongside the above. */
export const FASTIFY_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["paypal-transmission-sig"]',
  'res.headers["set-cookie"]',
];
