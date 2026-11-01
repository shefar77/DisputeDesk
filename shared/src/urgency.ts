/**
 * Deadline triage (FR-3, PRD §13 task T4).
 *
 * Triage ordering is deterministic — by `seller_response_due_date` ascending.
 * The LLM never reorders the queue; it only contributes a one-line "why" string.
 * Colour is never the only urgency signal (PRD §11): every band carries an icon
 * glyph and a text label too.
 */

export const URGENCY_LEVELS = ['OVERDUE', 'CRITICAL', 'URGENT', 'SOON', 'NORMAL', 'NONE'] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

export interface UrgencyInfo {
  level: UrgencyLevel;
  /** Text label — carries the meaning without colour. */
  label: string;
  /** Icon glyph — second non-colour channel. */
  icon: string;
  hoursRemaining: number | null;
  /** Ascending sort key: lower sorts first. Disputes with no deadline sort last. */
  sortKey: number;
}

export const HOURS = {
  critical: 24,
  urgent: 72,
  soon: 168,
} as const;

export function hoursUntil(dueAt: Date | string | null, now: Date = new Date()): number | null {
  if (!dueAt) return null;
  const due = typeof dueAt === 'string' ? new Date(dueAt) : dueAt;
  if (Number.isNaN(due.getTime())) return null;
  return (due.getTime() - now.getTime()) / 3_600_000;
}

export function urgencyFor(dueAt: Date | string | null, now: Date = new Date()): UrgencyInfo {
  const h = hoursUntil(dueAt, now);
  if (h === null) {
    return { level: 'NONE', label: 'No deadline', icon: '–', hoursRemaining: null, sortKey: Number.MAX_SAFE_INTEGER };
  }
  const sortKey = h;
  if (h < 0) return { level: 'OVERDUE', label: 'Overdue', icon: '!!', hoursRemaining: h, sortKey };
  if (h < HOURS.critical) return { level: 'CRITICAL', label: 'Due within 24h', icon: '!', hoursRemaining: h, sortKey };
  if (h < HOURS.urgent) return { level: 'URGENT', label: 'Due within 72h', icon: '*', hoursRemaining: h, sortKey };
  if (h < HOURS.soon) return { level: 'SOON', label: 'Due this week', icon: '~', hoursRemaining: h, sortKey };
  return { level: 'NORMAL', label: 'Not urgent', icon: '.', hoursRemaining: h, sortKey };
}

/** "20h left", "3d 4h left", "6h overdue". */
export function formatDueIn(dueAt: Date | string | null, now: Date = new Date()): string {
  const h = hoursUntil(dueAt, now);
  if (h === null) return '—';
  const overdue = h < 0;
  const abs = Math.abs(h);
  const days = Math.floor(abs / 24);
  const hrs = Math.floor(abs % 24);
  const mins = Math.floor((abs % 1) * 60);
  let text: string;
  if (days > 0) text = `${days}d ${hrs}h`;
  else if (hrs > 0) text = `${hrs}h ${mins}m`;
  else text = `${mins}m`;
  return overdue ? `${text} overdue` : `${text} left`;
}

/** Deterministic queue ordering: soonest deadline first, then larger amounts first. */
export function compareTriage(
  a: { dueAt: string | null; amountValue: string | number | null },
  b: { dueAt: string | null; amountValue: string | number | null },
  now: Date = new Date(),
): number {
  const ua = urgencyFor(a.dueAt, now).sortKey;
  const ub = urgencyFor(b.dueAt, now).sortKey;
  if (ua !== ub) return ua - ub;
  const aa = Number(a.amountValue ?? 0);
  const ab = Number(b.amountValue ?? 0);
  return ab - aa;
}

/** FR-? / J4: when a deadline is this close the UI shows a "submit now" banner. */
export const SUBMIT_NOW_HOURS = 2;

export function shouldWarnSubmitNow(dueAt: string | null, now: Date = new Date()): boolean {
  const h = hoursUntil(dueAt, now);
  return h !== null && h >= 0 && h <= SUBMIT_NOW_HOURS;
}
