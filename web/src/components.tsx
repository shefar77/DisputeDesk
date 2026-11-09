/** Shared presentational components. Status is always text + icon + colour, never colour alone. */

import { useEffect, type ReactNode } from 'react';
import type { CompletenessBand, DisputeStatus, GatherState, UrgencyInfo, WorkflowStepView } from '@shared/index.js';
import { Icon, type IconName } from './icons';

type Tone = 'danger' | 'warning' | 'info' | 'success' | 'neutral';

/** "WAITING_FOR_SELLER_RESPONSE" -> "Waiting for seller response". */
export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  const s = value.replace(/[_-]+/g, ' ').toLowerCase().trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "demo-merchant" -> { name: "Demo Merchant", initials: "DM" }. */
export function operatorIdentity(raw: string): { name: string; initials: string } {
  const words = raw.replace(/[_.-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'Operator';
  const initials = (words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2)).toUpperCase();
  return { name, initials };
}

// ---------------------------------------------------------------------------
// environment

/**
 * Replaces the full-width sandbox banner (FR-13). Present on every page via the
 * header; the tooltip and the Settings page carry the full explanation.
 */
export function EnvironmentBadge({ mode }: { mode: string }) {
  const demo = mode === 'demo';
  return (
    <span
      className={`env-badge ${demo ? 'demo' : 'sandbox'}`}
      data-testid="env-badge"
      title={
        demo
          ? 'Demo environment: sample disputes. Approved actions are recorded locally and never sent to PayPal. No real funds move.'
          : 'Connected to the PayPal sandbox. Test accounts only. No real funds move.'
      }
    >
      <span className="dot" aria-hidden="true" />
      {demo ? 'Demo environment' : 'PayPal Sandbox'}
    </span>
  );
}

// ---------------------------------------------------------------------------
// badges

const URGENCY: Record<UrgencyInfo['level'], { tone: Tone; icon: IconName; label: string }> = {
  OVERDUE: { tone: 'danger', icon: 'alertTriangle', label: 'Overdue' },
  CRITICAL: { tone: 'danger', icon: 'alertCircle', label: 'Due within 24h' },
  URGENT: { tone: 'warning', icon: 'clock', label: 'Due within 72h' },
  SOON: { tone: 'info', icon: 'calendar', label: 'Due this week' },
  NORMAL: { tone: 'neutral', icon: 'calendar', label: 'On track' },
  NONE: { tone: 'neutral', icon: 'minus', label: 'No deadline' },
};

export function UrgencyBadge({ urgency }: { urgency: UrgencyInfo }) {
  const u = URGENCY[urgency.level];
  return (
    <span className={`badge tone-${u.tone}`} title={urgency.label}>
      <Icon name={u.icon} />
      {u.label}
    </span>
  );
}

export const BAND_TONE: Record<CompletenessBand, Tone> = {
  WEAK: 'danger',
  PARTIAL: 'warning',
  STRONG: 'info',
  COMPLETE: 'success',
};

export const BAND_COLOR: Record<string, string> = {
  WEAK: 'var(--danger)',
  PARTIAL: '#d97706',
  STRONG: 'var(--info)',
  COMPLETE: 'var(--success)',
};

export function BandBadge({ band }: { band: string | null }) {
  if (!band) return <span className="badge tone-neutral">Not scored</span>;
  return <span className={`badge tone-${BAND_TONE[band as CompletenessBand] ?? 'neutral'}`}>{humanize(band)}</span>;
}

const STATUS: Record<DisputeStatus, { label: string; short: string; color: string }> = {
  OPEN: { label: 'Open', short: 'Open', color: 'var(--info)' },
  WAITING_FOR_SELLER_RESPONSE: { label: 'Awaiting your response', short: 'Awaiting response', color: '#d97706' },
  WAITING_FOR_BUYER_RESPONSE: { label: 'Awaiting buyer', short: 'Awaiting buyer', color: 'var(--neutral)' },
  UNDER_REVIEW: { label: 'Under review by PayPal', short: 'Under review', color: 'var(--info)' },
  RESOLVED: { label: 'Resolved', short: 'Resolved', color: 'var(--success)' },
  OTHER: { label: 'Other', short: 'Other', color: 'var(--neutral)' },
};

/** PayPal's dispute status. `compact` for table cells. */
export function StatusBadge({ status, compact = false }: { status: DisputeStatus; compact?: boolean }) {
  const s = STATUS[status] ?? { label: humanize(status), short: humanize(status), color: 'var(--neutral)' };
  return (
    <span className="status-dot" style={{ ['--dot' as string]: s.color }} title={s.label}>
      {compact ? s.short : s.label}
    </span>
  );
}

const GATHER: Record<GatherState, { label: string; tone: Tone; icon: IconName | null }> = {
  NOT_STARTED: { label: 'Not started', tone: 'neutral', icon: null },
  GATHERING: { label: 'Collecting evidence', tone: 'info', icon: null },
  READY_FOR_REVIEW: { label: 'Ready for review', tone: 'success', icon: 'checkCircle' },
  NEEDS_MANUAL_REVIEW: { label: 'Manual review', tone: 'warning', icon: 'alertCircle' },
  SUBMITTED: { label: 'Submitted', tone: 'neutral', icon: 'fileCheck' },
  FAILED: { label: 'Collection failed', tone: 'danger', icon: 'x' },
};

/** DisputeDesk's own workflow state for the dispute. */
export function GatherBadge({ state }: { state: GatherState }) {
  const g = GATHER[state] ?? { label: humanize(state), tone: 'neutral' as Tone, icon: null };
  return (
    <span className={`badge pill tone-${g.tone}`}>
      {state === 'GATHERING' ? <span className="spinner" style={{ width: 11, height: 11 }} aria-hidden="true" /> : g.icon && <Icon name={g.icon} />}
      {g.label}
    </span>
  );
}

/** Labels who wrote a piece of text: the model or the standard template. */
export function SourceTag({ generator, model }: { generator: 'llm' | 'deterministic'; model: string }) {
  return generator === 'llm' ? (
    <span className="source-tag ai" title={`Generated by ${model}`}>
      <Icon name="sparkles" size={13} />
      AI draft · review before sending
    </span>
  ) : (
    <span className="source-tag template" title="Written from the standard template; no AI model was used">
      <Icon name="fileText" size={13} />
      Standard template · review before sending
    </span>
  );
}

// ---------------------------------------------------------------------------
// score + workflow

export function CompletenessRing({ score, band }: { score: number; band: string }) {
  return (
    <div
      className="ring"
      style={{ ['--pct' as string]: score, ['--col' as string]: BAND_COLOR[band] ?? 'var(--neutral)' }}
      role="img"
      aria-label={`Evidence completeness ${score} out of 100, ${band.toLowerCase()}`}
    >
      <div>
        <div>
          <strong>{score}</strong>
          <small>/ 100</small>
        </div>
      </div>
    </div>
  );
}

const STEP_ICON: Record<WorkflowStepView['status'], IconName | null> = {
  pending: 'circle',
  running: null,
  succeeded: 'check',
  failed: 'x',
  skipped: 'minus',
};

function duration(ms: number | null): string {
  if (ms === null) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function WorkflowSteps({ steps }: { steps: WorkflowStepView[] }) {
  if (steps.length === 0) {
    return (
      <EmptyState icon="activity" title="Not run yet">
        Evidence collection starts automatically when a dispute arrives.
      </EmptyState>
    );
  }
  return (
    <ol className="steps" aria-live="polite">
      {steps.map((s) => (
        <li className="step" key={s.name}>
          <span className={`step-icon ${s.status}`} aria-label={s.status}>
            {s.status === 'running' ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Icon name={STEP_ICON[s.status]!} />}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="step-title">{s.label}</div>
            {s.detail && <div className="step-detail">{s.detail}</div>}
            {s.fallbackUsed && (
              <div className="step-fallback">
                <Icon name="cornerDownRight" size={13} />
                <span>Fallback: {s.fallbackUsed}</span>
              </div>
            )}
          </div>
          <div className="step-meta">
            {duration(s.durationMs)}
            {s.attempts > 1 && <div>{s.attempts} attempts</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Renders text with E-n evidence citations highlighted. */
export function Cited({ text }: { text: string }) {
  const parts = text.split(/(\bE-\d+\b)/g);
  return (
    <>
      {parts.map((p, i) => (/^E-\d+$/.test(p) ? <span key={i} className="cite">{p}</span> : <span key={i}>{p}</span>))}
    </>
  );
}

// ---------------------------------------------------------------------------
// feedback

const NOTICE_ICON: Record<'warn' | 'danger' | 'info' | 'ok', IconName> = {
  warn: 'alertTriangle',
  danger: 'alertCircle',
  info: 'info',
  ok: 'checkCircle',
};
const NOTICE_TONE: Record<'warn' | 'danger' | 'info' | 'ok', Tone> = {
  warn: 'warning',
  danger: 'danger',
  info: 'info',
  ok: 'success',
};

export function Notice({ tone, title, children }: { tone: 'warn' | 'danger' | 'info' | 'ok'; title?: string; children?: ReactNode }) {
  return (
    <div className={`notice tone-${NOTICE_TONE[tone]}`} role={tone === 'danger' ? 'alert' : 'note'}>
      <Icon name={NOTICE_ICON[tone]} />
      <div className="grow">
        {title && <div className="notice-title">{title}</div>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

export function Toast({
  tone,
  title,
  children,
  onClose,
}: {
  tone: 'ok' | 'danger' | 'info';
  title: string;
  children?: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onClose, 9000);
    return () => clearTimeout(t);
  }, [onClose]);
  const tn = NOTICE_TONE[tone];
  return (
    <div className="toast" role="status">
      <span className={`toast-icon tone-${tn}`} style={{ border: '1px solid' }}>
        <Icon name={NOTICE_ICON[tone]} size={15} />
      </span>
      <div className="grow">
        <div className="toast-title">{title}</div>
        {children && <div className="toast-body">{children}</div>}
      </div>
      <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Dismiss">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={20} />
      </span>
      <strong>{title}</strong>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spinner" /> {label}
    </div>
  );
}
