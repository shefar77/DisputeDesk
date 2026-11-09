/**
 * The deadline-first queue (FR-3, PRD §11 screen 1).
 *
 * Ordering comes from the server and is deterministic (by seller_response_due_date).
 * AG Grid Community: sorting, quick filter, keyboard navigation. Row grouping is an
 * Enterprise feature, so urgency grouping is done with the segmented filter instead.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AgGridReact } from 'ag-grid-react';
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type CellKeyDownEvent,
  type ColDef,
  type ICellRendererParams,
  type RowClickedEvent,
} from 'ag-grid-community';
import { DISPUTE_ACTION_LABELS, type DisputeAction } from '@shared/index.js';
import { api, money, type QueueItem } from '../api';
import { BAND_COLOR, GatherBadge, Notice, StatusBadge, UrgencyBadge, humanize } from '../components';
import { Icon, type IconName } from '../icons';

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  accentColor: '#2459e0',
  borderColor: '#e3e8ef',
  foregroundColor: '#0f1729',
  headerBackgroundColor: '#f8fafc',
  headerTextColor: '#5f6b7d',
  headerFontWeight: 600,
  headerFontSize: 12.5,
  fontFamily: "'Inter Variable', Inter, system-ui, sans-serif",
  fontSize: 13.5,
  rowHeight: 52,
  headerHeight: 42,
  cellHorizontalPadding: 16,
  wrapperBorderRadius: 0,
  wrapperBorder: false,
  rowBorder: { color: '#eef1f5' },
  rowHoverColor: '#f6f8fc',
  selectedRowBackgroundColor: '#eef3ff',
});

type Filter = 'all' | 'urgent' | 'ready' | 'manual' | 'resolved';

const FILTERS: { key: Filter; label: string; test: (r: QueueItem) => boolean }[] = [
  { key: 'all', label: 'All open', test: (r) => r.status !== 'RESOLVED' },
  { key: 'urgent', label: 'Due within 72h', test: (r) => ['OVERDUE', 'CRITICAL', 'URGENT'].includes(r.urgency.level) && r.status !== 'RESOLVED' },
  { key: 'ready', label: 'Ready for review', test: (r) => r.gatherState === 'READY_FOR_REVIEW' },
  { key: 'manual', label: 'Needs attention', test: (r) => r.gatherState === 'NEEDS_MANUAL_REVIEW' || r.gatherState === 'FAILED' },
  { key: 'resolved', label: 'Resolved', test: (r) => r.status === 'RESOLVED' },
];

function ScoreCell({ data }: ICellRendererParams<QueueItem>) {
  if (!data) return null;
  if (data.completeness === null) {
    return <span className="muted small">{data.supported ? 'Pending' : 'Manual handling'}</span>;
  }
  const col = BAND_COLOR[data.band ?? ''] ?? 'var(--neutral)';
  return (
    <div className="score-cell" title={`${data.completeness}/100 · ${humanize(data.band)}`}>
      <span className="score-num">{data.completeness}</span>
      <div className="score-bar" aria-hidden="true">
        <span style={{ width: `${data.completeness}%`, background: col }} />
      </div>
    </div>
  );
}

function Kpi({ icon, tone, label, value, caption, alert = false }: {
  icon: IconName;
  tone: string;
  label: string;
  value: string | number;
  caption: string;
  alert?: boolean;
}) {
  return (
    <div className="card kpi">
      <span className={`kpi-icon tone-${tone}`}>
        <Icon name={icon} size={18} />
      </span>
      <div className="grow">
        <div className="kpi-label">{label}</div>
        <div className={`kpi-value ${alert ? 'alert' : ''}`}>{value}</div>
        <div className="kpi-caption">{caption}</div>
      </div>
    </div>
  );
}

export function QueuePage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [quick, setQuick] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.disputes();
      setRows(res.items);
      setUpdatedAt(new Date());
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
    // A dispute PayPal is already reviewing has no response deadline left to miss.
    const due24 = open.filter(
      (r) => r.status !== 'UNDER_REVIEW' && (r.urgency.level === 'CRITICAL' || r.urgency.level === 'OVERDUE'),
    );
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
        cellRenderer: (p: ICellRendererParams<QueueItem>) => {
          if (!p.data) return null;
          if (p.data.status === 'RESOLVED') {
            return (
              <span className="badge tone-success">
                <Icon name="checkCircle" />
                Resolved
              </span>
            );
          }
          if (p.data.status === 'UNDER_REVIEW') {
            return (
              <span className="badge tone-info">
                <Icon name="clock" />
                With PayPal
              </span>
            );
          }
          return <UrgencyBadge urgency={p.data.urgency} />;
        },
        getQuickFilterText: (p) => p.data?.urgency.label ?? '',
      },
      {
        headerName: 'Time left',
        field: 'dueIn',
        width: 126,
        comparator: (_a, _b, na, nb) => (na.data?.urgency.sortKey ?? 0) - (nb.data?.urgency.sortKey ?? 0),
        valueFormatter: (p) => (p.data?.status === 'RESOLVED' || p.data?.status === 'UNDER_REVIEW' ? '—' : String(p.value ?? '—')),
        cellClass: 'nowrap num cell-strong',
      },
      {
        headerName: 'Dispute ID',
        field: 'id',
        width: 152,
        cellRenderer: (p: ICellRendererParams<QueueItem>) => (p.data ? <span className="cell-id">{p.data.id}</span> : null),
      },
      { headerName: 'Reason', field: 'reasonLabel', flex: 1, minWidth: 184, tooltipField: 'reasonLabel' },
      {
        headerName: 'Amount',
        field: 'amountValue',
        width: 108,
        type: 'rightAligned',
        comparator: (a, b) => Number(a) - Number(b),
        valueFormatter: (p) => (p.data ? money(p.data.amountValue, p.data.amountCurrency) : ''),
        cellClass: 'num cell-strong',
      },
      {
        headerName: 'PayPal status',
        field: 'status',
        width: 160,
        cellRenderer: (p: ICellRendererParams<QueueItem>) => (p.data ? <StatusBadge status={p.data.status} compact /> : null),
      },
      { headerName: 'Evidence score', field: 'completeness', width: 160, cellRenderer: ScoreCell },
      {
        headerName: 'Review status',
        field: 'gatherState',
        width: 176,
        cellRenderer: (p: ICellRendererParams<QueueItem>) => (p.data ? <GatherBadge state={p.data.gatherState} /> : null),
      },
      {
        headerName: 'Recommended',
        field: 'recommendedAction',
        width: 150,
        valueFormatter: (p) => {
          if (p.data?.status === 'RESOLVED') return '—';
          if (!p.data?.allowedActions.length) return 'No action available';
          return p.value ? (DISPUTE_ACTION_LABELS[p.value as DisputeAction]?.label ?? String(p.value)) : '—';
        },
        tooltipValueGetter: (p) => p.data?.triageNote ?? null,
      },
    ],
    [],
  );

  const open = (id: string) => navigate(`/disputes/${encodeURIComponent(id)}`);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Disputes</h1>
          <p className="page-subtitle">Prioritised by PayPal&apos;s response deadline, soonest first.</p>
        </div>
        <div className="page-actions">
          {updatedAt && (
            <span className="updated">
              <Icon name="clock" size={13} />
              Updated {updatedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            className="btn"
            disabled={syncing}
            onClick={async () => {
              setSyncing(true);
              try {
                await api.poll();
                await load();
              } finally {
                setSyncing(false);
              }
            }}
          >
            {syncing ? <span className="spinner" /> : <Icon name="refresh" size={15} />}
            Sync with PayPal
          </button>
        </div>
      </div>

      <div className="kpi-grid">
        <Kpi icon="inbox" tone="info" label="Open disputes" value={kpi.open} caption="Awaiting resolution" />
        <Kpi icon="alertTriangle" tone="danger" label="Due within 24 hours" value={kpi.due24} caption="Including overdue" alert={kpi.due24 > 0} />
        <Kpi icon="fileCheck" tone="success" label="Ready for review" value={kpi.ready} caption="Evidence collected and drafted" />
        <Kpi icon="wallet" tone="neutral" label="Value at risk" value={kpi.value} caption="Across actionable disputes" />
      </div>

      {error && (
        <div style={{ marginBottom: 16 }}>
          <Notice tone="danger" title="Could not load disputes">
            {error}
          </Notice>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="toolbar" role="toolbar" aria-label="Filter disputes">
          <div className="segmented">
            {FILTERS.map((f) => (
              <button key={f.key} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label}
                <span className="count">{(rows ?? []).filter(f.test).length}</span>
              </button>
            ))}
          </div>
          <div className="grow" />
          <label className="sr-only" htmlFor="quick">
            Search disputes
          </label>
          <div className="search">
            <Icon name="search" size={15} />
            <input id="quick" type="search" placeholder="Search by ID, reason or status" value={quick} onChange={(e) => setQuick(e.target.value)} />
          </div>
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
            overlayNoRowsTemplate="<span style='color:#5f6b7d'>No disputes match this view.</span>"
            onRowClicked={(e: RowClickedEvent<QueueItem>) => e.data && open(e.data.id)}
            onCellKeyDown={(e: CellKeyDownEvent<QueueItem>) => {
              const ke = e.event as KeyboardEvent | undefined;
              if (ke?.key === 'Enter' && e.data) open(e.data.id);
            }}
            tooltipShowDelay={300}
            animateRows
          />
        </div>
      </div>
    </>
  );
}
