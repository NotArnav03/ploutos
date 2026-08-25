import { paise, type Paise } from '../domain/money.js';
import type { Action } from '../domain/actions.js';
import { CONTACTING_ACTIONS, DEBITING_ACTIONS, LADDER_RUNG } from '../domain/actions.js';
import type { AuditEvent } from '../domain/audit.js';
import { CostModel } from '../domain/costs.js';
import { isTruthAware, type AnyPolicy, type PolicyDecision } from '../domain/policy.js';
import type { RuleRegistry } from '../domain/rules.js';
import type { Attempt, Contact } from '../domain/schemas.js';
import type { TaxonomyIndex } from '../domain/taxonomy.js';
import { addDays, addHours, isBefore, toTimestamp, type Timestamp } from '../domain/time.js';
import { observationHash, observe } from '../adapter/observe.js';
import { IssuerHealthTracker } from '../adapter/issuer_health.js';
import { computePermitted } from '../policy/gate.js';
import { Ledger } from '../ledger/ledger.js';
import { isClosed, newRuntime, type CaseRuntime } from '../orchestrator/runtime.js';
import type { LatentState } from '../world/latent.js';
import { Rng, STREAM } from '../world/rng.js';
import { applyEngagement, deliver, present } from '../world/simulator.js';
import type { World, WorldCase } from '../world/types.js';
import { z } from 'zod';

const IST = 'Asia/Kolkata';
/** Safety valve: a case that will not settle should not spin forever. */
const MAX_STEPS_PER_CASE = 60;

export interface CaseResult {
  case_id: string;
  status: CaseRuntime['status'];
  at_risk_paise: Paise;
  recovered_paise: Paise;
  cost_paise: Paise;
  attempts: number;
  contacts: number;
  /** Mandatory compliance notices, tracked apart from collections contacts. */
  notices: number;
  double_charge_attempts: number;
  violations: number;
  fallbacks: number;
  stopped_reason: string | null;
  recovered_at: Timestamp | null;
  days_to_recovery: number | null;
  /** Observable-only classification of the day-0 failure. */
  first_code: string;
  first_code_hard: boolean;
  adversarial: string | null;
  settled_out_of_band: boolean;
}

export interface RunResult {
  run_id: string;
  policy: string;
  seed: number;
  mix: string;
  cases: CaseResult[];
  ledger_path: string;
  ledger_events: number;
  wall_ms: number;
}

export interface RunOptions {
  world: World;
  policy: AnyPolicy<LatentState>;
  registry: RuleRegistry;
  taxonomy: TaxonomyIndex;
  costs: CostModel;
  run_id: string;
  ledger_path: string;
  seed: number;
}

/**
 * The recovery loop.
 *
 * Discrete-event: every case carries a next-wake time, the earliest is
 * processed, and the policy decides what to do with it. Sim time only ever
 * moves forward, and the policy is handed a clock rather than reading one, so a
 * run is reproducible from its seed.
 *
 * Every policy - the baselines, the tuned rules, the agent, the oracle - goes
 * through this same function, the same gate and the same ledger. That is what
 * makes the comparison between them a comparison of judgement rather than of
 * who was allowed to cut which corner.
 */
export async function runBatch(opts: RunOptions): Promise<RunResult> {
  const { world, policy, registry, taxonomy, costs } = opts;
  const started = Date.now();
  const ledger = new Ledger(opts.ledger_path, opts.run_id);

  const afaThreshold = paise(
    registry.param('AFA_THRESHOLD', 'threshold_paise', z.number().int().nonnegative()),
  );
  const noticeHours = registry.param('PREDEBIT_NOTICE', 'notice_hours', z.number().nonnegative());
  const horizonEnd = addDays(world.meta.start_ts, world.meta.horizon_days);

  const issuerByName = new Map(world.issuers.map((i) => [i.issuer, i]));
  const health = new IssuerHealthTracker();

  // Seed the health tracker with the failures that put these invoices in the
  // queue. A merchant already has this history when recovery starts.
  for (const c of world.cases) {
    const a = c.invoice.attempts[0];
    if (a) health.record(c.latent.issuer, a.ts, !a.succeeded);
  }

  const runtimes = new Map<string, CaseRuntime>();
  const caseById = new Map<string, WorldCase>();
  const steps = new Map<string, number>();

  for (const c of world.cases) {
    const first = c.invoice.attempts[0];
    if (!first) throw new Error(`${c.case_id} has no day-0 attempt`);
    runtimes.set(c.case_id, newRuntime(c.case_id, first, addHours(first.ts, 1)));
    caseById.set(c.case_id, c);
    steps.set(c.case_id, 0);
  }

  // Simple ordered scan rather than a heap: batches are hundreds of cases, and
  // a predictable traversal order keeps runs byte-reproducible.
  let progressed = true;
  while (progressed) {
    progressed = false;

    const pending = [...runtimes.values()]
      .filter((rt) => !isClosed(rt) && isBefore(rt.next_wake, horizonEnd))
      .sort((a, b) => (a.next_wake < b.next_wake ? -1 : a.next_wake > b.next_wake ? 1 : a.case_id < b.case_id ? -1 : 1));

    for (const rt of pending) {
      const used = steps.get(rt.case_id) ?? 0;
      if (used >= MAX_STEPS_PER_CASE) {
        closeCase(rt, 'STOP_ON_INVOICE_AGE', 'step budget exhausted');
        continue;
      }
      steps.set(rt.case_id, used + 1);
      progressed = true;

      const wc = caseById.get(rt.case_id);
      if (!wc) continue;
      const now = rt.next_wake;

      // ---- world events the merchant can now observe
      applyWorldEvents(wc, rt, now);

      const issuerHealth = health.health(wc.latent.issuer, now);
      const obs = observe({
        source: wc,
        runtime: rt,
        now,
        issuer: wc.latent.issuer,
        issuer_health: issuerHealth,
      });
      const obsHash = observationHash(obs);

      // ---- the gate
      const gate = computePermitted({ observation: obs, runtime: rt, registry, taxonomy, now });

      ledger.append(rt, {
        run_id: opts.run_id,
        case_id: rt.case_id,
        ts_sim: now,
        ts_wall: toTimestamp(Date.now()),
        actor: 'policy_engine',
        event_type: 'eligibility',
        observation_hash: obsHash,
        permitted: gate.permitted,
        excluded: gate.excluded,
        policy_checks: gate.checks,
        decision: null,
        outcome: null,
        violation: null,
        stop_reason: gate.stop?.rule_id ?? null,
        money_delta_paise: 0 as AuditEvent['money_delta_paise'],
        cost_paise: paise(0),
      });

      if (gate.stop !== null) {
        closeCase(rt, gate.stop.rule_id, gate.stop.detail);
        ledger.append(rt, {
          run_id: opts.run_id,
          case_id: rt.case_id,
          ts_sim: now,
          ts_wall: toTimestamp(Date.now()),
          actor: 'orchestrator',
          event_type: 'stop',
          observation_hash: obsHash,
          permitted: null,
          excluded: null,
          policy_checks: null,
          decision: null,
          outcome: null,
          violation: null,
          stop_reason: gate.stop.rule_id,
          money_delta_paise: 0 as AuditEvent['money_delta_paise'],
          cost_paise: paise(0),
        });
        continue;
      }

      // ---- the decision
      const permittedSet = {
        case_id: rt.case_id,
        observation_hash: obsHash,
        permitted: gate.permitted,
        excluded: gate.excluded,
      };
      const policyInput = {
        observation: obs,
        permitted: permittedSet,
        ctx: { registry, taxonomy, now, run_id: opts.run_id },
      };

      let decision: PolicyDecision = isTruthAware(policy)
        ? await policy.decide(policyInput, wc.latent)
        : await policy.decide(policyInput);

      // ---- enforcement: a choice outside the permitted set is never executed
      let fellBack = false;
      if (!gate.permitted.includes(decision.action.type)) {
        rt.violations++;
        rt.fallbacks++;
        fellBack = true;

        ledger.append(rt, {
          run_id: opts.run_id,
          case_id: rt.case_id,
          ts_sim: now,
          ts_wall: toTimestamp(Date.now()),
          actor: 'policy_engine',
          event_type: 'violation',
          observation_hash: obsHash,
          permitted: gate.permitted,
          excluded: gate.excluded,
          policy_checks: null,
          decision: null,
          outcome: null,
          violation: {
            rule_id:
              gate.excluded.find((e) => e.action_type === decision.action.type)?.rule_id ??
              'UNPERMITTED_ACTION',
            severity: 'high',
            harm: false,
            attempted_action: decision.action.type,
            detail: `${policy.name} chose ${decision.action.type}, which the gate did not permit`,
          },
          stop_reason: null,
          money_delta_paise: 0 as AuditEvent['money_delta_paise'],
          cost_paise: paise(0),
        });

        decision = {
          action: { type: 'wait', until: addHours(now, 12) },
          diagnosis: decision.diagnosis,
          rationale: `fallback: ${decision.action.type} was not permitted`,
          confidence: decision.confidence,
          meta: decision.meta,
        };
      }

      ledger.append(rt, {
        run_id: opts.run_id,
        case_id: rt.case_id,
        ts_sim: now,
        ts_wall: toTimestamp(Date.now()),
        actor: policy.usesLatentState ? 'simulator' : 'llm_agent',
        event_type: 'decision',
        observation_hash: obsHash,
        permitted: gate.permitted,
        excluded: gate.excluded,
        policy_checks: null,
        decision: {
          action: decision.action,
          diagnosis: decision.diagnosis,
          rationale: decision.rationale,
          confidence: decision.confidence,
          policy: policy.name,
          model: decision.meta.model,
          prompt_version: decision.meta.prompt_version,
          tokens_in: decision.meta.tokens_in,
          tokens_out: decision.meta.tokens_out,
          latency_ms: decision.meta.latency_ms,
          cache_hit: decision.meta.cache_hit,
          fell_back: fellBack,
        },
        outcome: null,
        violation: null,
        stop_reason: null,
        money_delta_paise: 0 as AuditEvent['money_delta_paise'],
        cost_paise: paise(0),
      });

      // ---- execution
      execute({
        action: decision.action,
        wc,
        rt,
        now,
        ledger,
        run_id: opts.run_id,
        obsHash,
        costs,
        taxonomy,
        health,
        issuer: issuerByName.get(wc.latent.issuer)!,
        world,
        afaThreshold,
        noticeHours,
        seed: opts.seed,
      });

      // A policy that neither acted nor scheduled anything would spin.
      if (!isClosed(rt) && rt.next_wake <= now) rt.next_wake = addHours(now, 12);
    }
  }

  // Anything still open at the horizon is simply unrecovered.
  for (const rt of runtimes.values()) {
    if (!isClosed(rt)) closeCase(rt, 'STOP_ON_INVOICE_AGE', 'horizon reached with invoice unpaid');
  }

  await ledger.close();

  const cases: CaseResult[] = [...runtimes.values()].map((rt) => {
    const wc = caseById.get(rt.case_id)!;
    const firstCode = wc.invoice.attempts[0]?.code ?? '';
    const recoveredAt =
      rt.status === 'recovered'
        ? (rt.attempts.find((a) => a.succeeded)?.ts ?? null)
        : null;
    return {
      case_id: rt.case_id,
      status: rt.status,
      at_risk_paise: wc.invoice.amount_paise,
      recovered_paise: rt.settled_out_of_band ? paise(0) : rt.settled_paise,
      cost_paise: rt.cost_paise,
      attempts: rt.attempts.length,
      contacts: rt.contacts.filter((c) => !c.compliance).length,
      notices: rt.contacts.filter((c) => c.compliance).length,
      double_charge_attempts: rt.double_charge_attempts,
      violations: rt.violations,
      fallbacks: rt.fallbacks,
      stopped_reason: rt.stopped_reason,
      recovered_at: recoveredAt,
      days_to_recovery:
        recoveredAt === null
          ? null
          : (Date.parse(recoveredAt) - Date.parse(wc.invoice.due_date)) / 86_400_000,
      first_code: firstCode,
      first_code_hard: firstCode !== '' && taxonomy.isHard(firstCode),
      adversarial: wc.adversarial,
      settled_out_of_band: rt.settled_out_of_band,
    };
  });

  return {
    run_id: opts.run_id,
    policy: policy.name,
    seed: opts.seed,
    mix: world.meta.mix,
    cases,
    ledger_path: opts.ledger_path,
    ledger_events: ledger.written,
    wall_ms: Date.now() - started,
  };
}

function closeCase(rt: CaseRuntime, ruleId: string, detail: string): void {
  if (isClosed(rt)) return;
  rt.status = rt.settled_paise > 0 && !rt.settled_out_of_band ? 'recovered' : 'stopped';
  rt.stopped_reason = `${ruleId}: ${detail}`;
}

/**
 * Surface world events the merchant would have learned about by now.
 *
 * Out-of-band settlement is the important one: the payer paid by other means
 * and the merchant's own reconciliation shows the invoice cleared. From that
 * instant, any further presentment is a double charge.
 */
function applyWorldEvents(wc: WorldCase, rt: CaseRuntime, now: Timestamp): void {
  const l = wc.latent;
  if (l.out_of_band_payment_at !== null && now >= l.out_of_band_payment_at && !rt.settled_out_of_band) {
    rt.settled_out_of_band = true;
    rt.settled_paise = wc.invoice.amount_paise;
  }
  if (l.cancellation_request_at !== null && now >= l.cancellation_request_at) {
    rt.cancellation_seen_at ??= l.cancellation_request_at;
  }
  if (l.dispute_raised_at !== null && now >= l.dispute_raised_at) {
    rt.dispute_seen_at ??= l.dispute_raised_at;
  }
}

interface ExecArgs {
  action: Action;
  wc: WorldCase;
  rt: CaseRuntime;
  now: Timestamp;
  ledger: Ledger;
  run_id: string;
  obsHash: string;
  costs: CostModel;
  taxonomy: TaxonomyIndex;
  health: IssuerHealthTracker;
  issuer: World['issuers'][number];
  world: World;
  afaThreshold: Paise;
  noticeHours: number;
  seed: number;
}

function execute(a: ExecArgs): void {
  const { action, wc, rt, now, ledger, costs } = a;
  const rung = LADDER_RUNG[action.type];
  if (rung !== null) rt.ladder_rung = Math.max(rt.ladder_rung, rung);

  const emit = (
    type: 'action' | 'outcome',
    money: number,
    cost: Paise,
    outcome: AuditEvent['outcome'],
  ): void => {
    ledger.append(rt, {
      run_id: a.run_id,
      case_id: rt.case_id,
      ts_sim: now,
      ts_wall: toTimestamp(Date.now()),
      actor: 'simulator',
      event_type: type,
      observation_hash: a.obsHash,
      permitted: null,
      excluded: null,
      policy_checks: null,
      decision: null,
      outcome,
      violation: null,
      stop_reason: null,
      money_delta_paise: money as AuditEvent['money_delta_paise'],
      cost_paise: cost,
    });
  };

  switch (action.type) {
    case 'wait': {
      rt.next_wake = action.until;
      return;
    }

    case 'stop_terminal': {
      closeCase(rt, action.rule_id, `terminal: ${action.disposition}`);
      emit('action', 0, paise(0), null);
      return;
    }

    case 'handoff_human': {
      rt.status = 'escalated';
      rt.stopped_reason = `HANDOFF: ${action.reason}`;
      const cost = costs.handoffCost();
      rt.cost_paise = paise(rt.cost_paise + cost);
      emit('action', 0, cost, null);
      return;
    }

    case 'serve_predebit_notice': {
      rt.predebit_notice_served_at = now;
      recordContact(a, action.channel, 'predebit_notice', false, true);
      // Notice is a precondition, not a nudge: it must be served far enough
      // ahead, so the next wake is the moment it becomes usable.
      rt.next_wake = addHours(now, a.noticeHours + 1);
      return;
    }

    case 'request_afa': {
      const acted = recordContact(a, action.channel, 'afa_request', true);
      if (acted) rt.afa_satisfied = true;
      rt.next_wake = addHours(now, 12);
      return;
    }

    case 'notify_soft': {
      const acted = recordContact(a, action.channel, action.template_id, true);
      if (acted) applyEngagement(wc.latent, 'topped_up', now, IST);
      rt.next_wake = addHours(now, 18);
      return;
    }

    case 'request_instrument_update': {
      const acted = recordContact(a, action.channel, action.template_id, true);
      if (acted) applyEngagement(wc.latent, 'instrument_updated', now, IST);
      rt.next_wake = addHours(now, 24);
      return;
    }

    case 'send_payment_link': {
      const acted = recordContact(a, action.channel, action.template_id, true);
      if (acted) {
        rt.settled_paise = wc.invoice.amount_paise;
        rt.status = 'recovered';
        rt.stopped_reason = 'RECOVERED: payment link';
        emit('outcome', wc.invoice.amount_paise, paise(0), {
          status: 'success',
          code: null,
          settled_paise: wc.invoice.amount_paise,
        });
        return;
      }
      rt.next_wake = addHours(now, 24);
      return;
    }

    case 'capture_promise_to_pay': {
      const acted = recordContact(a, action.channel, 'promise_to_pay', true);
      rt.promises.push({
        id: `P2P-${rt.case_id}-${rt.promises.length + 1}`,
        invoice_id: wc.invoice.id,
        captured_at: now,
        promised_for: action.promised_for,
        status: acted ? 'open' : 'broken',
      });
      if (acted) applyEngagement(wc.latent, 'topped_up', action.promised_for, IST);
      rt.next_wake = action.promised_for;
      return;
    }

    case 'grant_grace': {
      rt.grace_grants++;
      rt.next_wake = action.new_due_date;
      emit('action', 0, paise(0), null);
      return;
    }

    case 'retry_debit':
    case 'switch_rail': {
      const rail = action.type === 'retry_debit' ? action.rail : action.to_rail;
      const seq = rt.attempts.length + 1;

      const result = present({
        latent: wc.latent,
        issuer: a.issuer,
        start_ts: a.world.meta.start_ts,
        at: now,
        rail,
        amount: wc.invoice.amount_paise,
        attempt_seq: seq,
        invoice_settled: rt.settled_paise > 0,
        mandate_afa_required: wc.subscription.mandate.afa_required,
        afa_threshold_paise: a.afaThreshold,
        afa_satisfied: rt.afa_satisfied,
        predebit_notice_served_at: rt.predebit_notice_served_at,
        predebit_notice_hours: a.noticeHours,
        timezone: IST,
        rng: Rng.stream(a.seed, rt.case_id, STREAM.outcome, seq),
      });

      const tax = result.code ? a.taxonomy.get(result.code) : null;
      const attempt: Attempt = {
        id: `ATT-${rt.case_id}-${seq}`,
        invoice_id: wc.invoice.id,
        seq,
        ts: now,
        rail,
        amount_paise: wc.invoice.amount_paise,
        code: result.code,
        class: tax?.class ?? null,
        remedy: tax?.remedy ?? null,
        succeeded: result.success,
        retry_allowed_after:
          tax && tax.retryable ? addHours(now, tax.min_retry_gap_hours) : null,
        description: tax?.label ?? 'settled',
      };
      rt.attempts.push(attempt);
      a.health.record(wc.latent.issuer, now, !result.success);

      const cost = costs.attemptCost(rail, result.success, result.settled_paise);
      rt.cost_paise = paise(rt.cost_paise + cost);

      if (result.double_charge) {
        // The gate should have stopped this. Recording it rather than
        // suppressing it is the point: harm has to be visible to be counted.
        rt.double_charge_attempts++;
        rt.violations++;
      }

      if (result.success && !result.double_charge) {
        rt.settled_paise = result.settled_paise;
        rt.status = 'recovered';
        rt.stopped_reason = 'RECOVERED: debit succeeded';
      }

      emit('outcome', result.success ? result.settled_paise : 0, cost, {
        status: result.success ? 'success' : 'failure',
        code: result.code,
        settled_paise: result.success ? result.settled_paise : null,
      });

      if (!isClosed(rt)) {
        const gap = tax?.min_retry_gap_hours ?? 24;
        rt.next_wake = addHours(now, Math.max(1, gap));
      }
      return;
    }
  }
}

/** Deliver a message, record it, charge for it, and report whether it landed. */
function recordContact(
  a: ExecArgs,
  channel: Contact['channel'],
  templateId: string,
  actionable: boolean,
  compliance = false,
): boolean {
  const { rt, wc, now, costs } = a;
  const result = deliver({
    latent: wc.latent,
    channel,
    // Fatigue is driven by collections pressure, not by notices the payer is
    // owed. Counting notices here would make a compliant policy look pushy.
    prior_contacts: rt.contacts.filter((c) => !c.compliance).length,
    actionable,
    rng: Rng.stream(a.seed, rt.case_id, STREAM.responsiveness, rt.contacts.length),
  });

  rt.contacts.push({
    id: `CON-${rt.case_id}-${rt.contacts.length + 1}`,
    invoice_id: wc.invoice.id,
    ts: now,
    channel,
    template_id: templateId,
    language: wc.customer.language_pref,
    compliance,
    acted_on: result.acted,
  });

  const cost = costs.messageCost(channel);
  rt.cost_paise = paise(rt.cost_paise + cost);
  return result.acted;
}
