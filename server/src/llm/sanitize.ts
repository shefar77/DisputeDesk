/**
 * Untrusted-text handling (PRD §18).
 *
 * Carrier pages, buyer messages and order records are attacker-controlled as far
 * as this system is concerned: a buyer can type anything into a dispute message,
 * and a carrier page is arbitrary third-party HTML. All of it is wrapped, labelled
 * and neutralised before it reaches a prompt.
 *
 * The real defence is architectural, not textual — the model cannot call a PayPal
 * write endpoint, its output is schema-constrained, and every action needs a
 * human approval bound to a payload hash. This module is the cheap extra layer:
 * it stops the obvious injections from even being persuasive.
 */

/** Sequences that could be read as prompt structure rather than as data. */
const STRUCTURAL_PATTERNS: [RegExp, string][] = [
  // XML/HTML comments are the classic hiding place for injected instructions.
  [/<!--[\s\S]*?-->/g, '[html-comment-removed]'],
  [/<script[\s\S]*?<\/script>/gi, '[script-removed]'],
  [/<style[\s\S]*?<\/style>/gi, '[style-removed]'],
  // Our own delimiters must never appear inside the data we delimit.
  [/<\/?untrusted[^>]*>/gi, '[delimiter-removed]'],
  // Chat-template markers.
  [/<\|[^|>]{0,40}\|>/g, '[token-removed]'],
  [/\b(?:system|assistant|user|human)\s*:\s*$/gim, '[role-marker-removed]'],
];

/** Phrases that are never legitimate content on a carrier tracking page. */
const INJECTION_PHRASES = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/gi,
  /disregard\s+(?:all\s+)?(?:previous|prior|above)/gi,
  /you\s+are\s+now\s+in\s+\w+\s+mode/gi,
  /\badmin\s+mode\b/gi,
  /do\s+not\s+(?:mention|tell|reveal)\s+(?:these|this|the)\s+instructions?/gi,
  /\bnew\s+instructions?\s*:/gi,
  /\boverride\b[^.\n]{0,30}\b(?:instructions?|rules?|policy)\b/gi,
];

export interface SanitizeResult {
  text: string;
  /** True when something that looked like an injection attempt was found. */
  suspicious: boolean;
  /** What was found, for the audit log and the UI warning badge. */
  findings: string[];
}

export function sanitizeUntrusted(input: string, maxLength = 8_000): SanitizeResult {
  const findings: string[] = [];
  let text = input.replace(/\u0000/g, '');

  for (const [pattern, replacement] of STRUCTURAL_PATTERNS) {
    if (pattern.test(text)) {
      findings.push(replacement.replace(/[[\]]/g, ''));
      text = text.replace(pattern, ` ${replacement} `);
    }
    pattern.lastIndex = 0;
  }

  for (const pattern of INJECTION_PHRASES) {
    const matches = text.match(pattern);
    if (matches) {
      findings.push(`instruction-like phrase: "${matches[0].slice(0, 60)}"`);
      // Left visible but defused, so a reviewer can still see what was attempted.
      text = text.replace(pattern, '[instruction-like text neutralised]');
    }
    pattern.lastIndex = 0;
  }

  // Collapse runaway whitespace, then bound the length.
  text = text.replace(/[ \t]{3,}/g, '  ').replace(/\n{4,}/g, '\n\n\n').trim();
  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength)}\n[truncated at ${maxLength} characters]`;
  }

  return { text, suspicious: findings.length > 0, findings };
}

/**
 * Wraps untrusted content in a labelled block. The tag carries a per-call nonce
 * so injected text cannot close the block early and "escape" into instruction
 * position — a closing tag it cannot predict is not forgeable.
 */
export function wrapUntrusted(
  label: string,
  content: string,
  nonce: string,
): string {
  return [
    `<untrusted-${label} id="${nonce}">`,
    content,
    `</untrusted-${label} id="${nonce}">`,
  ].join('\n');
}

/**
 * PII minimisation (PRD §18): the model never needs a buyer's email address, and
 * it only needs an address to compare two of them — which it can do on the
 * normalised form. Full values stay in the database.
 */
export function maskEmails(text: string): string {
  return text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email-masked]');
}

export function maskPhones(text: string): string {
  return text.replace(/(?:\+\d[\d\s().-]{7,}\d)/g, '[phone-masked]');
}

export function minimisePii(text: string): string {
  return maskPhones(maskEmails(text));
}

/** Normalises an address for comparison: case, punctuation and filler removed. */
export function normaliseAddress(value: string): string {
  return value
    .toUpperCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\b(STREET|ST|ROAD|RD|AVENUE|AVE|LANE|LN|WALK|DRIVE|DR|UNITED KINGDOM|UK|USA)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
