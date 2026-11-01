/** Dispute detail (PRD §11 screen 2): evidence, plan, draft, timeline, raw API. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  DISPUTE_ACTION_LABELS,
  FILE_LIMITS,
  shouldWarnSubmitNow,
  type DisputeAction,
  type EvidenceItemView,
} from '@shared/index.js';
import { api, ApiError, money, when, type ApproveResult, type Detail } from '../api';
import { ApprovalModal } from '../ApprovalModal';
import {
  AiLabel,
  Alert,
  BandBadge,
  Cited,
  CompletenessRing,
  FixtureBadge,
  GatherBadge,
  StatusBadge,
  Toast,
  UrgencyBadge,
  WorkflowSteps,
} from '../components';

type Tab = 'evidence' | 'draft' | 'timeline' | 'raw';

const SOURCE_BADGE: Record<string, [string, string]> = {
  paypal: ['PayPal', 'blue'],
  kernel: ['KERNEL capture', 'green'],
  zapier: ['Zapier', 'amber'],
  upload: ['Upload', 'grey'],
  fixture: ['Fixture', 'outline'],
};

const KIND_LABEL: Record<string, string> = {
  paypal_dispute: 'Dispute',
  paypal_transaction: 'Transaction',
  paypal_shipment_tracking: 'Shipment tracking',
  carrier_capture: 'Carrier page',
  order_record: 'Order record',
  upload: 'Document',
  buyer_message: 'Buyer message',
};

export function DisputeDetailPage({ mode }: { mode: string }) {
  const { id = '' } = useParams();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('evidence');
  const [action, setAction] = useState<DisputeAction | null>(null);
  const [toast, setToast] = useState<{ tone: 'ok' | 'danger' | 'info'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setD(await api.dispute(id));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'Dispute not found.' : e instanceof Error ? e.message : 'Failed to load');
    }
  }, [id]);

  // Poll fast while the workflow runs so the steps animate live; slowly otherwise.
  const live = d?.running || d?.gatherState === 'GATHERING';
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => void load(), live ? 700 : 5000);
    return () => clearInterval(t);
  }, [load, live]);

  if (error) return <><Link className="back" to="/">← Queue</Link><Alert tone="danger">{error}</Alert></>;
  if (!d) return <div className="row muted"><span className="spinner" /> Loading dispute…</div>;

  const plan = d.plan;
  const recommended = plan?.narrative.recommended_action ?? null;
  const ordered = [...d.allowedActions].sort((a, b) => (a === recommended ? -1 : b === recommended ? 1 : 0));

  async function regather() {
    await api.refresh(id);
    setTab('evidence');
    void load();
  }

  function onDone(r: ApproveResult) {
    setAction(null);
    setToast(
      r.ok
        ? {
            tone: 'ok',
            text: r.simulated
              ? `Recorded locally (demo — nothing sent to PayPal). PayPal status now: ${r.disputeStatus ?? 'unknown'}.`
              : `Submitted to PayPal (HTTP ${r.httpStatus}). Status now: ${r.disputeStatus ?? 'unknown'}.`,
          }
        : { tone: 'danger', text: `PayPal did not accept it: ${r.error ?? 'unknown error'}${r.debugId ? ` (debug_id ${r.debugId})` : ''}` },
    );
    setTab('timeline');
    void load();
  }

  return (
    <>
      <Link className="back" to="/">← Queue</Link>

      {/* --------------------------------------------------------- header */}
      <div className="card detail-head">
        <div>
          <div className="title">
            <h1>{d.reasonLabel}</h1>
            <StatusBadge status={d.status} />
            {d.stage && <span className="badge outline">{d.stage.replace(/_/g, ' ').toLowerCase()} stage</span>}
            <GatherBadge state={d.gatherState} />
            {d.fixture && <FixtureBadge />}
          </div>
          <div className="facts">
            <div className="fact"><div className="k">Disputed</div><div className="v">{money(d.amountValue, d.amountCurrency)}</div></div>
            <div className="fact"><div className="k">Dispute ID</div><div className="v mono" style={{ fontSize: 13.5 }}>{d.id}</div></div>
            <div className="fact"><div className="k">Opened</div><div className="v">{when(d.createdAt)}</div></div>
            <div className="fact"><div className="k">Respond by</div><div className="v">{when(d.sellerResponseDueDate)}</div></div>
          </div>
        </div>
        <div className="due-box">
          <div className="muted small" style={{ fontWeight: 600 }}>Time to respond</div>
          <div className="big" style={{ color: ['CRITICAL', 'OVERDUE'].includes(d.urgency.level) ? 'var(--red)' : undefined }}>{d.dueIn}</div>
          <UrgencyBadge urgency={d.urgency} />
        </div>
      </div>

      <div className="stack" style={{ marginTop: 14, gap: 8 }}>
        {shouldWarnSubmitNow(d.sellerResponseDueDate) && <Alert tone="danger"><strong>Under 2 hours left.</strong> Submit now — a late response cannot be considered.</Alert>}
        {d.guidance.map((g) => <Alert key={g} tone="warn">{g}</Alert>)}
        {d.gatherState === 'NEEDS_MANUAL_REVIEW' && d.supported && (
          <Alert tone="warn">
            Extraction confidence was too low to draft a response safely ({plan?.facts.confidence.toFixed(2) ?? '—'}). Review the evidence, upload proof of shipment or delivery, or use the recommended action.
          </Alert>
        )}
      </div>

      <div className="layout">
        {/* ------------------------------------------------- left column */}
        <div className="stack">
          <div className="card">
            <div className="card-h"><h2>Evidence completeness</h2>{plan && <BandBadge band={plan.band} />}</div>
            <div className="card-b">
              {!plan ? (
                <div className="empty small">{d.supported ? 'Not scored yet.' : 'Not scored — this dispute reason is not supported in this version.'}</div>
              ) : (
                <>
                  <div className="meter">
                    <CompletenessRing score={plan.completeness} band={plan.band} />
                    <div className="small">
                      <div style={{ fontWeight: 600 }}>Scored by a fixed rubric, not by the AI.</div>
                      <div className="muted">Each requirement is weighted; partial evidence earns 40%.{plan.capped && <> Capped at {plan.completeness} (raw {plan.rawCompleteness}) because evidence contradicts delivery.</>}</div>
                    </div>
                  </div>
                  <ul className="reqs">
                    {plan.requirements.map((r) => (
                      <li className="req" key={r.id} title={r.why}>
                        <span className={`mark ${r.satisfied}`} aria-label={r.satisfied}>{r.satisfied === 'yes' ? '✓' : r.satisfied === 'partial' ? '½' : '✕'}</span>
                        <div>
                          <div style={{ fontWeight: 600 }}>{r.label}{r.critical && <span className="muted tiny"> · critical</span>}</div>
                          <div className="detail">{r.detail}</div>
                        </div>
                        <span className="pts">{r.earned}/{r.weight}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h2>Evidence workflow</h2>
              <button className="btn sm" onClick={() => void regather()} disabled={live}>
                {live ? <span className="spinner" /> : '↻'} {live ? 'Running' : 'Re-gather'}
              </button>
            </div>
            <div className="card-b"><WorkflowSteps steps={d.steps} /></div>
          </div>
        </div>

        {/* ------------------------------------------------ right column */}
        <div className="stack">
          <div className="card">
            <div className="card-h">
              <div>
                <h2>Actions PayPal allows right now</h2>
                <div className="muted small">Read from the dispute&apos;s HATEOAS links. Nothing else is offered.</div>
              </div>
            </div>
            <div className="card-b stack" style={{ gap: 12 }}>
              {ordered.length === 0 ? (
                <div className="muted">No actions are available on this dispute at the moment.</div>
              ) : (
                <div className="action-bar">
                  {ordered.map((a) => (
                    <button
                      key={a}
                      className={`btn ${a === recommended ? 'primary' : ''}`}
                      onClick={() => setAction(a)}
                      disabled={live || (a === 'provide-evidence' && !d.draft)}
                      title={DISPUTE_ACTION_LABELS[a].consequence}
                    >
                      {DISPUTE_ACTION_LABELS[a].label}{a === recommended ? ' · recommended' : ''}
                    </button>
                  ))}
                </div>
              )}
              {plan && (
                <div className="small">
                  <span className="muted">Why: </span>{plan.narrative.recommended_action_why}
                </div>
              )}
              {mode === 'demo' && d.status === 'UNDER_REVIEW' && (
                <div className="row" style={{ borderTop: '1px dashed var(--line)', paddingTop: 12 }}>
                  <span className="muted small grow">Demo: stand in for PayPal&apos;s decision to exercise the resolution webhook.</span>
                  <button className="btn sm" onClick={async () => { await api.simulateResolve(id, 'seller'); setTab('timeline'); void load(); }}>Simulate: seller wins</button>
                  <button className="btn sm" onClick={async () => { await api.simulateResolve(id, 'buyer'); setTab('timeline'); void load(); }}>Simulate: buyer wins</button>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="tabs" role="tablist">
              {([
                ['evidence', 'Evidence', d.evidence.length],
                ['draft', 'Plan & draft', null],
                ['timeline', 'Timeline', d.timeline.length],
                ['raw', 'Raw API', null],
              ] as [Tab, string, number | null][]).map(([k, label, n]) => (
                <button key={k} role="tab" className="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                  {label}{n !== null && <span className="n">{n}</span>}
                </button>
              ))}
            </div>
            <div className="card-b" role="tabpanel">
              {tab === 'evidence' && <EvidenceTab d={d} onUploaded={() => void load()} />}
              {tab === 'draft' && <DraftTab d={d} />}
              {tab === 'timeline' && <TimelineTab d={d} />}
              {tab === 'raw' && <RawTab d={d} />}
            </div>
          </div>
        </div>
      </div>

      {action && <ApprovalModal dispute={d} action={action} onClose={() => setAction(null)} onDone={onDone} />}
      {toast && <Toast tone={toast.tone} onClose={() => setToast(null)}>{toast.text}</Toast>}
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
    if (!f) return;
    if (f.size > FILE_LIMITS.maxBytesPerFile) {
      setMsg({ tone: 'danger', text: 'File is larger than 10 MB.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const item = await api.upload(d.id, f, label);
      setMsg({ tone: 'ok', text: `Added ${item.id}. Re-scoring…` });
      if (fileRef.current) fileRef.current.value = '';
      onUploaded();
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof ApiError ? `${e.message}${e.detail ? ` — ${e.detail}` : ''}` : 'Upload failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {d.evidence.length === 0 ? (
        <div className="empty">No evidence collected yet.</div>
      ) : (
        <div>
          {d.evidence.map((e) => <EvidenceItem key={e.id} disputeId={d.id} e={e} />)}
        </div>
      )}
      <div className="card card-b" style={{ background: 'var(--surface-2)' }}>
        <h3 style={{ marginBottom: 8 }}>Add a document</h3>
        <div className="row">
          <label className="field">
            Label
            <input type="text" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="field grow">
            File (PDF, JPEG, PNG, GIF, TIFF · max 10 MB)
            <input ref={fileRef} type="file" accept={FILE_LIMITS.allowedExtensions.join(',')} />
          </label>
          <button className="btn" style={{ alignSelf: 'flex-end' }} onClick={() => void upload()} disabled={busy}>
            {busy ? <span className="spinner" /> : null} Upload
          </button>
        </div>
        {msg && <div style={{ marginTop: 10 }}><Alert tone={msg.tone}>{msg.text}</Alert></div>}
        <div className="muted tiny" style={{ marginTop: 8 }}>Files are checked by content (not just extension), stored under a random name, and attached to the PayPal submission only after you approve it.</div>
      </div>
    </div>
  );
}

function EvidenceItem({ disputeId, e }: { disputeId: string; e: EvidenceItemView }) {
  const [label, tone] = SOURCE_BADGE[e.source] ?? [e.source, 'grey'];
  return (
    <div className="ev">
      <div className="ev-h">
        <span className="ev-id">{e.id}</span>
        <span style={{ fontWeight: 600 }} className="grow">{e.label}</span>
        <span className="badge outline">{KIND_LABEL[e.kind] ?? e.kind}</span>
        <span className={`badge ${tone}`}>{label}</span>
      </div>
      {e.contentText ? <pre>{e.contentText}</pre> : null}
      {e.filePath && (
        <div style={{ padding: '8px 12px' }}>
          <a href={`/api/disputes/${encodeURIComponent(disputeId)}/evidence/${e.id}/file`} target="_blank" rel="noreferrer">
            Open {e.mimeType === 'application/pdf' ? 'PDF' : 'image'} ({((e.bytes ?? 0) / 1024).toFixed(1)} KB)
          </a>
        </div>
      )}
      <div className="ev-meta">
        {e.sourceRef ? <>source: {e.sourceRef} · </> : null}captured {when(e.capturedAt)} · sha256 {e.sha256.slice(0, 16)}…
      </div>
    </div>
  );
}

function DraftTab({ d }: { d: Detail }) {
  const plan = d.plan;
  if (!plan && !d.draft) {
    return <div className="empty">{d.supported ? 'No plan yet — the evidence workflow has not finished.' : 'No plan: this dispute reason is handled manually in this version.'}</div>;
  }
  return (
    <div className="stack">
      {d.draft ? (
        <div>
          <div className="row" style={{ marginBottom: 8 }}>
            <h3 className="grow">Draft response</h3>
            <AiLabel generator={d.draft.generator} model={d.draft.model} />
          </div>
          <div className="card card-b" style={{ whiteSpace: 'pre-wrap' }}>
            <Cited text={d.draft.editedText ?? d.draft.text} />
          </div>
          <div className="row small" style={{ marginTop: 8 }}>
            <span className="muted">Relies on:</span>
            {d.draft.evidenceRefs.map((r) => <span key={r} className="cite">{r}</span>)}
            {d.draft.editedText && <span className="badge grey">edited by you</span>}
          </div>
          <div className="muted tiny" style={{ marginTop: 4 }}>Every cited id is checked against the stored evidence before the draft is accepted. Edit the text in the approval step.</div>
        </div>
      ) : (
        <Alert tone="warn">No draft was written for this dispute — see the workflow panel for why.</Alert>
      )}

      {plan && (
        <>
          <div>
            <div className="row" style={{ marginBottom: 6 }}>
              <h3 className="grow">What the evidence supports</h3>
              <AiLabel generator={plan.generator} model={plan.model} />
            </div>
            <ul className="claims">
              {plan.narrative.rationale.map((r, i) => (
                <li key={i}>{r.claim} {r.evidence_ids.map((id) => <span key={id} className="cite">{id}</span>)}</li>
              ))}
            </ul>
          </div>
          {plan.narrative.risks.length > 0 && (
            <div>
              <h3 style={{ marginBottom: 6 }}>Weaknesses a reviewer will notice</h3>
              <ul className="claims">{plan.narrative.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </div>
          )}
          <div>
            <h3 style={{ marginBottom: 6 }}>Extracted facts</h3>
            <table className="plain">
              <tbody>
                {([
                  ['Carrier', plan.facts.carrierEnum ?? plan.facts.carrier, 'carrier'],
                  ['Tracking number', plan.facts.trackingNumber, 'tracking_number'],
                  ['Delivery status', plan.facts.deliveryStatus, 'delivery_status'],
                  ['Delivered at', plan.facts.deliveredAt, 'delivered_at'],
                  ['Signature', plan.facts.signatureObtained === null ? null : plan.facts.signatureObtained ? 'Yes' : 'No', 'signature_obtained'],
                  ['Address match', plan.facts.addressMatch, 'address_match'],
                ] as [string, string | null, string][]).map(([k, v, f]) => (
                  <tr key={k}>
                    <th style={{ width: 160 }}>{k}</th>
                    <td>{v ?? <span className="muted">unknown</span>}</td>
                    <td style={{ width: 70 }}>{plan.facts.sources[f] && <span className="cite">{plan.facts.sources[f]}</span>}</td>
                  </tr>
                ))}
                <tr><th>Confidence</th><td>{plan.facts.confidence.toFixed(2)}</td><td /></tr>
              </tbody>
            </table>
          </div>
          <div>
            <h3 style={{ marginBottom: 6 }}>Policy notes used for grounding</h3>
            {plan.citations.length === 0 ? (
              <div className="muted small">None retrieved.</div>
            ) : (
              plan.citations.map((c) => (
                <div className="citation" key={c.id}>
                  <div className="row small"><span className="cite">{c.id}</span><strong className="grow">{c.title}</strong></div>
                  <div className="small" style={{ marginTop: 4 }}>{c.snippet}</div>
                  <a className="tiny" href={c.url} target="_blank" rel="noreferrer">{c.url}</a>
                </div>
              ))
            )}
            <div className="muted tiny" style={{ marginTop: 6 }}>Our paraphrased notes on PayPal&apos;s developer documentation — not PayPal policy text.</div>
          </div>
        </>
      )}
    </div>
  );
}

function TimelineTab({ d }: { d: Detail }) {
  if (d.timeline.length === 0) return <div className="empty">Nothing has happened yet.</div>;
  return (
    <ol className="timeline">
      {d.timeline.map((t) => (
        <li key={t.id}>
          <div>
            <div className="tl-kind">{t.kind}</div>
            <div className="tiny muted">{when(t.at)}</div>
          </div>
          <div>
            <div style={{ fontWeight: 600 }}>{t.title}</div>
            {t.detail && <div className="muted small">{t.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function RawTab({ d }: { d: Detail }) {
  return (
    <div className="stack">
      <div>
        <h3 style={{ marginBottom: 6 }}>HATEOAS links</h3>
        <table className="plain">
          <thead><tr><th>rel</th><th>method</th><th>href</th></tr></thead>
          <tbody>
            {d.links.map((l) => (
              <tr key={l.rel}><td className="mono">{l.rel}</td><td className="mono">{l.method ?? ''}</td><td className="mono tiny">{l.href}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h3 style={{ marginBottom: 6 }}>GET /v1/customer/disputes/{d.id}</h3>
        <pre className="code">{JSON.stringify(d.raw, null, 2)}</pre>
      </div>
      {d.submissions.length > 0 && (
        <div>
          <h3 style={{ marginBottom: 6 }}>Approvals</h3>
          <table className="plain">
            <thead><tr><th>When</th><th>Action</th><th>Result</th><th>Payload hash</th><th>debug_id</th></tr></thead>
            <tbody>
              {d.submissions.map((s) => (
                <tr key={s.id}>
                  <td>{when(s.approvedAt)}</td>
                  <td className="mono">{s.action}</td>
                  <td><span className={`badge ${s.resultStatus === 'SENT' ? 'green' : s.resultStatus === 'FAILED' ? 'red' : 'grey'}`}>{s.resultStatus}</span>{s.httpStatus ? ` ${s.httpStatus}` : ''}</td>
                  <td className="mono tiny">{s.payloadSha256.slice(0, 16)}…</td>
                  <td className="mono tiny">{s.debugId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
