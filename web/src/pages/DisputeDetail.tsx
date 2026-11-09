/** Dispute detail (PRD §11 screen 2): evidence, strategy, draft, timeline and PayPal data. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  DISPUTE_ACTION_LABELS,
  FILE_LIMITS,
  carrierDisplayName,
  shouldWarnSubmitNow,
  type DisputeAction,
  type EvidenceItemView,
  type TimelineEntry,
} from '@shared/index.js';
import { api, ApiError, money, when, type ApproveResult, type Detail } from '../api';
import { ApprovalModal } from '../ApprovalModal';
import {
  BandBadge,
  Cited,
  CompletenessRing,
  EmptyState,
  GatherBadge,
  Loading,
  Notice,
  SourceTag,
  StatusBadge,
  Toast,
  UrgencyBadge,
  WorkflowSteps,
  humanize,
} from '../components';
import { Icon, type IconName } from '../icons';

type Tab = 'evidence' | 'draft' | 'timeline' | 'raw';

const SOURCE: Record<string, { label: string; tone: string }> = {
  paypal: { label: 'PayPal', tone: 'info' },
  kernel: { label: 'Carrier capture', tone: 'success' },
  zapier: { label: 'Zapier', tone: 'warning' },
  upload: { label: 'Uploaded', tone: 'neutral' },
  fixture: { label: 'Sample data', tone: 'outline' },
};

const KIND: Record<string, { label: string; icon: IconName }> = {
  paypal_dispute: { label: 'Dispute record', icon: 'scale' },
  paypal_transaction: { label: 'Transaction', icon: 'receipt' },
  paypal_shipment_tracking: { label: 'Shipment tracking', icon: 'truck' },
  carrier_capture: { label: 'Carrier tracking page', icon: 'globe' },
  order_record: { label: 'Order record', icon: 'clipboard' },
  upload: { label: 'Document', icon: 'paperclip' },
  buyer_message: { label: 'Buyer message', icon: 'message' },
};

const REQ_ICON: Record<string, IconName> = { yes: 'check', partial: 'minus', no: 'x' };

export function DisputeDetailPage({ mode }: { mode: string }) {
  const { id = '' } = useParams();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('evidence');
  const [action, setAction] = useState<DisputeAction | null>(null);
  const [toast, setToast] = useState<{ tone: 'ok' | 'danger' | 'info'; title: string; body: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setD(await api.dispute(id));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'This dispute could not be found.' : e instanceof Error ? e.message : 'Failed to load');
    }
  }, [id]);

  // Poll quickly while the workflow runs so steps update live; slowly otherwise.
  const live = d?.running || d?.gatherState === 'GATHERING';
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => void load(), live ? 700 : 5000);
    return () => clearInterval(t);
  }, [load, live]);

  const crumbs = (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <Link to="/">Disputes</Link>
      <Icon name="chevronRight" size={14} />
      <span className="current">{id}</span>
    </nav>
  );

  if (error) {
    return (
      <>
        {crumbs}
        <Notice tone="danger" title="Unable to open dispute">
          {error}
        </Notice>
      </>
    );
  }
  if (!d) {
    return (
      <>
        {crumbs}
        <Loading label="Loading dispute…" />
      </>
    );
  }

  const plan = d.plan;
  const recommended = plan?.narrative.recommended_action ?? null;
  const ordered = [...d.allowedActions].sort((a, b) => (a === recommended ? -1 : b === recommended ? 1 : 0));
  // The response deadline stops mattering once PayPal is reviewing or has decided.
  const resolved = d.status === 'RESOLVED';
  const withPayPal = d.status === 'UNDER_REVIEW';
  const critical = !resolved && !withPayPal && (d.urgency.level === 'CRITICAL' || d.urgency.level === 'OVERDUE');
  const outcome = (d.raw as { dispute_outcome?: { outcome_code?: string } } | null)?.dispute_outcome?.outcome_code ?? null;

  async function regather() {
    await api.refresh(id);
    setTab('evidence');
    void load();
  }

  async function simulate(outcome: 'seller' | 'buyer') {
    await api.simulateResolve(id, outcome);
    setTab('timeline');
    void load();
  }

  function onDone(r: ApproveResult) {
    setAction(null);
    const status = humanize(r.disputeStatus);
    setToast(
      r.ok
        ? r.simulated
          ? {
              tone: 'ok',
              title: 'Submission recorded',
              body: `Demo environment: recorded locally, not transmitted to PayPal. PayPal status: ${status}.`,
            }
          : { tone: 'ok', title: 'Submitted to PayPal', body: `Accepted (HTTP ${r.httpStatus}). PayPal status: ${status}.` }
        : {
            tone: 'danger',
            title: 'PayPal did not accept the request',
            body: `${r.error ?? 'Unknown error'}${r.debugId ? ` · debug_id ${r.debugId}` : ''}`,
          },
    );
    setTab('timeline');
    void load();
  }

  return (
    <>
      {crumbs}

      {/* --------------------------------------------------------------- hero */}
      <section className="card hero" aria-labelledby="dispute-title">
        <div>
          <div className="hero-title">
            <h1 id="dispute-title">{d.reasonLabel}</h1>
            <StatusBadge status={d.status} />
            <GatherBadge state={d.gatherState} />
          </div>
          <div className="meta-grid">
            <div>
              <div className="meta-label">Disputed amount</div>
              <div className="meta-value">{money(d.amountValue, d.amountCurrency)}</div>
            </div>
            <div>
              <div className="meta-label">Dispute ID</div>
              <div className="meta-value mono" style={{ fontSize: 13.5 }}>
                {d.id}
              </div>
            </div>
            <div>
              <div className="meta-label">Stage</div>
              <div className="meta-value">{humanize(d.stage)}</div>
            </div>
            <div>
              <div className="meta-label">Opened</div>
              <div className="meta-value">{when(d.createdAt)}</div>
            </div>
            <div>
              <div className="meta-label">Respond by</div>
              <div className="meta-value">{when(d.sellerResponseDueDate)}</div>
            </div>
            <div>
              <div className="meta-label">Data source</div>
              <div className="meta-value">{d.fixture ? 'Sample dataset' : 'PayPal'}</div>
            </div>
          </div>
        </div>
        {resolved ? (
          <div className="deadline">
            <span className="label">Outcome</span>
            <span className="value">Resolved</span>
            {outcome && (
              <span className={`badge tone-${/SELLER/.test(outcome) ? 'success' : /BUYER/.test(outcome) ? 'danger' : 'neutral'}`}>
                {humanize(outcome.replace(/^RESOLVED_/, ''))}
              </span>
            )}
          </div>
        ) : withPayPal ? (
          <div className="deadline">
            <span className="label">Status</span>
            <span className="value">With PayPal</span>
            <span className="badge tone-info">
              <Icon name="clock" />
              Awaiting decision
            </span>
          </div>
        ) : (
          <div className={`deadline ${critical ? 'critical' : ''}`}>
            <span className="label">Time remaining</span>
            <span className="value">{d.dueIn}</span>
            <UrgencyBadge urgency={d.urgency} />
          </div>
        )}
      </section>

      <div className="notices">
        {!resolved && !withPayPal && shouldWarnSubmitNow(d.sellerResponseDueDate) && (
          <Notice tone="danger" title="Less than 2 hours remaining">
            Submit now. A response received after the deadline cannot be considered.
          </Notice>
        )}
        {d.guidance.map((g) => (
          <Notice key={g} tone="warn">
            {g}
          </Notice>
        ))}
        {d.gatherState === 'NEEDS_MANUAL_REVIEW' && d.supported && (
          <Notice tone="warn" title="Manual review required">
            Extraction confidence ({plan?.facts.confidence.toFixed(2) ?? '—'}) was too low to draft a response safely. Review the
            evidence, add proof of shipment or delivery, or take the recommended action.
          </Notice>
        )}
      </div>

      <div className="layout">
        {/* ----------------------------------------------------- left column */}
        <div className="stack">
          <section className="card" aria-labelledby="strength-h">
            <div className="card-header">
              <div>
                <h2 id="strength-h" className="card-title">
                  Evidence strength
                </h2>
                <div className="card-subtitle">Scored against a fixed rubric</div>
              </div>
              {plan && <BandBadge band={plan.band} />}
            </div>
            <div className="card-body">
              {!plan ? (
                <EmptyState icon="scale" title={d.supported ? 'Not scored yet' : 'Manual handling'}>
                  {d.supported ? 'The score appears once evidence collection finishes.' : 'This dispute reason is not scored automatically.'}
                </EmptyState>
              ) : (
                <>
                  <div className="score-head">
                    <CompletenessRing score={plan.completeness} band={plan.band} />
                    <div className="small">
                      <div className="strong">Deterministic, not AI-judged</div>
                      <div className="muted" style={{ marginTop: 2 }}>
                        Each requirement is weighted; partially met requirements earn 40% of their points.
                      </div>
                      {plan.capped && (
                        <div style={{ marginTop: 6, color: 'var(--warning)', fontWeight: 600 }}>
                          Capped at {plan.completeness} (uncapped {plan.rawCompleteness}): some evidence contradicts delivery.
                        </div>
                      )}
                    </div>
                  </div>
                  <ul className="reqs">
                    {plan.requirements.map((r) => (
                      <li className="req" key={r.id} title={r.why}>
                        <span
                          className={`req-icon ${r.satisfied}`}
                          aria-label={r.satisfied === 'yes' ? 'met' : r.satisfied === 'partial' ? 'partially met' : 'not met'}
                        >
                          <Icon name={REQ_ICON[r.satisfied]!} />
                        </span>
                        <div>
                          <div className="req-title">
                            {r.label}
                            {r.critical && <span className="chip-critical">Critical</span>}
                          </div>
                          <div className="req-detail">{r.detail}</div>
                        </div>
                        <span className="req-pts">
                          {r.earned}/{r.weight}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </section>

          <section className="card" aria-labelledby="collect-h">
            <div className="card-header">
              <div>
                <h2 id="collect-h" className="card-title">
                  Evidence collection
                </h2>
                <div className="card-subtitle">Each step is logged and retried on failure</div>
              </div>
              <button className="btn btn-sm" onClick={() => void regather()} disabled={live}>
                {live ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Icon name="refresh" size={14} />}
                {live ? 'Running' : 'Re-run'}
              </button>
            </div>
            <div className="card-body" style={{ paddingTop: 8, paddingBottom: 8 }}>
              <WorkflowSteps steps={d.steps} />
            </div>
          </section>
        </div>

        {/* ---------------------------------------------------- right column */}
        <div className="stack">
          <section className="card" aria-labelledby="actions-h">
            <div className="card-header">
              <div>
                <h2 id="actions-h" className="card-title">
                  Available actions
                </h2>
                <div className="card-subtitle">
                  Offered by PayPal for this dispute&apos;s current stage. Every action requires your approval.
                </div>
              </div>
            </div>
            <div className="card-body stack" style={{ gap: 14 }}>
              {ordered.length === 0 ? (
                <div className="muted small">PayPal is not offering any actions on this dispute at the moment.</div>
              ) : (
                <div className="action-bar">
                  {ordered.map((a) => {
                    const isRec = a === recommended;
                    return (
                      <button
                        key={a}
                        className={`btn ${isRec ? 'btn-primary' : ''}`}
                        data-recommended={isRec ? 'true' : undefined}
                        onClick={() => setAction(a)}
                        disabled={live || (a === 'provide-evidence' && !d.draft)}
                        title={DISPUTE_ACTION_LABELS[a].consequence}
                      >
                        {DISPUTE_ACTION_LABELS[a].label}
                        {isRec && <span className="tag">Recommended</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              {plan && ordered.length > 0 && (
                <div className="recommendation">
                  <Icon name="sparkles" />
                  <div>
                    <span className="strong">{recommended ? DISPUTE_ACTION_LABELS[recommended].label : 'Recommendation'}: </span>
                    {plan.narrative.recommended_action_why}
                  </div>
                </div>
              )}
              {mode === 'demo' && d.status === 'UNDER_REVIEW' && (
                <div className="demo-controls">
                  <span className="label">
                    <Icon name="scale" size={15} />
                    Demo controls: simulate PayPal&apos;s decision
                  </span>
                  <div className="grow" />
                  <button className="btn btn-sm" onClick={() => void simulate('seller')}>
                    Seller wins
                  </button>
                  <button className="btn btn-sm" onClick={() => void simulate('buyer')}>
                    Buyer wins
                  </button>
                </div>
              )}
            </div>
          </section>

          <section className="card">
            <div className="tabs" role="tablist" aria-label="Dispute details">
              {(
                [
                  ['evidence', 'Evidence', d.evidence.length],
                  ['draft', 'Strategy & draft', null],
                  ['timeline', 'Timeline', d.timeline.length],
                  ['raw', 'PayPal data', null],
                ] as [Tab, string, number | null][]
              ).map(([k, label, n]) => (
                <button key={k} role="tab" className="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                  {label}
                  {n !== null && <span className="count">{n}</span>}
                </button>
              ))}
            </div>
            <div className="card-body" role="tabpanel">
              {tab === 'evidence' && <EvidenceTab d={d} onUploaded={() => void load()} />}
              {tab === 'draft' && <DraftTab d={d} />}
              {tab === 'timeline' && <TimelineTab d={d} />}
              {tab === 'raw' && <RawTab d={d} />}
            </div>
          </section>
        </div>
      </div>

      {action && <ApprovalModal dispute={d} action={action} onClose={() => setAction(null)} onDone={onDone} />}
      {toast && (
        <Toast tone={toast.tone} title={toast.title} onClose={() => setToast(null)}>
          {toast.body}
        </Toast>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function EvidenceTab({ d, onUploaded }: { d: Detail; onUploaded: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState('Proof of delivery');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  async function upload() {
    const f = fileRef.current?.files?.[0];
    if (!f) {
      setMsg({ tone: 'danger', text: 'Choose a file to upload.' });
      return;
    }
    if (f.size > FILE_LIMITS.maxBytesPerFile) {
      setMsg({ tone: 'danger', text: 'The file is larger than 10 MB.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const item = await api.upload(d.id, f, label);
      setMsg({ tone: 'ok', text: `Added as ${item.id}. Re-scoring the evidence…` });
      if (fileRef.current) fileRef.current.value = '';
      onUploaded();
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof ApiError ? `${e.message}${e.detail ? `: ${e.detail}` : ''}` : 'Upload failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {d.evidence.length === 0 ? (
        <EmptyState icon="layers" title="No evidence collected yet">
          Items appear here as the collection workflow runs.
        </EmptyState>
      ) : (
        <div>
          {d.evidence.map((e) => (
            <EvidenceItem key={e.id} disputeId={d.id} e={e} />
          ))}
        </div>
      )}

      <div className="dropzone">
        <div className="row" style={{ marginBottom: 12 }}>
          <Icon name="upload" size={16} />
          <div className="grow">
            <div className="strong">Add supporting document</div>
            <div className="muted xs">PDF, JPEG, PNG, GIF or TIFF · up to 10 MB</div>
          </div>
        </div>
        <div className="row top wrap">
          <label className="field" style={{ width: 220 }}>
            Label
            <input type="text" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="field grow">
            File
            <input ref={fileRef} type="file" accept={FILE_LIMITS.allowedExtensions.join(',')} style={{ fontSize: 13, paddingTop: 6 }} />
          </label>
          <button className="btn" style={{ alignSelf: 'flex-end' }} onClick={() => void upload()} disabled={busy}>
            {busy ? <span className="spinner" /> : <Icon name="upload" size={15} />}
            Upload
          </button>
        </div>
        {msg && (
          <div style={{ marginTop: 12 }}>
            <Notice tone={msg.tone}>{msg.text}</Notice>
          </div>
        )}
        <div className="muted xs" style={{ marginTop: 10 }}>
          Files are verified by content, stored under a random name, and attached to a PayPal submission only after you approve it.
        </div>
      </div>
    </div>
  );
}

function EvidenceItem({ disputeId, e }: { disputeId: string; e: EvidenceItemView }) {
  const src = SOURCE[e.source] ?? { label: humanize(e.source), tone: 'neutral' };
  const kind = KIND[e.kind] ?? { label: humanize(e.kind), icon: 'fileText' as IconName };
  return (
    <article className="ev">
      <header className="ev-head">
        <span className="ev-icon">
          <Icon name={kind.icon} size={15} />
        </span>
        <span className="ev-id">{e.id}</span>
        <div className="grow" style={{ minWidth: 160 }}>
          <div className="ev-title truncate">{e.label}</div>
          <div className="muted xs">{kind.label}</div>
        </div>
        <span className={`badge tone-${src.tone}`}>{src.label}</span>
      </header>
      {e.contentText ? <pre>{e.contentText}</pre> : null}
      {e.filePath && (
        <div className="ev-file">
          <a className="btn btn-sm" href={`/api/disputes/${encodeURIComponent(disputeId)}/evidence/${e.id}/file`} target="_blank" rel="noreferrer">
            <Icon name="externalLink" size={13} />
            Open {e.mimeType === 'application/pdf' ? 'PDF' : 'image'} ({((e.bytes ?? 0) / 1024).toFixed(1)} KB)
          </a>
        </div>
      )}
      <footer className="ev-foot">
        {e.sourceRef && (
          <span title={e.sourceRef}>
            <Icon name="externalLink" size={12} />
            <span className="truncate" style={{ maxWidth: 360 }}>
              {e.sourceRef}
            </span>
          </span>
        )}
        <span>
          <Icon name="clock" size={12} />
          {when(e.capturedAt)}
        </span>
        <span title={`SHA-256 ${e.sha256}`}>
          <Icon name="hash" size={12} />
          <code>{e.sha256.slice(0, 16)}</code>
        </span>
      </footer>
    </article>
  );
}

function DraftTab({ d }: { d: Detail }) {
  const plan = d.plan;
  if (!plan && !d.draft) {
    return (
      <EmptyState icon="fileText" title={d.supported ? 'No strategy yet' : 'Manual handling'}>
        {d.supported
          ? 'The strategy and draft appear once evidence collection finishes.'
          : 'This dispute reason is handled manually in this version.'}
      </EmptyState>
    );
  }
  return (
    <div className="stack" style={{ gap: 24 }}>
      {d.draft ? (
        <section>
          <div className="row" style={{ marginBottom: 10 }}>
            <h3 className="grow" style={{ fontSize: 14 }}>
              Response draft
            </h3>
            <SourceTag generator={d.draft.generator} model={d.draft.model} />
          </div>
          <div className="draft-text">
            <Cited text={d.draft.editedText ?? d.draft.text} />
          </div>
          <div className="row wrap small" style={{ marginTop: 10 }}>
            <span className="muted">Cites</span>
            {d.draft.evidenceRefs.map((r) => (
              <span key={r} className="cite">
                {r}
              </span>
            ))}
            {d.draft.editedText && <span className="badge tone-neutral">Edited</span>}
            <span className="grow" />
            <span className="muted xs">Every citation is verified against stored evidence. Edit the text when you approve.</span>
          </div>
        </section>
      ) : (
        <Notice tone="warn" title="No draft written">
          See the evidence collection panel for the reason.
        </Notice>
      )}

      {plan && (
        <>
          <section>
            <div className="row" style={{ marginBottom: 10 }}>
              <h3 className="grow" style={{ fontSize: 14 }}>
                Supporting points
              </h3>
              <SourceTag generator={plan.generator} model={plan.model} />
            </div>
            <ul className="claims">
              {plan.narrative.rationale.map((r, i) => (
                <li key={i}>
                  <Icon name="checkCircle" size={15} style={{ color: 'var(--success)' }} />
                  <span>
                    {r.claim}{' '}
                    {r.evidence_ids.map((id) => (
                      <span key={id} className="cite">
                        {id}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {plan.narrative.risks.length > 0 && (
            <section>
              <h3 style={{ fontSize: 14, marginBottom: 10 }}>Risks a reviewer may raise</h3>
              <ul className="claims">
                {plan.narrative.risks.map((r, i) => (
                  <li key={i}>
                    <Icon name="alertTriangle" size={15} style={{ color: 'var(--warning)' }} />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>Extracted facts</h3>
            <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
              <table className="table">
                <tbody>
                  {(
                    [
                      ['Carrier', plan.facts.carrier ?? (plan.facts.carrierEnum ? carrierDisplayName(plan.facts.carrierEnum) : null), 'carrier'],
                      ['Tracking number', plan.facts.trackingNumber, 'tracking_number'],
                      ['Delivery status', plan.facts.deliveryStatus === 'UNKNOWN' ? null : humanize(plan.facts.deliveryStatus), 'delivery_status'],
                      ['Delivered at', plan.facts.deliveredAt, 'delivered_at'],
                      ['Signature', plan.facts.signatureObtained === null ? null : plan.facts.signatureObtained ? 'Yes' : 'No', 'signature_obtained'],
                      ['Address match', plan.facts.addressMatch === 'UNKNOWN' ? null : humanize(plan.facts.addressMatch), 'address_match'],
                    ] as [string, string | null, string][]
                  ).map(([k, v, f]) => (
                    <tr key={k}>
                      <td className="key">{k}</td>
                      <td>{v ?? <span className="subtle">Not established</span>}</td>
                      <td style={{ width: 80, textAlign: 'right' }}>{plan.facts.sources[f] && <span className="cite">{plan.facts.sources[f]}</span>}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="key">Extraction confidence</td>
                    <td className="num">{plan.facts.confidence.toFixed(2)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h3 style={{ fontSize: 14, marginBottom: 4 }}>Policy references</h3>
            <p className="muted xs" style={{ marginBottom: 10 }}>
              Summaries of PayPal developer documentation used to ground the strategy. Not PayPal policy text.
            </p>
            {plan.citations.length === 0 ? (
              <div className="muted small">No references retrieved.</div>
            ) : (
              plan.citations.map((c) => (
                <div className="citation" key={c.id}>
                  <div className="row small">
                    <span className="cite">{c.id}</span>
                    <strong className="grow">{c.title}</strong>
                  </div>
                  <div className="small muted" style={{ marginTop: 5 }}>
                    {c.snippet}
                  </div>
                  <a className="xs" style={{ marginTop: 6, gap: 5, display: 'inline-flex', alignItems: 'center' }} href={c.url} target="_blank" rel="noreferrer">
                    <Icon name="externalLink" size={12} />
                    {c.url.replace(/^https?:\/\//, '')}
                  </a>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </div>
  );
}

const TL: Record<TimelineEntry['kind'], { icon: IconName; tone: string }> = {
  dispute: { icon: 'activity', tone: 'info' },
  workflow: { icon: 'layers', tone: 'neutral' },
  ai: { icon: 'sparkles', tone: 'violet' },
  approval: { icon: 'shieldCheck', tone: 'success' },
  submission: { icon: 'fileCheck', tone: 'info' },
  webhook: { icon: 'message', tone: 'info' },
  note: { icon: 'paperclip', tone: 'neutral' },
};

function TimelineTab({ d }: { d: Detail }) {
  if (d.timeline.length === 0) {
    return <EmptyState icon="clock" title="No activity yet" />;
  }
  return (
    <ol className="timeline">
      {d.timeline.map((t) => {
        const k = TL[t.kind] ?? TL.note;
        return (
          <li className="tl-item" key={t.id}>
            <span className={`tl-dot tone-${k.tone}`}>
              <Icon name={k.icon} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="tl-title">{t.title}</div>
              {t.detail && <div className="tl-detail">{t.detail}</div>}
            </div>
            <span className="tl-time">{when(t.at)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function RawTab({ d }: { d: Detail }) {
  return (
    <div className="stack" style={{ gap: 22 }}>
      <section>
        <h3 style={{ fontSize: 14, marginBottom: 4 }}>Actions offered by PayPal</h3>
        <p className="muted xs" style={{ marginBottom: 10 }}>
          HATEOAS links from the dispute record. DisputeDesk only offers actions listed here.
        </p>
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Relation</th>
                <th>Method</th>
                <th>Endpoint</th>
              </tr>
            </thead>
            <tbody>
              {d.links.map((l) => (
                <tr key={l.rel}>
                  <td>
                    <span className="code-pill">{l.rel}</span>
                  </td>
                  <td className="mono xs">{l.method ?? ''}</td>
                  <td className="mono xs" style={{ wordBreak: 'break-all' }}>
                    {l.href}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Dispute record</h3>
        <div className="code-block">
          <div className="code-header">
            <span>GET /v1/customer/disputes/{d.id}</span>
            <span>JSON</span>
          </div>
          <pre>{JSON.stringify(d.raw, null, 2)}</pre>
        </div>
      </section>

      {d.submissions.length > 0 && (
        <section>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Approval history</h3>
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Approved</th>
                  <th>Action</th>
                  <th>Result</th>
                  <th>Payload fingerprint</th>
                  <th>debug_id</th>
                </tr>
              </thead>
              <tbody>
                {d.submissions.map((s) => (
                  <tr key={s.id}>
                    <td className="nowrap">{when(s.approvedAt)}</td>
                    <td>{DISPUTE_ACTION_LABELS[s.action]?.label ?? s.action}</td>
                    <td>
                      <span className={`badge tone-${s.resultStatus === 'SENT' ? 'success' : s.resultStatus === 'FAILED' ? 'danger' : 'neutral'}`}>
                        {humanize(s.resultStatus)}
                      </span>
                      {s.httpStatus ? <span className="muted xs"> · HTTP {s.httpStatus}</span> : null}
                    </td>
                    <td className="mono xs">{s.payloadSha256.slice(0, 16)}…</td>
                    <td className="mono xs">{s.debugId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
