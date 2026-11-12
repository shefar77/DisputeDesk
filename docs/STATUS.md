# Build status against the PRD

Snapshot: 2026-11-11. Each row uses one of four verdicts:

- **Verified:** exercised by an automated test or a recorded run.
- **Demo-verified:** verified in demo mode; the live path uses the same code but has not been run against the real service.
- **Implemented, unverified:** the code is written and typechecks, but has never run against the real dependency.
- **Not implemented.**

## PayPal Sandbox verification (2026-11-12)

Run against the real `https://api-m.sandbox.paypal.com`, from the standalone
spike script and then from the application itself:

| Call | Result |
|---|---|
| `POST /v1/oauth2/token` (client credentials) | **200**, `Bearer`, `expires_in` 32400; granted scopes include `disputes` |
| `GET /v1/customer/disputes` | **200**, `items: []`, `paypal-debug-id f252324010bb7` |
| App boot with credentials set | mode `sandbox`, `PayPal gateway: SANDBOX mode`, health `ok`, poll `found=0 new=0 error=null` |

The sandbox seller account has no disputes, because no checkout was performed.
So reading a live dispute's `links`, and every write, remain unverified against
PayPal — the demo gateway still serves those paths and the UI labels them.

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
| FR-10 | `provide-evidence`, no silent retry of writes | Demo-verified | Writes use `retry: false`; on a network failure the dispute is re-read. **No write has ever been sent to PayPal.** Sandbox auth and reads are verified (2026-11-12), but the seller account has no disputes, so the write path is still demo-only (see `spike-G0.md`). |
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
| The same metric on 6 held-out fixtures | — | **66.7%** within ±1 (33.3% exact), rule-based; **100%** within ±1 (83.3–100% exact), Gemini | `npm run eval` / `npm run eval -- --with-llm` |
| Zero actions without an approval record | 100% | **100%** | integration test plus the DB unique constraint |
| Drafts cite only existing ids | 100% | **100%** | validator plus eval |
| Dispute event to ready-for-review card | < 90 s | ~0.1 s rule-based; **~27 s** with Gemini (3 calls) on an uncontended free tier, up to ~125 s during a 503 spike | workflow timing in the timeline |

**AI vs baseline (PRD §13 Audit C). Measured 2026-11-11.** Three runs of `npm run eval -- --with-llm` against Gemini. On the 6 held-out cases the baseline scores 66.7% field accuracy / 33.3% exact band; the model scores 93.3–100% / 83.3–100%, and 100% within ±1 in every run. Ranges rather than single figures because the model is nondeterministic. All three runs were served by `gemini-3.1-flash-lite` after the newer Flash tiers returned 503 under free-tier contention. Held-out suites were 6/6 model-generated every run; one development-set run degraded to 9/12, so that column mixes generators and is not quoted. Draft *quality* is still ungraded — `docs/eval-drafts.md` needs the human 3-point rubric.

## Sponsor integrations (PRD §14). The Nov 7 freeze rule applies

| Sponsor | Verdict | Notes |
|---|---|---|
| AG Grid | Verified | Community edition: queue with sorting, quick filter, keyboard navigation, custom cell renderers. Row grouping is Enterprise-only, so urgency grouping uses filter chips. |
| Render | Deploying; not yet live | `render.yaml` blueprint (free web service + free Postgres). Builds succeed; the first start attempts were OOM-killed on the 512 MiB free instance and the fixes are measured in §Deviations 1. **Render Workflows is not integrated**: an in-process durable step runner (the PRD's documented fallback) provides retries and persisted steps. |
| Elastic | Implemented, unverified | Policy index, BM25 search, ES\|QL. Never run against a cluster. The Postgres FTS fallback is verified and is what demo mode uses. Search is lexical, not hybrid. |
| KERNEL | Implemented, unverified | See FR-6. |
| Postman | Verified | Collection generated from code; Newman passes 12 requests and 27 assertions against demo mode; runs in CI. |
| Zapier | Not implemented | See FR-15. |
| APIMatic, Bryntum | Not used | Bonus tier in the PRD. |
| Channel3, Astropods | Excluded | As decided in the PRD. |

Per PRD §14, any sponsor still unverified on Nov 7 must be removed from the README, the video and the Devpost text.

## Deviations from the PRD, and why

1. **Embedded PGlite for local runs; managed Postgres in production.** Judges should not need Docker, so with no configuration the app runs on PGlite (Postgres compiled to WASM), and the schema and queries are identical either way. **Verified 2026-11-12:** the `DATABASE_URL` / node-postgres path now runs against a real PostgreSQL 16 server — migrations apply, all 14 fixtures are served, the UI loads.
   Production uses it because PGlite does not fit a 512 MiB free instance. Measured in a Linux container capped at 512 MiB: PGlite with no data directory is OOM-killed, because `initdb` loads a second WASM module and resident memory jumps ~300 MiB in a single step; with the directory prebuilt it survives at a 419 MiB peak; managed Postgres peaks at 90 MiB. PGlite's WASM heap cannot be shrunk — its module declares 2048 pages (128 MiB), so a smaller `initialMemory` is a hard LinkError.
2. **The completeness score comes entirely from the rule-based rubric** (the PRD said "partly"). The model extracts facts and writes the narrative. The score is reproducible and testable.
3. **Contradiction cap.** Evidence that contradicts delivery (wrong postcode, return to sender, carrier exception) caps the score at 69 and steers the recommendation towards an offer. This was added after hand-labelling showed that a wrong-address delivery would otherwise score STRONG.
4. **No sampling parameters are sent.** Current Claude models reject them with a 400, and nothing equivalent is sent to Gemini either. Determinism comes from schema-constrained decoding and from rule-based scoring.
5. **Default provider is Gemini** (`GEMINI_API_KEY`, default model `gemini-3-flash-preview`), with Claude available via `LLM_PROVIDER=anthropic`. Both sit behind one `LLMClient` interface and share the same prompts, JSON Schemas and validators. The $5/day hard cap is enforced in code whichever provider or model is configured.
9. **Model fallback chain.** The newer Gemini Flash tiers answer free-tier requests with a 503 "high demand" when busy, so `LLM_FALLBACK_MODELS` lists models to try next. The UI and the eval report name whichever model actually served, never the one configured.
6. **The rule-based generator is also the eval baseline.** It is real shipped code, not a strawman written for the comparison.
7. **Held-out eval set added.** The rule-based extractor was tuned on the 12 development cases, so a second set written afterwards is needed for an honest comparison.
8. **Demo-only endpoints** `POST /api/demo/reset` and `POST /api/demo/disputes/:id/resolve` exist so the full loop can be shown without PayPal. Both return 404 outside demo mode, and every effect they have is labelled as a simulation.

## Still open (PRD §29)

- G0 sandbox spike: steps 1 and 3 (auth + list) **done 2026-11-12**; step 2 (file a dispute) not done, which still blocks the write steps (`spike-G0.md`).
- Merchant validation: zero conversations so far. The README says so.
- Human grading of `docs/eval-drafts.md` against the PRD's 3-point rubric. (The model eval run itself is done — see §AI vs baseline above.)
- Render deployment and a free hosted demo through Dec 15.
- Quotas and trial terms for Elastic, Kernel and Render (`docs/quotas.md` not started).
- Name/trademark check.
