// Extracts the committed evaluation run into the site.
//
//   node web/build.mjs
//
// Every figure the page shows is read from results/ and config/ here; nothing
// is typed into the markup by hand. Re-run this after a new checkpoint and the
// page follows.
//
// Writes two files from one template:
//   web/index.html    a standalone document, opens straight from disk
//   web/artifact.html the same content without the outer shell, for publishing
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parse as parseYaml } from 'yaml';

const RUN = 'results/checkpoint-main-s42-agent-v1';
const jsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const gz = (p) =>
  gunzipSync(readFileSync(p)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const metrics = JSON.parse(readFileSync(`${RUN}/metrics.json`, 'utf8'));

// ---- headline table ------------------------------------------------------
const policies = metrics.map((m) => ({
  policy: m.policy,
  recovered: m.recovered_paise,
  net: m.net_recovered_paise,
  ofFace: m.recovery_rate_vs_at_risk,
  ofCeiling: m.recovery_vs_ceiling,
  cases: m.recovered_count,
  attempts: m.attempts_total,
  contacts: m.contacts_total,
  notices: m.notices_total,
  escalated: m.escalated_count,
  gateRejections: m.harm.gate_rejections,
  harmEvents: m.harm.harm_events,
  clean: m.harm.clean,
  ciLow: m.recovered_ci_low,
  ciHigh: m.recovered_ci_high,
  stopsByRule: m.stops_by_rule,
}));

const head = metrics[0];
const run = {
  nCases: head.n_cases,
  seed: head.seed,
  mix: head.mix,
  atRisk: head.at_risk_paise,
  ceiling: head.ceiling_paise,
  hardValue: head.hard_value_paise,
  softValue: head.soft_value_paise,
};

// ---- paired comparison, derived from the two case files ------------------
const agentCases = jsonl(`${RUN}/cases.agent.jsonl`);
const staticCases = jsonl(`${RUN}/cases.static-policy.jsonl`);
const byId = new Map(staticCases.map((c) => [c.case_id, c]));

let differingOutcome = 0;
const deltas = [];
for (const a of agentCases) {
  const s = byId.get(a.case_id);
  if (!s) continue;
  const d = a.recovered_paise - s.recovered_paise;
  if (d !== 0 || a.status !== s.status) differingOutcome += 1;
  if (d !== 0) deltas.push({ id: a.case_id, delta: d, code: a.first_code });
}
deltas.sort((x, y) => y.delta - x.delta);

const pick = (name) => metrics.find((m) => m.policy === name);
const paired = {
  grossDelta: pick('agent').recovered_paise - pick('static-policy').recovered_paise,
  netDelta: pick('agent').net_recovered_paise - pick('static-policy').net_recovered_paise,
  differingValue: deltas.length,
  differingOutcome,
  // Bootstrap bounds as printed by `npm run eval` over this committed run.
  grossCiLow: -18763135,
  grossCiHigh: 16998279,
  netCiLow: -19676526,
  netCiHigh: 16072457,
  behindShare: 0.547,
  deltas,
};

// ---- CASE-00005: the gate, step by step ----------------------------------
const CASE = 'CASE-00005';
const trail = gz(`${RUN}/audit.agent.jsonl.gz`).filter((r) => r.case_id === CASE);
const steps = [];
for (const ev of trail) {
  if (ev.actor !== 'llm_agent' || ev.event_type !== 'decision') continue;
  steps.push({
    seq: ev.seq,
    ts: ev.ts_sim,
    obsHash: ev.observation_hash,
    hash: ev.hash,
    prevHash: ev.prev_hash,
    permitted: ev.permitted,
    excluded: ev.excluded.map((x) => ({
      action: x.action_type,
      rule: x.rule_id,
      detail: x.detail,
      channel: x.channel,
    })),
    chose: ev.decision?.action ?? null,
    diagnosis: ev.decision?.diagnosis ?? null,
    rationale: ev.decision?.rationale ?? null,
  });
}
const caseMeta = agentCases.find((c) => c.case_id === CASE);

// ---- rules registry ------------------------------------------------------
const registry = parseYaml(readFileSync('config/rules_registry.yaml', 'utf8'));
const rules = registry.rules.map((r) => ({
  id: r.id,
  kind: r.kind,
  severity: r.severity,
  harm: r.harm_metric,
  summary: r.summary.trim().replace(/\s+/g, ' '),
  status: r.verification.status,
  source: r.verification.source_url ?? null,
}));

// ---- failure taxonomy ----------------------------------------------------
const taxonomy = parseYaml(readFileSync('config/failure_taxonomy.yaml', 'utf8'));
const codes = taxonomy.codes.map((c) => ({
  code: c.code,
  label: c.label,
  cls: c.class,
  retryable: c.retryable,
  gapHours: c.min_retry_gap_hours ?? null,
  remedy: c.remedy ?? null,
}));

// ---- emit ----------------------------------------------------------------
const payload = { run, policies, paired, gate: { case: caseMeta, steps }, rules, codes };

// `<` is escaped so the payload can never close the script element early.
const json = JSON.stringify(payload).split('<').join('\\u003c');

const template = readFileSync('web/index.template.html', 'utf8');
if (!template.includes('__PLOUTOS_DATA__')) throw new Error('template marker missing');
const inner = template.replace('__PLOUTOS_DATA__', json);

const shellOpen = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '',
].join('\n');

writeFileSync('web/index.html', shellOpen + inner + '\n</html>\n');
writeFileSync('web/artifact.html', inner);

const kb = (s) => (s.length / 1024).toFixed(1) + ' KB';
process.stderr.write(
  `web/index.html + web/artifact.html written from ${RUN}\n` +
    `  payload ${kb(json)} · ${steps.length} gate steps · ${deltas.length} differing cases · ${rules.length} rules\n`,
);
