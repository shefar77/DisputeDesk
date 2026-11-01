/** Shapes crossing the API boundary. The web app imports these directly. */

import type {
  DisputeAction,
  DisputeReason,
  DisputeStage,
  DisputeStatus,
  EvidenceType,
} from './paypal-constants.js';
import type { EvidenceKind, EvidencePlan, EvidenceSource } from './schemas.js';
import type { OutboundFileRef, OutboundRequest } from './canonical.js';
import type { UrgencyInfo } from './urgency.js';

export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

export interface DisputeListItem {
  id: string;
  reason: DisputeReason;
  reasonLabel: string;
  stage: DisputeStage | null;
  status: DisputeStatus;
  amountValue: string;
  amountCurrency: string;
  dueAt: string | null;
  urgency: UrgencyInfo;
  dueIn: string;
  completeness: number | null;
  band: string | null;
  gatherState: GatherState;
  allowedActions: DisputeAction[];
  recommendedAction: DisputeAction | null;
  triageNote: string | null;
  supported: boolean;
  createdAt: string;
  updatedAt: string;
}

export const GATHER_STATES = [
  'NOT_STARTED',
  'GATHERING',
  'READY_FOR_REVIEW',
  'NEEDS_MANUAL_REVIEW',
  'SUBMITTED',
  'FAILED',
] as const;
export type GatherState = (typeof GATHER_STATES)[number];

export interface EvidenceItemView {
  id: string;
  kind: EvidenceKind;
  source: EvidenceSource;
  label: string;
  sourceRef: string | null;
  contentText: string | null;
  filePath: string | null;
  mimeType: string | null;
  bytes: number | null;
  sha256: string;
  capturedAt: string;
  confidence: number | null;
  /** True when this item was produced in demo mode from a fixture. */
  fixture: boolean;
}

export interface WorkflowStepView {
  name: string;
  label: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  detail: string | null;
  /** Set when the step failed but a documented fallback took over. */
  fallbackUsed: string | null;
}

export interface TimelineEntry {
  id: string;
  at: string;
  kind: 'dispute' | 'workflow' | 'ai' | 'approval' | 'submission' | 'webhook' | 'note';
  title: string;
  detail: string | null;
}

export interface DraftView {
  id: string;
  text: string;
  editedText: string | null;
  evidenceRefs: string[];
  tone: string;
  generator: 'llm' | 'deterministic';
  model: string;
  createdAt: string;
}

export interface DisputeDetail extends DisputeListItem {
  buyerMessages: { posted: string; by: string; content: string }[];
  sellerResponseDueDate: string | null;
  links: PayPalLink[];
  plan: EvidencePlan | null;
  draft: DraftView | null;
  evidence: EvidenceItemView[];
  steps: WorkflowStepView[];
  timeline: TimelineEntry[];
  raw: unknown;
  submissions: SubmissionView[];
  /** Human-readable explanation when `supported` is false or an action is absent. */
  guidance: string[];
}

export interface SubmissionView {
  id: string;
  action: DisputeAction;
  approvedAt: string;
  approvedBy: string;
  payloadSha256: string;
  resultStatus: string;
  httpStatus: number | null;
  debugId: string | null;
  error: string | null;
}

export interface PreviewResponse {
  action: DisputeAction;
  request: OutboundRequest;
  /** The exact string that was hashed. Shown so the merchant can verify the binding. */
  canonical: string;
  payloadSha256: string;
  pretty: string;
  files: OutboundFileRef[];
  /** Reasons the merchant should look twice before approving. */
  warnings: string[];
  /** True when this action moves money or concedes the dispute. */
  highConsequence: boolean;
  evidenceTypes: EvidenceType[];
}

export interface HealthResponse {
  ok: boolean;
  mode: 'demo' | 'sandbox' | 'live';
  version: string;
  dependencies: {
    name: string;
    status: 'ok' | 'degraded' | 'disabled' | 'error';
    detail: string;
    fallback: string | null;
  }[];
  llm: { provider: string; model: string; spentUsd: number; capUsd: number; enabled: boolean };
}

export interface ProblemDetail {
  type: string;
  title: string;
  detail: string;
  status: number;
  debug_id?: string;
}
