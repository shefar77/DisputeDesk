/**
 * The deadline-first queue (FR-3, PRD §11 screen 1).
 *
 * Ordering comes from the server and is deterministic (by seller_response_due_date).
 * AG Grid Community: sorting, quick filter, keyboard navigation. Row grouping is an
 * Enterprise feature, so urgency grouping is done with filter chips instead.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AgGridReact } from 'ag-grid-react';
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type ICellRendererParams,
  type RowClickedEvent,
  type CellKeyDownEvent,
} from 'ag-grid-community';
import { DISPUTE_ACTION_LABELS, type DisputeAction } from '@shared/index.js';
import { api, money, type QueueItem } from '../api';
import { BAND_COLOR, FixtureBadge, GatherBadge, StatusBadge, UrgencyBadge, Alert } from '../components';

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  accentColor: '#1d5bd8',
  borderColor: '#e4e7ec',
  headerBackgroundColor: '#f9fafb',
  headerTextColor: '#5d6b82',
  headerFontWeight: 600,
  fontFamily: 'inherit',
  fontSize: 13.5,
  rowHeight: 48,
  headerHeight: 40,
  wrapperBorderRadius: 0,
  wrapperBorder: false,
  rowHoverColor: '#f5f8ff',
});

type Filter = 'all' | 'urgent' | 'ready' | 'manual' | 'resolved';

const FILTERS: { key: Filter; label: string; test: (r: QueueItem) => boolean }[] = [
  { key: 'all', label: 'All open', test: (r) => r.status !== 'RESOLVED' },
  { key: 'urgent', label: 'Due within 72h', test: (r) => ['OVERDUE', 'CRITICAL', 'URGENT'].includes(r.urgency.level) && r.status !== 'RESOLVED' },
  { key: 'ready', label: 'Ready to review', test: (r) => r.gatherState === 'READY_FOR_REVIEW' },
  { key: 'manual', label: 'Needs attention', test: (r) => r.gatherState === 'NEEDS_MANUAL_REVIEW' || r.gatherState === 'FAILED' },
  { key: 'resolved', label: 'Resolved', test: (r) => r.status === 'RESOLVED' },
];

function ScoreCell({ data }: ICellRendererParams<QueueItem>) {
  if (!data) return null;
  if (data.completeness === null) {
    return <span className="muted small">{data.supported ? '—' : 'Not supported'}</span>;
  }
  const col = BAND_COLOR[data.band ?? ''] ?? 'var(--grey)';
  return (
    <div className="score-cell" title={`${data.completeness}/100 · ${data.band}`}>
      <span className="score-num">{data.completeness}</span>
      <div className="score-bar" aria-hidden="true">
        <span style={{ width: `${data.completeness}%`, background: col }} />
      </div>
      <span className="tiny muted" style={{ width: 62 }}>{data.band?.toLowerCase()}</span>
    </div>
  );
}

export function QueuePage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [quick, setQuick] = useState('');
  const [polling, setPolling] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.disputes();
      setRows(res.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load disputes');
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const visible = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)!;
    return (rows ?? []).filter(f.test);
  }, [rows, filter]);

  const kpi = useMemo(() => {
    const open = (rows ?? []).filter((r) => r.status !== 'RESOLVED');
    const due24 = open.filter((r) => r.urgency.level === 'CRITICAL' || r.urgency.level === 'OVERDUE');
    const ready = open.filter((r) => r.gatherState === 'READY_FOR_REVIEW');
    const atRisk = open.filter((r) => r.allowedActions.length > 0);
    const currency = open[0]?.amountCurrency ?? 'USD';
    const value = atRisk.reduce((s, r) => s + Number(r.amountValue), 0);
    return { open: open.length, due24: due24.length, ready: ready.length, value: money(value, currency) };
  }, [rows]);

  const columns = useMemo<ColDef<QueueItem>[]>(
    () => [
      {
        headerName: 'Urgency',
        field: 'urgency',
        width: 158,
        comparator: (a, b) => a.sortKey - b.sortKey,
        cellRenderer: (p: ICellRendererParams<QueueItem>) => (p.data ? <UrgencyBadge urgency={p.data.urgency} /> : null),
        getQuickFilterText: (p) => p.data?.urgency.label ?? '',
      },
      {
        headerName: 'Due in',
        field: 'dueIn',
        width: 122,
        comparator: (_a, _b, na, nb) => (na.data?.urgency.sortKey ?? 0) - (nb.data?.urgency.sortKey ?? 0),
        cellClass: 'nowrap num strong',
      },
      {
        headerName: 'Dispute',
        field: 'id',
        width: 196,
        cellRenderer: (p: ICellRendererParams<QueueItem>) =>
          p.data ? (
            <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <span className="cell-id">{p.data.id}</span>
              {p.data.fixture && <FixtureBadge />}
            </span>
          ) : null,
      },
      { headerName: 'Reason', field: 'reasonLabel', flex: 1, minWidth: 130 },
      {
        headerName: 'Amount',
        field: 'amountValue',
        width: 108,
        type: 'rightAligned',
        comparator: (a, b) => Number(a) - Number(b),
        valueFormatter: (p) => (p.data ? money(p.data.amountValue, p.data.amountCurrency) : ''),
        cellClass: 'num',
      },
      {
        headerName: 'PayPal status',
        field: 'status',
        width: 188,
        cellRenderer: (p: ICellRendererParams<QueueItem>) => (p.data ? <StatusBadge status={p.data.status} /> : null),
      },
      { headerName: 'Evidence', field: 'completeness', width: 180, cellRenderer: ScoreCell },
      {
        headerName: 'Desk',
        field: 'gatherState',
        width: 166,
        cellRenderer: (p: ICellRendererParams<QueueItem>) => (p.data ? <GatherBadge state={p.data.gatherState} /> : null),
      },
      {
        headerName: 'Next action',
        field: 'recommendedAction',
        width: 140,
        valueFormatter: (p) =>
          p.value ? DISPUTE_ACTION_LABELS[p.value as DisputeAction]?.label ?? String(p.value) : p.data?.allowedActions.length ? '—' : 'None available',
        tooltipValueGetter: (p) => p.data?.triageNote ?? null,
      },
    ],
    [],
  );

  const open = (id: string) => navigate(`/disputes/${encodeURIComponent(id)}`);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dispute queue</h1>
          <p>Soonest deadline first. Ordering is by PayPal&apos;s response due date — never by the AI.</p>
        </div>
        <button
          className="btn"
          disabled={polling}
          onClick={async () => {
            setPolling(true);
            try {
              await api.poll();
              await load();
            } finally {
              setPolling(false);
            }
          }}
        >
          {polling ? <span className="spinner" /> : '↻'} Check PayPal now
        </button>
      </div>

      <div className="kpis">
        <div className="card kpi"><div className="label">Open disputes</div><div className="value">{kpi.open}</div><div className="sub">awaiting a decision</div></div>
        <div className={`card kpi ${kpi.due24 > 0 ? 'alarm' : ''}`}><div className="label">Due within 24h or overdue</div><div className="value">{kpi.due24}</div><div className="sub">handle these first</div></div>
        <div className="card kpi"><div className="label">Ready for review</div><div className="value">{kpi.ready}</div><div className="sub">evidence gathered and drafted</div></div>
        <div className="card kpi"><div className="label">Disputed value, actionable</div><div className="value">{kpi.value}</div><div className="sub">across open disputes</div></div>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="card">
        <div className="toolbar" role="toolbar" aria-label="Queue filters">
          {FILTERS.map((f) => (
            <button key={f.key} className="chip" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
              <span className="count">{(rows ?? []).filter(f.test).length}</span>
            </button>
          ))}
          <div className="grow" />
          <label className="sr-only" htmlFor="quick">Search disputes</label>
          <input id="quick" type="search" placeholder="Search id, reason, status…" value={quick} onChange={(e) => setQuick(e.target.value)} style={{ width: 260 }} />
        </div>
        <div className="grid-wrap">
          <AgGridReact<QueueItem>
            theme={theme}
            rowData={rows === null ? undefined : visible}
            columnDefs={columns}
            defaultColDef={{ sortable: true, resizable: true, suppressMovable: true }}
            getRowId={(p) => p.data.id}
            quickFilterText={quick}
            loading={rows === null}
            overlayNoRowsTemplate="<span style='color:#5d6b82'>No disputes match this filter.</span>"
            onRowClicked={(e: RowClickedEvent<QueueItem>) => e.data && open(e.data.id)}
            onCellKeyDown={(e: CellKeyDownEvent<QueueItem>) => {
              const ke = e.event as KeyboardEvent | undefined;
              if (ke?.key === 'Enter' && e.data) open(e.data.id);
            }}
            rowStyle={{ cursor: 'pointer' }}
            tooltipShowDelay={300}
            animateRows
          />
        </div>
      </div>
      <p className="muted small" style={{ marginTop: 10 }}>
        Tip: use arrow keys to move through rows and Enter to open one.
      </p>
    </>
  );
}
