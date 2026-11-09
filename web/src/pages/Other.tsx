/** Audit log (FR-12) and Settings / system status (PRD §11 screen 4). */

import { useEffect, useState } from 'react';
import { api, when } from '../api';
import { EmptyState, Loading, Notice, humanize, operatorIdentity } from '../components';
import { Icon, type IconName } from '../icons';

// ---------------------------------------------------------------------------
// Audit log

type AuditEntry = Awaited<ReturnType<typeof api.audit>>['entries'][number];

function eventTone(event: string): string {
  if (/failed|rejected|mismatch/.test(event)) return 'danger';
  if (event === 'paypal.write' || event.startsWith('approval.')) return 'success';
  if (event.startsWith('ai.')) return 'violet';
  if (event.startsWith('paypal.') || event.startsWith('webhook.')) return 'info';
  return 'neutral';
}

export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void api.audit().then((r) => setEntries(r.entries));
  }, []);

  const shown = (entries ?? []).filter(
    (e) => !filter || `${e.event} ${e.disputeId ?? ''} ${e.actor}`.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Audit log</h1>
          <p className="page-subtitle">Every PayPal request, AI call, approval and submission. Credentials are redacted before storage.</p>
        </div>
        <div className="page-actions">
          <a className="btn" href="/api/audit?download=1" download>
            <Icon name="download" size={15} />
            Export JSON
          </a>
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="toolbar">
          <label className="sr-only" htmlFor="af">
            Filter audit entries
          </label>
          <div className="search">
            <Icon name="search" size={15} />
            <input id="af" type="search" placeholder="Filter by event, dispute or actor" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div className="grow" />
          <span className="muted small num">
            {shown.length} {shown.length === 1 ? 'entry' : 'entries'}
          </span>
        </div>
        {entries === null ? (
          <div style={{ padding: '0 20px' }}>
            <Loading label="Loading audit log…" />
          </div>
        ) : shown.length === 0 ? (
          <EmptyState icon="list" title="No matching entries" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 190 }}>Time</th>
                <th style={{ width: 250 }}>Event</th>
                <th style={{ width: 170 }}>Dispute</th>
                <th style={{ width: 150 }}>Actor</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 400).map((e) => (
                <tr key={e.id}>
                  <td className="small nowrap num">{when(e.ts)}</td>
                  <td>
                    <span className={`badge tone-${eventTone(e.event)}`} style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>
                      {e.event}
                    </span>
                  </td>
                  <td className="mono xs">{e.disputeId ?? <span className="subtle">—</span>}</td>
                  <td className="small">{operatorIdentity(e.actor).name}</td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                      <Icon
                        name="chevronRight"
                        size={13}
                        style={{ transform: open === e.id ? 'rotate(90deg)' : undefined, transition: 'transform .12s' }}
                      />
                      {open === e.id ? 'Hide' : 'View'}
                    </button>
                    {open === e.id && (
                      <div className="code-block" style={{ marginTop: 8 }}>
                        <pre style={{ maxHeight: 260 }}>{JSON.stringify(e.detail, null, 2)}</pre>
                      </div>
                    )}
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

// ---------------------------------------------------------------------------
// Settings

type Health = Awaited<ReturnType<typeof api.health>>;
type Analytics = Awaited<ReturnType<typeof api.analytics>>;

function integrationStatus(status: string, detail: string): { label: string; tone: string } {
  if (status === 'ok') return { label: 'Active', tone: 'success' };
  if (status === 'degraded') return { label: 'Degraded', tone: 'warning' };
  if (status === 'error') return { label: 'Error', tone: 'danger' };
  if (/^Planned/i.test(detail)) return { label: 'Planned', tone: 'outline' };
  return { label: 'Not configured', tone: 'neutral' };
}

function UsageCard({ icon, label, value, caption }: { icon: IconName; label: string; value: string; caption: string }) {
  return (
    <div className="card kpi">
      <span className="kpi-icon tone-neutral">
        <Icon name={icon} size={18} />
      </span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="kpi-label">{label}</div>
        <div className="kpi-value truncate" style={{ fontSize: 20 }}>
          {value}
        </div>
        <div className="kpi-caption">{caption}</div>
      </div>
    </div>
  );
}

function BreakdownTable({ title, rows }: { title: string; rows: [string, number][] }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="section-label">{title}</div>
      {rows.length === 0 ? (
        <div className="muted small">No data yet</div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          <table className="table">
            <tbody>
              {rows.map(([k, n]) => (
                <tr key={k}>
                  <td>{humanize(k)}</td>
                  <td className="num strong" style={{ textAlign: 'right' }}>
                    {n}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function SettingsPage() {
  const [h, setH] = useState<Health | null>(null);
  const [a, setA] = useState<Analytics | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    void api.health().then(setH);
    void api.analytics().then(setA);
  }, []);

  if (!h) return <Loading label="Loading settings…" />;
  const demo = h.mode === 'demo';
  const paypal = h.dependencies.find((d) => d.name.startsWith('PayPal'));

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Workspace configuration and integration status. Credentials are set on the server and never displayed.</p>
        </div>
      </div>

      <div className="stack" style={{ gap: 20 }}>
        <section className="card" aria-labelledby="env-h">
          <div className="card-header">
            <div>
              <h2 id="env-h" className="card-title">
                Environment
              </h2>
              <div className="card-subtitle">Where disputes come from and where approved actions go</div>
            </div>
            <span className={`env-badge ${demo ? 'demo' : 'sandbox'}`}>
              <span className="dot" aria-hidden="true" />
              {demo ? 'Demo environment' : 'PayPal Sandbox'}
            </span>
          </div>
          <div className="card-body stack" style={{ gap: 14 }}>
            {demo ? (
              <Notice tone="info" title="Running on sample data">
                Disputes are drawn from a built-in sample dataset. Approved actions are recorded locally and are not transmitted to PayPal;
                no funds move. Connect a PayPal sandbox app (<code>PAYPAL_CLIENT_ID</code>, <code>PAYPAL_CLIENT_SECRET</code>) to work with
                live sandbox disputes.
              </Notice>
            ) : (
              <Notice tone="info" title="Connected to the PayPal sandbox">
                Approved actions are sent to PayPal&apos;s sandbox API against test accounts. No real funds move.
              </Notice>
            )}
            <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
              <table className="table">
                <tbody>
                  <tr>
                    <td className="key">PayPal connection</td>
                    <td>{paypal?.detail ?? '—'}</td>
                  </tr>
                  <tr>
                    <td className="key">Last sync</td>
                    <td>
                      {h.lastPoll ? (
                        <>
                          {when(h.lastPoll.at)}
                          <span className="muted"> · {h.lastPoll.error ? `failed: ${h.lastPoll.error}` : `${h.lastPoll.found} disputes`}</span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                  <tr>
                    <td className="key">Version</td>
                    <td className="mono xs">{h.version}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {demo && (
              <div className="row">
                <button
                  className="btn btn-sm"
                  disabled={resetting}
                  onClick={async () => {
                    setResetting(true);
                    await api.resetDemo();
                    window.location.href = '/';
                  }}
                >
                  {resetting ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Icon name="refresh" size={13} />}
                  Reset sample data
                </button>
                <span className="muted xs">Restores every sample dispute to its starting state.</span>
              </div>
            )}
          </div>
        </section>

        <section className="card" aria-labelledby="int-h" style={{ overflow: 'hidden' }}>
          <div className="card-header">
            <div>
              <h2 id="int-h" className="card-title">
                Integrations
              </h2>
              <div className="card-subtitle">Each integration has a documented fallback, so the workflow completes without it</div>
            </div>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 220 }}>Integration</th>
                <th style={{ width: 140 }}>Status</th>
                <th>Details</th>
                <th style={{ width: 260 }}>Fallback</th>
              </tr>
            </thead>
            <tbody>
              {h.dependencies.map((d) => {
                const s = integrationStatus(d.status, d.detail);
                return (
                  <tr key={d.name}>
                    <td className="strong">{d.name}</td>
                    <td>
                      <span className={`badge pill tone-${s.tone}`}>{s.label}</span>
                    </td>
                    <td className="small muted">{d.detail}</td>
                    <td className="small muted">{d.fallback ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <div className="kpi-grid" style={{ marginBottom: 0 }}>
          <UsageCard
            icon="sparkles"
            label="AI model"
            value={h.llm.enabled ? h.llm.model : 'Standard template'}
            caption={h.llm.enabled ? 'Structured outputs' : 'Set ANTHROPIC_API_KEY to enable'}
          />
          <UsageCard icon="wallet" label="AI spend today" value={`$${h.llm.spentUsd.toFixed(2)}`} caption={`Hard cap $${h.llm.capUsd.toFixed(2)} per day`} />
          <UsageCard icon="activity" label="AI calls" value={String(a?.ai.calls ?? '—')} caption={`$${(a?.ai.costUsd ?? 0).toFixed(4)} total`} />
          <UsageCard icon="refresh" label="PayPal sync" value={h.lastPoll ? 'Scheduled' : 'Pending'} caption="Webhooks plus periodic reconciliation" />
        </div>

        {a && (
          <section className="card" aria-labelledby="an-h">
            <div className="card-header">
              <div>
                <h2 id="an-h" className="card-title">
                  Workspace analytics
                </h2>
                <div className="card-subtitle">From the local database</div>
              </div>
            </div>
            <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20 }}>
              <BreakdownTable title="By PayPal status" rows={a.byStatus.map((x) => [x.status, x.n])} />
              <BreakdownTable title="By evidence strength" rows={a.byBand.map((x) => [x.band, x.n])} />
              <BreakdownTable title="Submissions" rows={a.submissions.map((x) => [x.result, x.n])} />
            </div>
          </section>
        )}
      </div>
    </>
  );
}
