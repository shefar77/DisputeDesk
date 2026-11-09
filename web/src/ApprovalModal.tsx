/**
 * Approval modal (FR-9, PRD §11 screen 3).
 *
 * Left: exactly what will be sent — method, URL, content type, body, files and the
 * SHA-256 the approval binds to. Right: the editable text. Editing invalidates the
 * preview, so Approve stays disabled until the merchant re-previews: the fingerprint
 * they approve is always the fingerprint of what they are looking at.
 */

import { useEffect, useRef, useState } from 'react';
import {
  DISPUTE_ACTION_LABELS,
  DRAFT_MAX_LENGTH,
  OFFER_TYPES,
  type DisputeAction,
  type OfferType,
  type PreviewResponse,
} from '@shared/index.js';
import { api, ApiError, money, type ApproveResult, type Detail } from './api';
import { Notice, humanize } from './components';
import { Icon } from './icons';

interface Props {
  dispute: Detail;
  action: DisputeAction;
  onClose: () => void;
  onDone: (r: ApproveResult) => void;
}

export function ApprovalModal({ dispute, action, onClose, onDone }: Props) {
  const usesDraft = action === 'provide-evidence' || action === 'send-message' || action === 'accept-claim';
  const initialText = dispute.draft ? (dispute.draft.editedText ?? dispute.draft.text) : '';
  const [text, setText] = useState(initialText);
  const [savedText, setSavedText] = useState(initialText);
  const [prev, setPrev] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [offer, setOffer] = useState<{ offer_type: OfferType; amount: string; note: string }>({
    offer_type: 'REFUND',
    amount: (Number(dispute.amountValue) / 2).toFixed(2),
    note: 'We would like to resolve this with a partial refund.',
  });
  const dialogRef = useRef<HTMLDivElement>(null);

  const dirty = usesDraft && text !== savedText;
  const meta = DISPUTE_ACTION_LABELS[action];

  async function loadPreview() {
    setBusy(true);
    setError(null);
    try {
      const p = await api.preview(dispute.id, action === 'make-offer' ? { action, offer } : { action });
      setPrev(p);
      setConfirmed(false);
    } catch (e) {
      setPrev(null);
      setError(e instanceof ApiError ? `${e.message}${e.detail ? `: ${e.detail}` : ''}` : 'The preview could not be built.');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (action !== 'make-offer') void loadPreview();
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveAndPreview() {
    setBusy(true);
    try {
      await api.saveDraft(dispute.id, text);
      setSavedText(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The draft could not be saved.');
      setBusy(false);
      return;
    }
    await loadPreview();
  }

  async function approve() {
    if (!prev) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.approve(dispute.id, {
        action,
        payload_sha256: prev.payloadSha256,
        ...(action === 'make-offer' ? { offer } : {}),
      });
      onDone(r);
    } catch (e) {
      if (e instanceof ApiError && e.type === 'hash-mismatch') {
        setError('The request changed after this preview was generated. A new preview has been loaded; review it before approving.');
        await loadPreview();
      } else {
        setError(e instanceof ApiError ? `${e.message}${e.debugId ? ` (debug_id ${e.debugId})` : ''}` : 'Approval failed.');
      }
    } finally {
      setBusy(false);
    }
  }

  const canApprove = prev && !dirty && !busy && (!prev.highConsequence || confirmed);
  const demoNotice = prev?.warnings.find((w) => /^Demo/.test(w));
  const otherWarnings = prev?.warnings.filter((w) => !/^Demo/.test(w)) ?? [];

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="appr-title" tabIndex={-1} ref={dialogRef}>
        <div className="modal-header">
          <span className="modal-icon">
            <Icon name="shieldCheck" size={19} />
          </span>
          <div className="grow">
            <h2 id="appr-title">Review &amp; approve: {meta.label}</h2>
            <div className="muted small" style={{ marginTop: 2 }}>
              {meta.consequence}
            </div>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* ---------------- what will be sent ---------------- */}
          <section aria-labelledby="sent-h">
            <div className="section-label" id="sent-h">
              What will be sent to PayPal
            </div>

            {action === 'make-offer' && (
              <div className="card card-body stack" style={{ marginBottom: 16, gap: 12, boxShadow: 'none' }}>
                <div className="row top">
                  <label className="field grow">
                    Offer type
                    <select value={offer.offer_type} onChange={(e) => setOffer({ ...offer, offer_type: e.target.value as OfferType })}>
                      {OFFER_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {humanize(t)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field" style={{ width: 160 }}>
                    Amount ({dispute.amountCurrency})
                    <input type="text" inputMode="decimal" value={offer.amount} onChange={(e) => setOffer({ ...offer, amount: e.target.value })} />
                  </label>
                </div>
                <div className="muted xs">
                  Disputed amount: {money(dispute.amountValue, dispute.amountCurrency)}. Offers above this amount are rejected.
                </div>
                <label className="field">
                  Note to buyer
                  <textarea rows={2} value={offer.note} maxLength={2000} onChange={(e) => setOffer({ ...offer, note: e.target.value })} />
                </label>
                <div>
                  <button className="btn" onClick={() => void loadPreview()} disabled={busy}>
                    Preview offer
                  </button>
                </div>
              </div>
            )}

            {busy && !prev && (
              <div className="loading">
                <span className="spinner" /> Building the exact request…
              </div>
            )}

            {prev && (
              <>
                <dl className="request-meta">
                  <dt>Endpoint</dt>
                  <dd className="mono xs">
                    <span className="method">{prev.request.method}</span>
                    {prev.request.url}
                  </dd>
                  <dt>Content type</dt>
                  <dd className="mono xs">{prev.request.contentType}</dd>
                  {prev.evidenceTypes.length > 0 && (
                    <>
                      <dt>Evidence types</dt>
                      <dd>
                        <div className="row wrap" style={{ gap: 6 }}>
                          {prev.evidenceTypes.map((t) => (
                            <span key={t} className="code-pill">
                              {t}
                            </span>
                          ))}
                        </div>
                      </dd>
                    </>
                  )}
                  <dt>Attachments</dt>
                  <dd>
                    {prev.files.length === 0 ? (
                      <span className="muted">None</span>
                    ) : (
                      prev.files.map((f) => (
                        <div key={f.sha256} className="row xs" style={{ gap: 6 }}>
                          <Icon name="paperclip" size={12} />
                          <span className="mono">{f.filename}</span>
                          <span className="muted">
                            · {(f.bytes / 1024).toFixed(1)} KB · {f.sha256.slice(0, 10)}…
                          </span>
                        </div>
                      ))
                    )}
                  </dd>
                </dl>

                <div className="fingerprint" style={{ marginTop: 0, marginBottom: 14 }}>
                  <Icon name="lock" />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="small strong">Approval fingerprint (SHA-256)</div>
                    <div className="muted xs">Your approval is bound to this exact request. Any change produces a new fingerprint.</div>
                    <code data-testid="payload-hash">{prev.payloadSha256}</code>
                  </div>
                </div>

                <div className="code-block">
                  <div className="code-header">
                    <span>Request body</span>
                    <span>JSON</span>
                  </div>
                  <pre aria-label="Request body" style={{ maxHeight: 340 }}>
                    {prev.pretty}
                  </pre>
                </div>
              </>
            )}
          </section>

          {/* ---------------- editable text + notices ---------------- */}
          <section className="stack" aria-labelledby="edit-h" style={{ gap: 12 }}>
            {usesDraft && (
              <div>
                <div className="row" style={{ marginBottom: 8 }}>
                  <div className="section-label grow" id="edit-h" style={{ marginBottom: 0 }}>
                    {action === 'send-message' ? 'Message' : action === 'accept-claim' ? 'Note' : 'Response notes'}
                  </div>
                  <span className="xs num" style={{ color: text.length > DRAFT_MAX_LENGTH ? 'var(--danger)' : 'var(--text-subtle)' }}>
                    {text.length} / {DRAFT_MAX_LENGTH}
                  </span>
                </div>
                <textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} aria-describedby="edit-help" />
                <div id="edit-help" className="row" style={{ marginTop: 8 }}>
                  <span className="muted xs grow">Save your edits to regenerate the request and its fingerprint before approving.</span>
                  <button
                    className="btn btn-sm"
                    disabled={!dirty || busy || text.length === 0 || text.length > DRAFT_MAX_LENGTH}
                    onClick={() => void saveAndPreview()}
                  >
                    <Icon name="refresh" size={13} />
                    Save &amp; re-preview
                  </button>
                </div>
              </div>
            )}

            {dirty && <Notice tone="info">You have unsaved edits. Save &amp; re-preview to approve the edited text.</Notice>}
            {demoNotice && (
              <Notice tone="info" title="Demo environment">
                Approving records this request locally. It is not transmitted to PayPal, and no funds move.
              </Notice>
            )}
            {otherWarnings.map((w) => (
              <Notice key={w} tone="warn">
                {w}
              </Notice>
            ))}
            {error && <Notice tone="danger">{error}</Notice>}

            {prev?.highConsequence && (
              <label className="confirm">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>
                  I understand this {action === 'accept-claim' ? 'concedes the dispute and refunds the buyer' : 'offers the buyer a refund or replacement'}.
                </span>
              </label>
            )}
          </section>
        </div>

        <div className="modal-footer">
          <span className="row muted small grow" style={{ gap: 8 }}>
            <Icon name="lock" size={14} />
            Nothing is sent until you approve. The AI cannot submit on its own.
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className={`btn ${prev?.highConsequence ? 'btn-danger' : 'btn-primary'}`} disabled={!canApprove} onClick={() => void approve()}>
            {busy && prev ? <span className="spinner" /> : <Icon name="shieldCheck" size={15} />}
            Approve &amp; {action === 'provide-evidence' ? 'submit' : 'send'}
          </button>
        </div>
      </div>
    </div>
  );
}
