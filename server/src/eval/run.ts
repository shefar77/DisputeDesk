/**
 * AI evaluation (PRD §7 success criteria, §13 "Audit C", §21 "AI eval").
 *
 *   npm run eval                 — rule-based baseline only (free, no key)
 *   npm run eval -- --with-llm   — baseline AND the configured model
 *                                  (needs GEMINI_API_KEY; spends real money,
 *                                  about 54 model calls: 18 cases x 3 tasks)
 *
 * Runs the real `gatherEvidence` workflow over the 12 hand-labelled INR
 * scenarios in an in-memory database, then compares what was stored with the
 * labels in fixtures/scenarios.ts. Measured:
 *   (a) extraction field accuracy — 5 fields x 12 cases
 *   (b) completeness band agreement — exact, and within ±1 band (PRD target ≥80%)
 *   (c) requirement-level agreement — 6 requirements x 12 cases
 *   (d) injection resistance — the injection case must not recommend accept-claim
 *   (e) citation integrity — every cited id exists (PRD target 100%)
 *
 * Draft *quality* is not scored here: PRD §13 specifies a human 3-point rubric.
 * The drafts are written to docs/eval-drafts.md for the team to grade, and any
 * grade reported must be disclosed as self-graded.
 *
 * Labels were written from the rubric definition before pipeline output existed.
 * They are not adjusted to make results look better; disagreements are reported.
 */

process.env.PGLITE_DIR = 'memory://';
process.env.DEMO_MODE = 'true';
process.env.POLL_ENABLED = 'false';
process.env.DEMO_INCLUDE_HELDOUT = 'true';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

export {};

const withLlm = process.argv.includes('--with-llm');
if (!withLlm) {
  // Blank every provider key so the baseline run cannot accidentally spend.
  process.env.GEMINI_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
}

const { writeFileSync, mkdirSync } = await import('node:fs');
const { resolve } = await import('node:path');
const { bandIndex } = await import('@shared/index.js');
type Band = Parameters<typeof bandIndex>[0];
const { boot, resetDemoData } = await import('../boot.js');
const { closeDb } = await import('../db/client.js');
const { env, repoRoot } = await import('../env.js');
const { getDemoGateway } = await import('../paypal/index.js');
const { setLlm, initLlm, getDeterministic } = await import('../llm/index.js');
const { upsertDisputeFromRaw, getDisputeDetail } = await import('../services/disputes.js');
const { gatherEvidence } = await import('../workflow/gatherEvidence.js');
const { evalScenarios, heldOutScenarios } = await import('../fixtures/scenarios.js');
type Scn = ReturnType<typeof evalScenarios>[number];

const FACT_FIELDS = ['trackingNumber', 'carrierEnum', 'deliveryStatus', 'signatureObtained', 'addressMatch'] as const;

interface CaseResult {
  key: string;
  expectedBand: string;
  band: string | null;
  score: number | null;
  bandExact: boolean;
  bandWithin1: boolean;
  factsCorrect: number;
  factMisses: string[];
  reqCorrect: number;
  reqMisses: string[];
  recommended: string | null;
  injectionOk: boolean | null;
  citationsOk: boolean;
  draft: string | null;
  generator: string | null;
}

async function runSuite(
  label: string,
  scenarios: Scn[],
): Promise<{ label: string; model: string; cases: CaseResult[]; llmCases: number }> {
  await resetDemoData();
  const demo = getDemoGateway()!;
  const cases: CaseResult[] = [];
  // Every model that actually served a case. The client falls back to another
  // model when the preferred one is unavailable, so the configured name is not
  // evidence of what produced these numbers.
  const servedBy = new Set<string>();
  let llmCases = 0;

  for (const s of scenarios) {
    const raw = await demo.getDispute(s.dispute.dispute_id);
    await upsertDisputeFromRaw(raw, { fixture: true });
    await gatherEvidence(s.dispute.dispute_id, 'eval');
    const d = (await getDisputeDetail(s.dispute.dispute_id))!;
    const exp = s.expected!;
    const plan = d.plan;
    if (plan?.generator === 'llm') {
      servedBy.add(plan.model);
      llmCases++;
    }

    const factMisses: string[] = [];
    for (const f of FACT_FIELDS) {
      const got = plan ? (plan.facts as Record<string, unknown>)[f] : undefined;
      const want = (exp.facts as Record<string, unknown>)[f];
      if (got !== want) factMisses.push(`${f}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }

    const reqMisses: string[] = [];
    for (const [id, want] of Object.entries(exp.requirements)) {
      const got = plan?.requirements.find((r) => r.id === id)?.satisfied;
      if (got !== want) reqMisses.push(`${id}: expected ${want}, got ${got}`);
    }

    const band = plan?.band ?? null;
    const delta = band ? Math.abs(bandIndex(band as Band) - bandIndex(exp.band)) : 99;
    const ids = new Set(d.evidence.map((e) => e.id));
    const cited = [
      ...(d.draft?.evidenceRefs ?? []),
      ...(plan?.narrative.rationale.flatMap((r) => r.evidence_ids) ?? []),
    ].filter((x) => x !== 'none');

    cases.push({
      key: s.key,
      expectedBand: exp.band,
      band,
      score: plan?.completeness ?? null,
      bandExact: delta === 0,
      bandWithin1: delta <= 1,
      factsCorrect: FACT_FIELDS.length - factMisses.length,
      factMisses,
      reqCorrect: Object.keys(exp.requirements).length - reqMisses.length,
      reqMisses,
      recommended: plan?.narrative.recommended_action ?? null,
      injectionOk: exp.mustNotRecommend ? !exp.mustNotRecommend.includes(plan?.narrative.recommended_action as never) : null,
      citationsOk: cited.every((c) => ids.has(c)),
      draft: d.draft ? (d.draft.editedText ?? d.draft.text) : null,
      generator: d.draft?.generator ?? plan?.generator ?? null,
    });
  }
  const model = servedBy.size === 0 ? 'rules-v1' : [...servedBy].sort().join(' + ');
  return { label, model, cases, llmCases };
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`;
}

function summarise(cases: CaseResult[]) {
  const n = cases.length;
  const facts = cases.reduce((s, c) => s + c.factsCorrect, 0);
  const reqs = cases.reduce((s, c) => s + c.reqCorrect, 0);
  const inj = cases.filter((c) => c.injectionOk !== null);
  return {
    cases: n,
    factAccuracy: pct(facts, n * FACT_FIELDS.length),
    bandExact: pct(cases.filter((c) => c.bandExact).length, n),
    bandWithin1: pct(cases.filter((c) => c.bandWithin1).length, n),
    requirementAgreement: pct(reqs, n * 6),
    injection: inj.length ? `${inj.filter((c) => c.injectionOk).length}/${inj.length} resisted` : 'n/a',
    citationIntegrity: pct(cases.filter((c) => c.citationsOk).length, n),
    drafted: `${cases.filter((c) => c.draft).length}/${n}`,
  };
}

// ---------------------------------------------------------------------------

await boot();
const suites: Awaited<ReturnType<typeof runSuite>>[] = [];

const sets: [string, Scn[]][] = [
  ['development set, 12', evalScenarios()],
  ['held-out set, 6', heldOutScenarios()],
];

setLlm(getDeterministic());
for (const [name, list] of sets) suites.push(await runSuite(`Baseline — ${name}`, list));

if (withLlm) {
  if (!env.llm.apiKey) {
    console.error('--with-llm requires GEMINI_API_KEY (or ANTHROPIC_API_KEY). Skipping the model run.');
  } else {
    setLlm(null);
    initLlm();
    for (const [name, list] of sets) {
      const suite = await runSuite(`Model — ${name}`, list);
      // Headed with what ran, not what was asked for.
      suite.label = `Model ${suite.model} — ${name}`;
      suites.push(suite);
    }
  }
}
await closeDb();

const ranAt = new Date().toISOString();
const lines: string[] = [];
lines.push('# DisputeDesk — AI evaluation results', '');
lines.push(`Generated by \`npm run eval${withLlm ? ' -- --with-llm' : ''}\` on ${ranAt}.`, '');
lines.push(
  'Hand-labelled *Item not received* fixtures (`server/src/fixtures/scenarios.ts`), run through the real evidence workflow. ' +
    'Labels were authored from the rubric definition, not from pipeline output. Fixture data only — no real merchants or disputes.',
  '',
  '- **Development set (12):** the rule-based extractor was written while looking at these cases, so its score here is an upper bound, not a generalisation estimate.',
  '- **Held-out set (6):** written after the rule-based extractor was frozen, in carrier phrasings it was not tuned on. This is the fair comparison between the baseline and a model.',
  '',
);
lines.push('| Metric | PRD target | ' + suites.map((s) => s.label).join(' | ') + ' |');
lines.push('|---|---|' + suites.map(() => '---|').join(''));
const sums = suites.map((s) => summarise(s.cases));
const row = (name: string, target: string, key: keyof ReturnType<typeof summarise>) =>
  lines.push(`| ${name} | ${target} | ${sums.map((x) => x[key]).join(' | ')} |`);
row('Extraction field accuracy (5 fields per case)', '—', 'factAccuracy');
row('Completeness band, exact', '—', 'bandExact');
row('Completeness band, within ±1', '≥ 80%', 'bandWithin1');
row('Requirement-level agreement (6 per case)', '—', 'requirementAgreement');
row('Prompt-injection case', 'resist', 'injection');
row('Cited evidence ids exist', '100%', 'citationIntegrity');
row('Cases drafted (others held for manual review)', '—', 'drafted');
lines.push('');
if (!suites.some((x) => x.label.startsWith('Model'))) {
  lines.push(
    '**Model columns are absent because this run did not call a model.** Run `npm run eval -- --with-llm` with ' +
      '`GEMINI_API_KEY` set to measure it. Until then, no claim is made that the model beats the baseline.',
    '',
  );
}

for (const s of suites) {
  lines.push(`## ${s.label}`, '', `Model: \`${s.model}\``);
  // The baseline suites are rule-based on purpose, so only a *model* suite that
  // silently degraded needs calling out — that is the case where a number could
  // be mistaken for a model result.
  if (s.model !== 'rules-v1') {
    lines.push(
      '',
      `Cases generated by the model: **${s.llmCases}/${s.cases.length}**` +
        (s.llmCases === s.cases.length
          ? '.'
          : ' — the rest fell back to the rule-based generator and are NOT model results.'),
      '',
    );
  } else {
    lines.push('', 'Rule-based generator; no model calls.', '');
  }
  lines.push('| Case | Expected band | Got | Score | Facts | Reqs | Recommended | Notes |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const c of s.cases) {
    const notes = [...c.factMisses, ...c.reqMisses].join('; ') || '—';
    lines.push(
      `| ${c.key} | ${c.expectedBand} | ${c.band ?? '—'}${c.bandExact ? '' : c.bandWithin1 ? ' (±1)' : ' ✗'} | ${c.score ?? '—'} | ${c.factsCorrect}/5 | ${c.reqCorrect}/6 | ${c.recommended ?? '—'} | ${notes} |`,
    );
  }
  lines.push('');
}

const docs = resolve(repoRoot, 'docs');
mkdirSync(docs, { recursive: true });
writeFileSync(resolve(docs, 'eval-results.md'), lines.join('\n'));
writeFileSync(resolve(docs, 'eval-results.json'), JSON.stringify({ ranAt, suites: suites.map((s) => ({ ...s, summary: summarise(s.cases) })) }, null, 2));

const drafts: string[] = ['# Drafts for human grading', '', 'Grade each 0 (unusable) / 1 (needs edits) / 2 (send as-is). Report results as self-graded.', ''];
for (const s of suites) {
  drafts.push(`## ${s.label}`, '');
  for (const c of s.cases) drafts.push(`### ${c.key} (${c.band ?? 'unscored'})`, '', c.draft ? `> ${c.draft.replace(/\n/g, '\n> ')}` : '_No draft — held for manual review._', '', 'Grade: ___', '');
}
writeFileSync(resolve(docs, 'eval-drafts.md'), drafts.join('\n'));

console.log(lines.slice(0, 22).join('\n'));
console.log('\nWrote docs/eval-results.md, docs/eval-results.json, docs/eval-drafts.md');
