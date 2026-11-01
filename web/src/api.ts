/** API client. Every write carries the double-submit CSRF token. */

import type {
  DisputeDetail,
  DisputeListItem,
  EvidenceItemView,
  HealthResponse,
  PreviewRequest,
  PreviewResponse,
} from '@shared/index.js';

export type QueueItem = DisputeListItem & { fixture: boolean };
export type Detail = DisputeDetail & { fixture: boolean; running: boolean };

export interface ApproveResult {
  approvalId: string;
  ok: boolean;
  simulated: boolean;
  httpStatus: number | null;
  debugId: string | null;
  error: string | null;
  disputeStatus: string | null;
}

export interface Session {
  csrfToken: string;
  authRequired: boolean;
  authenticated: boolean;
  mode: 'demo' | 'sandbox' | 'live';
  operator: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string,
    readonly detail: string,
    readonly debugId?: string,
  ) {
    super(message);
  }
}

let csrf: string | null = null;

async function request<T>(method: string, path: string, body?: unknown, isForm = false): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    if (!csrf) await getSession();
    headers['x-csrf-token'] = csrf ?? '';
  }
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok && !(path.endsWith('/approve') && json && 'approvalId' in json)) {
    const type = String(json?.type ?? '').split('/').pop() ?? 'error';
    throw new ApiError(json?.title ?? `HTTP ${res.status}`, res.status, type, json?.detail ?? '', json?.debug_id);
  }
  return json as T;
}

export async function getSession(): Promise<Session> {
  const s = await request<Session>('GET', '/api/session');
  csrf = s.csrfToken;
  return s;
}

export const api = {
  login: (password: string) => request<{ ok: boolean }>('POST', '/api/login', { password }),
  health: () => request<HealthResponse & { demoReason: string | null; lastPoll: { at: string; found: number; error: string | null } | null }>('GET', '/api/health'),
  disputes: () => request<{ items: QueueItem[]; mode: string }>('GET', '/api/disputes'),
  dispute: (id: string) => request<Detail>('GET', `/api/disputes/${encodeURIComponent(id)}`),
  refresh: (id: string) => request<{ started: boolean }>('POST', `/api/disputes/${encodeURIComponent(id)}/refresh`, {}),
  poll: () => request<{ found: number; newIds: string[] }>('POST', '/api/disputes/poll', {}),
  saveDraft: (id: string, edited_text: string) =>
    request<{ ok: boolean }>('PUT', `/api/disputes/${encodeURIComponent(id)}/draft`, { edited_text }),
  preview: (id: string, req: PreviewRequest) =>
    request<PreviewResponse>('POST', `/api/disputes/${encodeURIComponent(id)}/preview`, req),
  approve: (id: string, req: PreviewRequest & { payload_sha256: string }) =>
    request<ApproveResult>('POST', `/api/disputes/${encodeURIComponent(id)}/approve`, req),
  upload: (id: string, file: File, label: string) => {
    const fd = new FormData();
    fd.append('label', label);
    fd.append('file', file);
    return request<EvidenceItemView>('POST', `/api/disputes/${encodeURIComponent(id)}/evidence`, fd, true);
  },
  resetDemo: () => request<{ ok: boolean }>('POST', '/api/demo/reset', {}),
  simulateResolve: (id: string, outcome: 'seller' | 'buyer') =>
    request<{ received: boolean }>('POST', `/api/demo/disputes/${encodeURIComponent(id)}/resolve`, { outcome }),
  audit: (disputeId?: string) =>
    request<{ count: number; entries: { id: string; ts: string; actor: string; event: string; disputeId: string | null; detail: unknown }[] }>(
      'GET',
      `/api/audit${disputeId ? `?disputeId=${encodeURIComponent(disputeId)}` : ''}`,
    ),
  analytics: () =>
    request<{
      byStatus: { status: string; n: number }[];
      byBand: { band: string; n: number }[];
      submissions: { result: string; n: number }[];
      ai: { calls: number; costUsd: number };
    }>('GET', '/api/analytics'),
};

export function money(value: string | number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(value));
  } catch {
    return `${currency} ${value}`;
  }
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
