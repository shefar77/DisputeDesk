/** Audit log (FR-12) and Settings / system status (PRD §11 screen 4). */

import { useEffect, useState } from 'react';
import { api, when } from '../api';
import { Alert } from '../components';

type AuditEntry = Awaited<ReturnType<typeof api.audit>>['entries'][number];

export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void api.audit().then((r) => setEntries(r.entries));
  }, []);

  const shown = (entries ?? []).filter((e) => !filter || `${e.event} ${e.disputeId ?? ''} ${e.actor}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p>Every PayPal read and write, every AI call, every approval. Secrets are redacted before they are stored.</p>
        </div>
        <a className="btn" href="/api/audit?download=1" download>Export JSON</a>
      </div>
      <div className="card">
        <div className="toolbar">
          <label className="sr-only" htmlFor="af">Filter</label>
          <input id="af" type="search" placeholder="Filter by event, dispute or actor…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 320 }} />
          <span className="muted small">{shown.length} entries</span>
        </div>
        {entries === null ? (
          <div className="empty"><span className="spinner" /></div>
        ) : (
          <table className="plain">
            <thead><tr><th style={{ width: 190 }}>Time</th><th style={{ width: 230 }}>Event</th><th style={{ width: 160 }}>Dispute</th><th style={{ width: 130 }}>Actor</th><th>Detail</th></tr></thead>
            <tbody>
              {shown.slice(0, 400).map((e) => (
                <tr key={e.id}>
                  <td className="small">{when(e.ts)}</td>
                  <td className="mono small">{e.event}</td>
                  <td className="mono tiny">{e.disputeId ?? '—'}</td>
                  <td className="small">{e.actor}</td>
                  <td>
                    <button className="btn ghost sm" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                      {open === e.id ? 'Hide' : 'Show'}
                    </button>
                    {open === e.id && <pre className="code" style={{ marginTop: 6, maxHeight: 240 }}>{JSON.stringify(e.detail, null, 2)}</pre>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

type Health = Awaited<ReturnType<typeof api.health>>;
type Analytics = Awaited<ReturnType<typeof api.analytics>>;

const TONE: Record<string, string> = { ok: 'green', degraded: 'amber', disabled: 'grey', error: 'red' };

export function SettingsPage() {
  const [h, setH] = useState<Health | null>(null);
  const [a, setA] = useState<Analytics | null>(null);
  useEffect(() => {
    void api.health().then(setH);
    void api.analytics().then(setA);
  }, []);
  if (!h) return <div className="row muted"><span className="spinner" /> Loading…</div>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings &amp; system status</h1>
          <p>Connections are configured with environment variables on the server. Secrets are never shown here.</p>
        </div>
      </div>
      <div className="stack">
        {h.mode === 'demo' ? (
          <Alert tone="info">
            <strong>Demo mode.</strong> {h.demoReason}. Disputes are fixtures and approvals are recorded locally — nothing is sent to PayPal. Set <code>PAYPAL_CLIENT_ID</code> and <code>PAYPAL_CLIENT_SECRET</code> (sandbox) to connect.
            <div style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={async () => { await api.resetDemo(); window.location.href = '/'; }}>Reset demo data</button>
              <span className="muted small" style={{ marginLeft: 8 }}>Restores every fixture dispute to its starting state.</span>
            </div>
          </Alert>
        ) : (
          <Alert tone="warn"><strong>Connected to the PayPal sandbox.</strong> Approvals send real API requests against test accounts. No real money moves.</Alert>
        )}

        <div className="card">
          <div className="card-h"><h2>Integrations</h2><span className="muted small">v{h.version}</span></div>
          <table className="plain">
            <thead><tr><th style={{ width: 220 }}>Integration</th><th style={{ width: 110 }}>Status</th><th>Detail</th><th>Fallback</th></tr></thead>
            <tbody>
              {h.dependencies.map((d) => (
                <tr key={d.name}>
                  <td style={{ fontWeight: 600 }}>{d.name}</td>
                  <td><span className={`badge ${TONE[d.status] ?? 'grey'}`}>{d.status}</span></td>
                  <td className="small">{d.detail}</td>
                  <td className="small muted">{d.fallback ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="kpis" style={{ marginBottom: 0 }}>
          <div className="card kpi"><div className="label">LLM</div><div className="value" style={{ fontSize: 18 }}>{h.llm.enabled ? h.llm.model : 'Rule-based'}</div><div className="sub">{h.llm.enabled ? 'Anthropic structured outputs' : 'set ANTHROPIC_API_KEY to enable'}</div></div>
          <div className="card kpi"><div className="label">LLM spend today</div><div className="value">${h.llm.spentUsd.toFixed(2)}</div><div className="sub">hard cap ${h.llm.capUsd.toFixed(2)}/day</div></div>
          <div className="card kpi"><div className="label">AI calls (all time)</div><div className="value">{a?.ai.calls ?? '—'}</div><div className="sub">${(a?.ai.costUsd ?? 0).toFixed(4)} total</div></div>
          <div className="card kpi"><div className="label">Last PayPal check</div><div className="value" style={{ fontSize: 18 }}>{h.lastPoll ? when(h.lastPoll.at) : '—'}</div><div className="sub">{h.lastPoll?.error ? `error: ${h.lastPoll.error}` : h.lastPoll ? `${h.lastPoll.found} disputes` : ''}</div></div>
        </div>

        {a && (
          <div className="card">
            <div className="card-h"><h2>Desk analytics</h2><span className="muted small">from the local database</span></div>
            <div className="card-b row" style={{ alignItems: 'flex-start', gap: 32 }}>
              {([['By PayPal status', a.byStatus.map((x) => [x.status, x.n])], ['By evidence band', a.byBand.map((x) => [x.band, x.n])], ['Submissions', a.submissions.map((x) => [x.result, x.n])]] as [string, [string, number][]][]).map(([title, rows]) => (
                <div key={title} style={{ minWidth: 220 }}>
                  <h3 style={{ marginBottom: 6 }}>{title}</h3>
                  {rows.length === 0 ? <div className="muted small">None yet</div> : (
                    <table className="plain"><tbody>{rows.map(([k, n]) => <tr key={k}><td>{k}</td><td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{n}</td></tr>)}</tbody></table>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
