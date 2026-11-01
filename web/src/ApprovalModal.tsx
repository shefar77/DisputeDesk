/**
 * Approval modal (FR-9, PRD §11 screen 3).
 *
 * Left: exactly what will be sent — method, URL, content type, body, files and the
 * SHA-256 the approval binds to. Right: the editable text. Editing invalidates the
 * preview, so Approve is disabled until the merchant re-previews: the hash they
 * approve is always the hash of what they are looking at.
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
import { Alert } from './components';

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
      setError(e instanceof ApiError ? `${e.message}${e.detail ? ` — ${e.detail}` : ''}` : 'Preview failed');
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
      setError(e instanceof Error ? e.message : 'Could not save');
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
        setError('What would be sent changed since this preview. A fresh preview has been loaded — review it again.');
        await loadPreview();
      } else {
        setError(e instanceof ApiError ? `${e.message}${e.debugId ? ` (debug_id ${e.debugId})` : ''}` : 'Approval failed');
      }
    } finally {
      setBusy(false);
    }
  }

  const canApprove = prev && !dirty && !busy && (!prev.highConsequence || confirmed);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="appr-title" tabIndex={-1} ref={dialogRef}>
        <div className="modal-h">
          <div className="grow">
            <h2 id="appr-title">Review &amp; approve: {meta.label}</h2>
            <div className="muted small">{meta.consequence}</div>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal-b">
          {/* ---------------- what will be sent ---------------- */}
          <section aria-labelledby="sent-h">
            <h3 id="sent-h" style={{ marginBottom: 10 }}>What will be sent to PayPal</h3>
            {action === 'make-offer' && (
              <div className="card card-b stack" style={{ marginBottom: 14, gap: 10 }}>
                <div className="row">
                  <label className="field grow">
                    Offer type
                    <select value={offer.offer_type} onChange={(e) => setOffer({ ...offer, offer_type: e.target.value as OfferType })}>
                      {OFFER_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ').toLowerCase()}</option>)}
                    </select>
                  </label>
                  <label className="field" style={{ width: 150 }}>
                    Amount ({dispute.amountCurrency})
                    <input type="text" inputMode="decimal" value={offer.amount} onChange={(e) => setOffer({ ...offer, amount: e.target.value })} />
                  </label>
                </div>
                <div className="muted tiny">Disputed amount: {money(dispute.amountValue, dispute.amountCurrency)}. Offers above it are refused by the server.</div>
                <label className="field">
                  Note to buyer
                  <textarea rows={2} value={offer.note} maxLength={2000} onChange={(e) => setOffer({ ...offer, note: e.target.value })} />
                </label>
                <div><button className="btn" onClick={() => void loadPreview()} disabled={busy}>Preview offer</button></div>
              </div>
            )}

            {busy && !prev && <div className="row muted"><span className="spinner" /> Building the exact request…</div>}
            {prev && (
              <>
                <dl className="kv">
                  <dt>Method</dt><dd className="mono">{prev.request.method}</dd>
                  <dt>Endpoint</dt><dd className="mono">{prev.request.url}</dd>
                  <dt>Content type</dt><dd className="mono">{prev.request.contentType}</dd>
                  {prev.evidenceTypes.length > 0 && (<><dt>Evidence types</dt><dd>{prev.evidenceTypes.map((t) => <span key={t} className="badge outline" style={{ marginRight: 4, marginBottom: 4 }}>{t}</span>)}</dd></>)}
                  <dt>Files</dt>
                  <dd>
                    {prev.files.length === 0 ? <span className="muted">None</span> : prev.files.map((f) => (
                      <div key={f.sha256} className="mono tiny">{f.filename} · {f.mimeType} · {(f.bytes / 1024).toFixed(1)} KB · sha256 {f.sha256.slice(0, 10)}…</div>
                    ))}
                  </dd>
                </dl>
                <pre className="code" aria-label="Request body">{prev.pretty}</pre>
                <div style={{ marginTop: 12 }}>
                  <div className="small muted" style={{ fontWeight: 600, marginBottom: 4 }}>Approval binds to SHA-256 of this exact request</div>
                  <div className="hash" data-testid="payload-hash">{prev.payloadSha256}</div>
                </div>
              </>
            )}
          </section>

          {/* ---------------- editable text + warnings ---------------- */}
          <section className="stack" aria-labelledby="edit-h">
            {usesDraft && (
              <div>
                <div className="row" style={{ marginBottom: 8 }}>
                  <h3 id="edit-h" className="grow">{action === 'send-message' ? 'Message' : action === 'accept-claim' ? 'Note' : 'Response notes'}</h3>
                  <span className={`tiny ${text.length > DRAFT_MAX_LENGTH ? '' : 'muted'}`} style={{ color: text.length > DRAFT_MAX_LENGTH ? 'var(--red)' : undefined }}>
                    {text.length} / {DRAFT_MAX_LENGTH}
                  </span>
                </div>
                <textarea rows={11} value={text} onChange={(e) => setText(e.target.value)} aria-describedby="edit-help" />
                <div id="edit-help" className="row" style={{ marginTop: 8 }}>
                  <span className="muted tiny grow">Edits must be saved and re-previewed before approval, so the hash matches what you see.</span>
                  <button className="btn sm" disabled={!dirty || busy || text.length === 0 || text.length > DRAFT_MAX_LENGTH} onClick={() => void saveAndPreview()}>
                    Save &amp; re-preview
                  </button>
                </div>
              </div>
            )}

            {dirty && <Alert tone="info">You have unsaved edits. Save &amp; re-preview to approve the edited text.</Alert>}
            {prev?.warnings.map((w) => <Alert key={w} tone={w.startsWith('Demo mode') ? 'info' : 'warn'}>{w}</Alert>)}
            {error && <Alert tone="danger">{error}</Alert>}

            {prev?.highConsequence && (
              <label className="confirm">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>I understand this {action === 'accept-claim' ? 'concedes the dispute and refunds the buyer' : 'offers the buyer money'}.</span>
              </label>
            )}
          </section>
        </div>

        <div className="modal-f">
          <span className="muted small grow">
            Nothing is sent until you approve. The model never calls PayPal — only this button does.
          </span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className={`btn ${prev?.highConsequence ? 'danger' : 'primary'}`} disabled={!canApprove} onClick={() => void approve()}>
            {busy && prev ? <span className="spinner" /> : null}
            Approve &amp; {action === 'provide-evidence' ? 'submit' : 'send'}
          </button>
        </div>
      </div>
    </div>
  );
}
