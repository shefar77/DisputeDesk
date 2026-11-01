/**
 * Canonical serialisation of an outbound PayPal request.
 *
 * The approval gate (FR-9, PRD §16) binds an `approval` row to the SHA-256 of the
 * exact request that will be sent. For that binding to mean anything, the bytes
 * hashed at preview time must be byte-identical to the bytes hashed at submit
 * time, and the string shown to the merchant must be the string that was hashed.
 *
 * So: one canonicaliser, in shared code, used by the preview endpoint, the submit
 * path, and the UI. Object keys are sorted; `undefined` is dropped; no incidental
 * whitespace. Files are represented by their own content hash, never their bytes,
 * so the canonical form stays small and stable.
 */

export interface OutboundFileRef {
  /** The multipart field name PayPal expects, e.g. "evidence-file". */
  field: string;
  filename: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}

/** The complete description of one outbound write to PayPal. */
export interface OutboundRequest {
  method: 'POST' | 'PATCH';
  /** Absolute URL, exactly as it will be called. */
  url: string;
  /** "application/json" or "multipart/related". */
  contentType: string;
  /** The JSON body (the `input` part when multipart). */
  body: unknown;
  /** Attached documents, if any. */
  files: OutboundFileRef[];
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      const v = src[key];
      if (v === undefined) continue;
      out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

/**
 * The exact string that gets hashed. Stable across processes and platforms.
 * Deliberately not pretty-printed — see `prettyPayload` for the display form.
 */
export function canonicalize(req: OutboundRequest): string {
  return JSON.stringify(
    sortValue({
      method: req.method,
      url: req.url,
      contentType: req.contentType,
      body: req.body,
      files: req.files.map((f) => ({
        field: f.field,
        filename: f.filename,
        mimeType: f.mimeType,
        bytes: f.bytes,
        sha256: f.sha256,
      })),
    }),
  );
}

/** Indented JSON for the approval modal. Same data, readable layout. */
export function prettyPayload(req: OutboundRequest): string {
  return JSON.stringify(sortValue(req.body), null, 2);
}

/** Short hash for display: "sha256:a1b2c3d4…". */
export function shortHash(hash: string): string {
  return `sha256:${hash.slice(0, 12)}…`;
}
