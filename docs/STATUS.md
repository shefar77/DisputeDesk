# Build status against the PRD

Snapshot: 2026-11-01. Each row uses one of four verdicts:

- **Verified:** exercised by an automated test or a recorded run.
- **Demo-verified:** verified in demo mode; the live path uses the same code but has not been run against the real service.
- **Implemented, unverified:** the code is written and typechecks, but has never run against the real dependency.
- **Not implemented.**

## Functional requirements (PRD §9)

| ID | Requirement | Verdict | Evidence |
|---|---|---|---|
| FR-1 | Signed webhooks, idempotent on event id | Demo-verified | Integration tests: an unverifiable event is rejected with 400 and not stored; a duplicate delivery returns `duplicate: true`. Verification against PayPal's real endpoint has not run (needs `PAYPAL_WEBHOOK_ID`). |
| FR-2 | Polling fallback | Demo-verified | `pollDisputes` runs on boot and on an interval; a Render cron calls `POST /api/cron/poll`. |
| FR-3 | Deadline-sorted queue with urgency badges | Verified | Unit test (ordering, bands); integration test (queue sort); e2e (overdue row first). |
| FR-4 | Actions come only from HATEOAS `links` | Verified | Integration test and e2e J3: no `provide-evidence` button when the link is absent; the server returns 409 if it is called anyway. |
| FR-5 | Evidence items carry source, type, hash and timestamp | Verified | `evidence_item` table; every item has `sha256` and `source_ref`. |
| FR-6 | KERNEL carrier capture, with visible fallback | Demo-verified / Implemented, unverified | The fixture capture and the blocked-page fallback (J2) are tested. The real Kernel calls are written against the installed `@onkernel/sdk` 0.139 types but have not run (no key). |
| FR-7 | Schema-validated `EvidencePlan`; retry, then manual review | Verified | Structured outputs plus zod; mocked-wire tests cover refusal and semantic-invalid output; `withFallback` retries once and then uses the rule-based generator. |
| FR-8 | Drafts cite only existing evidence ids | Verified | `validateDraft`; integration test over every fixture; eval metric at 100%. |
| FR-9 | Exact outbound preview; approval bound to the payload hash | Verified | Integration tests for a hash mismatch, an edit after preview and a replayed approval. Every gateway write has a matching SENT approval row. |
| FR-10 | `provide-evidence`, no silent retry of writes | Demo-verified | Writes use `retry: false`; on a network failure the dispute is re-read. Not yet sent to a real sandbox dispute (see `spike-G0.md`). |
| FR-11 | Status changes reflected from webhooks and polls | Verified (demo) | e2e: approve, then UNDER_REVIEW, then a simulated resolution webhook, then RESOLVED in the timeline. |
| FR-12 | Exportable audit log without secrets | Verified | Redaction happens at write time; tests check that tokens and secrets are absent; `GET /api/audit?download=1`. |
| FR-13 | Sandbox/demo banner on every page | Verified | e2e checks four routes. |
| FR-14 | `make-offer` / `accept-claim` behind approval, offer capped at the disputed amount | Verified (demo) | 422 when the offer is too large; both actions are flagged high-consequence and need an extra confirmation. |
| FR-15 | Zapier MCP order records | **Not implemented** | P1. The `order_record` workflow step is where it would plug in. Demo uses fixture records labelled as fixtures. |
| FR-16 | ES\|QL analytics | Implemented, unverified | `/api/analytics` runs an ES\|QL query when Elastic is configured. Postgres analytics are shown in Settings. |

## Success criteria (PRD §7). Fixtures only, not real users

| Metric | Target | Measured | How |
|---|---|---|---|
| P0 flow completes in demo mode | ≥ 95% of 20 runs | **20/20 (100%)** | `npx playwright test -g J1 --repeat-each=20` |
| Completeness band agreement on 12 labelled fixtures | ≥ 80% within ±1 | **100%** within ±1 (91.7% exact), rule-based | `npm run eval` (development set) |
| The same metric on 6 held-out fixtures | — | **66.7%** within ±1 (33.3% exact), rule-based | `npm run eval` (held-out set) |
| Zero actions without an approval record | 100% | **100%** | integration test plus the DB unique constraint |
| Drafts cite only existing ids | 100% | **100%** | validator plus eval |
| Dispute event to ready-for-review card | < 90 s | ~0.1 s rule-based on fixtures; model latency not measured | workflow timing in the timeline |

**AI vs baseline (PRD §13 Audit C).** Not measured yet: this environment had no `ANTHROPIC_API_KEY`, and a paid run is the owner's decision. Run `npm run eval -- --with-llm`. The baseline's drop on the held-out set (66.7% field accuracy) is where a model should help. No claim is made until that is measured.

## Sponsor integrations (PRD §14). The Nov 7 freeze rule applies

| Sponsor | Verdict | Notes |
|---|---|---|
| AG Grid | Verified | Community edition: queue with sorting, quick filter, keyboard navigation, custom cell renderers. Row grouping is Enterprise-only, so urgency grouping uses filter chips. |
| Render | Implemented, unverified | `render.yaml` blueprint (web service, Postgres, cron) has not been deployed. **Render Workflows is not integrated**: an in-process durable step runner (the PRD's documented fallback) provides retries and persisted steps. |
| Elastic | Implemented, unverified | Policy index, BM25 search, ES\|QL. Never run against a cluster. The Postgres FTS fallback is verified and is what demo mode uses. Search is lexical, not hybrid. |
| KERNEL | Implemented, unverified | See FR-6. |
| Postman | Verified | Collection generated from code; Newman passes 12 requests and 27 assertions against demo mode; runs in CI. |
| Zapier | Not implemented | See FR-15. |
| APIMatic, Bryntum | Not used | Bonus tier in the PRD. |
| Channel3, Astropods | Excluded | As decided in the PRD. |

Per PRD §14, any sponsor still unverified on Nov 7 must be removed from the README, the video and the Devpost text.

## Deviations from the PRD, and why

1. **Embedded PGlite by default; Postgres through `DATABASE_URL`.** The Docker daemon was unavailable, and judges should not need Docker. PGlite is Postgres compiled to WASM, so the schema and queries are identical. *The `DATABASE_URL` / node-postgres path has not been run against a real server yet.*
2. **The completeness score comes entirely from the rule-based rubric** (the PRD said "partly"). The model extracts facts and writes the narrative. The score is reproducible and testable.
3. **Contradiction cap.** Evidence that contradicts delivery (wrong postcode, return to sender, carrier exception) caps the score at 69 and steers the recommendation towards an offer. This was added after hand-labelling showed that a wrong-address delivery would otherwise score STRONG.
4. **No `temperature` is sent.** Current Claude models reject sampling parameters with a 400 error. Determinism comes from structured outputs and from rule-based scoring.
5. **Default model is `claude-opus-5-5`**, set through `LLM_MODEL`. The $5/day hard cap is enforced in code whichever model is configured.
6. **The rule-based generator is also the eval baseline.** It is real shipped code, not a strawman written for the comparison.
7. **Held-out eval set added.** The rule-based extractor was tuned on the 12 development cases, so a second set written afterwards is needed for an honest comparison.
8. **Demo-only endpoints** `POST /api/demo/reset` and `POST /api/demo/disputes/:id/resolve` exist so the full loop can be shown without PayPal. Both return 404 outside demo mode, and every effect they have is labelled as a simulation.

## Still open (PRD §29)

- G0 sandbox spike, steps 1–6 (`spike-G0.md`).
- Merchant validation: zero conversations so far. The README says so.
- Model eval run (`--with-llm`) and human grading of `docs/eval-drafts.md`.
- Render deployment and a free hosted demo through Dec 15.
- Quotas and trial terms for Elastic, Kernel and Render (`docs/quotas.md` not started).
- Name/trademark check.
