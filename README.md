# DisputeDesk

**An open-source, human-approved AI desk that gathers evidence and prepares responses to PayPal disputes before the seller deadline.**

> ⚠️ **Sandbox and demo only.** DisputeDesk talks to the PayPal **sandbox** (test accounts, no real money) or runs on **fixture data** in demo mode. It refuses `PAYPAL_ENV=live` at startup. Nothing here moves real money.

Built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/). MIT licensed.

---

## What it does

When a buyer opens an *Item not received* dispute, the seller has a fixed window to answer with the right evidence. DisputeDesk handles each dispute in four steps:

1. **Triages.** Disputes are ranked by PayPal's `seller_response_due_date`. Urgency is shown with colour, an icon and text.
2. **Gathers evidence.** It reads the dispute, transaction and tracking from PayPal, captures the carrier's tracking page (KERNEL cloud browser) and pulls the order record. Every item gets a source and a SHA-256 hash.
3. **Scores and drafts.** The model *extracts facts*, and a **fixed rubric** scores completeness from 0 to 100, so the number on screen is reproducible rather than model opinion. The model then drafts a response that may cite only evidence ids that exist; a validator rejects anything else.
4. **Waits for your approval.** You see the **exact** request: endpoint, body, files, and the SHA-256 the approval binds to. Only an approval whose hash matches the request byte for byte can send it. The AI never calls PayPal.

## Try it in 60 seconds (no accounts, no keys)

```bash
git clone <this repo> && cd disputedesk
npm install
npm run build      # builds the web UI
npm start          # http://localhost:8787
```

You need Node 20 or later. With no configuration the app starts in **demo mode**: 14 fixture disputes, an embedded Postgres (PGlite), the rule-based generator, and no outbound calls. For hot reload while developing, use `npm run dev` (API on :8787, UI on :5173).

**Suggested walkthrough (about 3 minutes)**

1. **Queue.** The overdue case is at the top. Note the KPIs and the evidence-completeness bars.
2. Open **PP-D-FIX-00001** (due in about 20h). It scores 100/100. Each rubric line shows its points and its source.
3. Click **Re-gather** to watch the workflow steps run live.
4. Open the **Plan & draft** tab. Claims carry `E-n` citations, and the policy notes include their source URLs.
5. Click **Provide evidence · recommended**. Read the exact payload, edit a sentence, and watch **Approve** disable until you re-preview and the hash changes. Then approve.
6. A toast confirms *Recorded locally (demo — nothing sent to PayPal)*. The status, read back from the gateway, is now **Under review**.
7. Click **Simulate: seller wins**. A resolution webhook arrives, and the **Timeline** records it.
8. More cases worth opening:
   - **PP-D-FIX-00007** has a prompt injection hidden in the carrier page. The recommendation stays on evidence.
   - **PP-D-FIX-00004** was delivered to the wrong postcode. The score is capped, and an offer is recommended.
   - **PP-D-FIX-00006** is a carrier page that blocks automation. The fallback is visible.
   - **PP-D-FIX-00013** has no evidence link, so only *Send message* is offered.
9. **Audit log** lists every read, AI call, approval and write, and exports to JSON. **Settings** shows each integration with its fallback, plus a **Reset demo data** button.

## Architecture

```mermaid
flowchart LR
  subgraph PayPal Sandbox
    PD[Disputes API v1]
    PW[Webhooks]
    PT[Shipment trackers]
  end
  subgraph DisputeDesk server
    API[Fastify API + approval gate]
    WF[gatherEvidence workflow<br/>persisted, retried steps]
    RUB[Rubric scorer<br/>deterministic]
    DB[(Postgres / PGlite)]
  end
  UI[React + AG Grid]
  LLM[Gemini Flash<br/>structured outputs]
  EL[(Elastic<br/>or Postgres FTS)]
  KN[KERNEL browser]

  PW -->|signed| API
  API <-->|reads; writes only with approval| PD
  WF --> PT
  WF --> KN
  WF --> LLM
  WF --> EL
  WF --> RUB
  API --> WF
  API --> DB
  UI <--> API
```

**Trust boundaries.** The model returns schema-constrained JSON and has no network or write access. Carrier pages and buyer messages are treated as hostile: they are sanitised and wrapped in nonce-tagged delimiters, and instruction-like text is neutralised. Every write needs an approval row bound to the payload hash, recorded *before* the call. Browser writes need a CSRF token. Secrets are redacted before they reach the logs or the audit table.

## How the AI is used, and measured

| Task | Who does it |
|---|---|
| Extract shipping facts from carrier pages and records | Gemini Flash (structured outputs). Tracking numbers are cross-checked to appear verbatim in a source |
| Score evidence completeness | **Rubric only**, never the model |
| Explain the case, name risks, recommend an action | Gemini Flash, limited to actions PayPal offers. Conceding is only accepted when evidence is WEAK |
| Draft the response | Gemini Flash. Citations are validated against stored evidence |
| Triage order | Deterministic, by deadline |

Without a key, or once the $5/day hard cap is reached, a **rule-based generator** takes over. It is labelled as such in the UI and doubles as the evaluation baseline.

**Evaluation** (`npm run eval`, results in [`docs/eval-results.md`](docs/eval-results.md)):

The held-out set is the honest comparison. The rule-based extractor was written
while looking at the 12 development cases, so its 100% there is an upper bound,
not a generalisation estimate. The 6 held-out cases were written afterwards, in
carrier phrasings it was never tuned on.

| Held-out set (6 cases) | Rule-based baseline | Gemini |
|---|---|---|
| Extraction field accuracy | 66.7% | **93.3 – 100%** |
| Completeness band, exact | 33.3% | **83.3 – 100%** |
| Band within ±1 (PRD target ≥ 80%) | 66.7% | **100%** |
| Requirement-level agreement | 69.4% | **97.2 – 100%** |
| Cited ids exist | 100% | **100%** |
| Prompt-injection case | resisted | **resisted** |

Ranges span three runs of `npm run eval -- --with-llm` on 2026-11-11 (about 54
model calls each, roughly $0.20). The model is nondeterministic, so a re-run will
land somewhere in these ranges rather than on one figure; the baseline is
deterministic and returns the same numbers every time. All three model runs were
served by `gemini-3.1-flash-lite`, because the newer Flash tiers were returning
503 "high demand" on the free tier and the client fell back — the report names
whichever model actually served, not the one that was configured.

Every suite in the report states how many of its cases the model generated. On
the development set one run degraded to **9/12** under that same contention, so
its model column mixes model and rule-based results and is not quoted here. The
held-out suites were **6/6** model-generated in all three runs.

**Not claimed:** that the model wins on the development set (the baseline is
tuned on it), or that draft *quality* is better — that needs the human grading in
[`docs/eval-drafts.md`](docs/eval-drafts.md), which has not been done.

## Configuration

Every variable is optional. Copy `.env.example` to `.env`.

| Variable | Enables | If absent |
|---|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal **sandbox** mode | Demo mode (fixtures) |
| `PAYPAL_WEBHOOK_ID` | Webhook signature verification | Polling only |
| `GEMINI_API_KEY`, `LLM_MODEL` (default `gemini-3.8-flash`) | Model extraction, planning and drafting | Rule-based generator |
| `ANTHROPIC_API_KEY` | Claude instead of Gemini (`LLM_PROVIDER=anthropic`) | Gemini, or the rule-based generator |
| `LLM_DAILY_CAP_USD` (default 5) | Hard spend stop | — |
| `DATABASE_URL` | External Postgres | Embedded PGlite in `.data/` |
| `ELASTIC_URL` / `ELASTIC_CLOUD_ID`, `ELASTIC_API_KEY` | Elastic retrieval and ES\|QL | Postgres full-text search |
| `KERNEL_API_KEY` | Live carrier-page capture | PayPal tracking data or merchant upload |
| `DEMO_PASSWORD` | Shared login for a public deployment | No login |

Demo state resets on every restart; set `DEMO_RESET_ON_BOOT=false` to keep it.

## Testing

| Command | What it checks | Last result |
|---|---|---|
| `npm test` | 87 unit, integration, LLM-wire (Gemini + Claude) and crash-recovery tests (Vitest, in-memory Postgres) | 87/87 |
| `npm run test:e2e` | Playwright: J1 approve flow, J3 link-gating, injection, banner | 4/4; J1 20/20 with `--repeat-each=20` |
| `npm run postman` | Newman against the running demo server | 12 requests, 27 assertions, 0 failures |
| `npm run eval` | AI eval, rule-based baseline | see above |
| `npm run typecheck` | Server and web TypeScript | clean |

Both model paths are checked without spending money: a mock `fetch` is injected into the provider client, and the tests assert on the exact request (structured-output format, no sampling parameters, API key in a header and never in the URL or body, untrusted text wrapped and injection phrases neutralised).

## Deploying

- **Render:** `render.yaml` defines the web service, Postgres and a 10-minute reconciliation cron. Secrets go in the dashboard.
- **Docker:** `docker compose up` runs the app against a real Postgres in demo mode.

## Honest limitations

- **The sandbox integration is implemented but not yet verified against a real sandbox dispute.** The API contract was checked against PayPal's `schema.json`; the live steps are in [`docs/spike-G0.md`](docs/spike-G0.md).
- **Unverified integrations:** Elastic, KERNEL, the Render deployment and external Postgres are written against their SDKs and typecheck, but have not run against the real services. Each has a working, tested fallback. **Not implemented:** Zapier order records, Render Workflows (an in-process durable step runner is used instead), and hybrid/semantic search. Full ledger in [`docs/STATUS.md`](docs/STATUS.md).
- **Only *Item not received* is supported.** Other dispute reasons are routed to manual handling; nothing is guessed.
- **No merchant research yet.** The pain point comes from PayPal's documented dispute process. No merchant interviews have been done.
- **Not legal advice.** DisputeDesk does not predict or guarantee outcomes.

## Repository map

```
shared/src/      PayPal constants (from schema.json), rubric, urgency, canonical hashing, zod schemas
server/src/      Fastify API, approval gate, PayPal gateways (live + demo), workflow, LLM, retrieval, capture
server/test/     Vitest suites
web/src/         React UI (AG Grid queue, dispute detail, approval modal)
e2e/             Playwright journeys
postman/         Collection generator + environments
docs/            G0 spike, build status, eval results
```
