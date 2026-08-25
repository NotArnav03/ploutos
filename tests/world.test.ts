import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { paise, rupees } from '../src/domain/money.js';
import { TaxonomyIndex } from '../src/domain/taxonomy.js';
import { addDays, TimestampSchema, type Timestamp } from '../src/domain/time.js';
import { generateWorld } from '../src/world/generator.js';
import { Rng, STREAM } from '../src/world/rng.js';
import { availableAt, deliver, present } from '../src/world/simulator.js';
import { ARCHETYPE_EXPECTED_CODE } from '../src/world/types.js';

const IST = 'Asia/Kolkata';
const taxonomy = new TaxonomyIndex();

function hashWorld(w: unknown): string {
  return createHash('sha256').update(JSON.stringify(w)).digest('hex').slice(0, 16);
}

describe('world model is frozen', () => {
  /**
   * A golden hash over a small world.
   *
   * This is the mechanism that makes "the world model was frozen before the
   * agent existed" enforceable rather than a claim in a README. Any change to
   * the generator or the simulator moves this hash and fails the build, which
   * forces a deliberate decision: either revert, or accept that every baseline
   * measured in the old world is void and must be re-run.
   *
   * Do not update this constant to make a red test go green. Pinned once, on
   * 2026-08-25, when the world model was frozen at the end of day 2.
   */
  const GOLDEN = 'd8c421aed8ce25e5';

  it('produces a byte-identical world for a fixed seed', () => {
    const a = generateWorld({ seed: 7, size: 40 });
    expect(hashWorld(a.world)).toBe(GOLDEN);
  });

  it('reproduces across repeated invocations', () => {
    const a = generateWorld({ seed: 7, size: 40 });
    const b = generateWorld({ seed: 7, size: 40 });
    expect(hashWorld(a.world)).toBe(hashWorld(b.world));
  });

  it('produces a different world for a different seed', () => {
    const a = generateWorld({ seed: 7, size: 40 });
    const b = generateWorld({ seed: 8, size: 40 });
    expect(hashWorld(a.world)).not.toBe(hashWorld(b.world));
  });
});

describe('generated batch', () => {
  const { world, target_mix, realised_mix, relabelled } = generateWorld({ seed: 42, size: 400 });

  it('is a queue of invoices that have already failed once', () => {
    for (const c of world.cases) {
      expect(c.invoice.attempts.length, c.case_id).toBe(1);
      expect(c.invoice.attempts[0]?.succeeded, c.case_id).toBe(false);
      expect(c.invoice.attempts[0]?.code, c.case_id).not.toBeNull();
      expect(c.invoice.status, c.case_id).toBe('failed');
    }
  });

  it('emits only codes the rail can actually produce', () => {
    for (const c of world.cases) {
      const code = c.invoice.attempts[0]?.code ?? '';
      expect(taxonomy.get(code).rails, `${c.case_id} ${code}`).toContain(c.subscription.rail);
    }
  });

  it('stays close to the target mix', () => {
    // The mix is what we asked for; realised is what the mechanism produced.
    // Drift is reported rather than forced to zero, but a large drift means the
    // generator is not building the causes it thinks it is.
    for (const [code, target] of Object.entries(target_mix)) {
      if (target === 0) continue;
      const got = realised_mix[code] ?? 0;
      expect(Math.abs(got - target), `${code} target ${target} got ${got}`).toBeLessThan(0.05);
    }
  });

  it('rarely has to relabel a case', () => {
    // Relabelling means latent state was built for one cause and the simulator
    // derived another. A few are fine and honest; many would mean the causal
    // construction is not actually causal.
    expect(relabelled / world.cases.length).toBeLessThan(0.03);
  });

  it('leaves a meaningful share of value structurally unrecoverable', () => {
    const total = world.cases.reduce((a, c) => a + c.invoice.amount_paise, 0);
    const hard = world.cases
      .filter((c) => taxonomy.isHard(c.invoice.attempts[0]?.code ?? ''))
      .reduce((a, c) => a + c.invoice.amount_paise, 0);
    expect(hard / total).toBeGreaterThan(0.05);
    expect(hard / total).toBeLessThan(0.35);
  });

  it('carries the full set of adversarial cases', () => {
    const kinds = new Set(world.cases.map((c) => c.adversarial).filter((k) => k !== null));
    expect(kinds.size).toBeGreaterThanOrEqual(7);
  });

  it('keeps the merchant mandate view stale where truth has moved on', () => {
    // A payer who revoked at their bank still shows as active to the merchant.
    // That staleness is what makes MANDATE_ACTIVE_REQUIRED a real check.
    const revoked = world.cases.filter((c) => c.latent.true_mandate_status === 'revoked');
    expect(revoked.length).toBeGreaterThan(0);
    for (const c of revoked) expect(c.subscription.mandate.status).toBe('active');
  });

  it('gives every customer a complete channel map', () => {
    for (const c of world.cases) {
      for (const ch of ['sms', 'email', 'whatsapp', 'inapp'] as const) {
        expect(c.customer.channels[ch], `${c.case_id} ${ch}`).toBeDefined();
      }
    }
  });
});

describe('causality: the simulator derives codes, it does not read labels', () => {
  const { world } = generateWorld({ seed: 11, size: 200 });

  it('independently reproduces the day-0 code from latent state alone', () => {
    // The generator built latent state for an archetype; the simulator was
    // handed only that state and derived a code. If the derived code matches
    // the archetype's expected code, the causal chain is real. If the simulator
    // were reading a planted label, this test would pass trivially - so it is
    // paired with the mandate-recovery test below, which shows the mechanism
    // actually governs outcomes.
    let matched = 0;
    for (const c of world.cases) {
      if (c.invoice.attempts[0]?.code === ARCHETYPE_EXPECTED_CODE[c.archetype]) matched++;
    }
    expect(matched / world.cases.length).toBeGreaterThan(0.97);
  });

  it('cannot recover a hard failure at any timing', () => {
    // The defining property of the unrecoverable slice. If any retry schedule
    // could clear these, the recoverable ceiling would be wrong.
    const hard = world.cases.filter((c) => taxonomy.isHard(c.invoice.attempts[0]?.code ?? ''));
    expect(hard.length).toBeGreaterThan(0);

    for (const c of hard.slice(0, 25)) {
      for (let day = 1; day <= 30; day++) {
        const at = addDays(c.invoice.due_date, day);
        const r = present({
          latent: c.latent,
          issuer: world.issuers.find((i) => i.issuer === c.latent.issuer)!,
          start_ts: world.meta.start_ts,
          at,
          rail: c.subscription.rail,
          amount: c.invoice.amount_paise,
          attempt_seq: 2,
          invoice_settled: false,
          mandate_afa_required: c.subscription.mandate.afa_required,
          afa_threshold_paise: rupees(15000),
          afa_satisfied: true,
          predebit_notice_served_at: addDays(at, -2),
          predebit_notice_hours: 24,
          timezone: IST,
          rng: Rng.stream(1, c.case_id, STREAM.outcome, day),
        });
        expect(r.success, `${c.case_id} recovered on day ${day}`).toBe(false);
      }
    }
  });

  it('recovers a salary-timing case once the account is funded', () => {
    // The counterpart: soft timing failures MUST be recoverable, or the
    // ceiling collapses and the whole comparison becomes trivial.
    const timing = world.cases.filter(
      (c) => c.invoice.attempts[0]?.code === 'INSUFFICIENT_FUNDS' && c.latent.intent !== 'insolvent',
    );
    expect(timing.length).toBeGreaterThan(0);

    let recovered = 0;
    for (const c of timing.slice(0, 40)) {
      for (let day = 1; day <= 30; day++) {
        const at = addDays(c.invoice.due_date, day);
        const r = present({
          latent: c.latent,
          issuer: world.issuers.find((i) => i.issuer === c.latent.issuer)!,
          start_ts: world.meta.start_ts,
          at,
          rail: c.subscription.rail,
          amount: c.invoice.amount_paise,
          attempt_seq: 2,
          invoice_settled: false,
          mandate_afa_required: c.subscription.mandate.afa_required,
          afa_threshold_paise: rupees(15000),
          afa_satisfied: true,
          predebit_notice_served_at: addDays(at, -2),
          predebit_notice_hours: 24,
          timezone: IST,
          rng: Rng.stream(2, c.case_id, STREAM.outcome, day),
        });
        if (r.success) {
          recovered++;
          break;
        }
      }
    }
    expect(recovered / Math.min(40, timing.length)).toBeGreaterThan(0.6);
  });
});

describe('presentment mechanics', () => {
  const { world } = generateWorld({ seed: 3, size: 20 });
  const c = world.cases[0]!;
  const issuer = world.issuers.find((i) => i.issuer === c.latent.issuer)!;

  const base = {
    latent: c.latent,
    issuer,
    start_ts: world.meta.start_ts,
    at: c.invoice.due_date,
    rail: c.subscription.rail,
    amount: c.invoice.amount_paise,
    attempt_seq: 1,
    mandate_afa_required: false,
    afa_threshold_paise: rupees(15000),
    afa_satisfied: true,
    predebit_notice_served_at: addDays(c.invoice.due_date, -2),
    predebit_notice_hours: 24,
    timezone: IST,
  };

  it('flags a presentment against an already-settled invoice as a double charge', () => {
    // The money moves. Modelling this as a polite refusal would understate the
    // worst thing this system can do.
    const r = present({
      ...base,
      invoice_settled: true,
      rng: Rng.stream(1, 'x', STREAM.outcome),
    });
    expect(r.double_charge).toBe(true);
    expect(r.success).toBe(true);
    expect(r.settled_paise).toBe(c.invoice.amount_paise);
  });

  it('refuses a debit above the authorised mandate cap', () => {
    const r = present({
      ...base,
      invoice_settled: false,
      amount: paise(c.latent.true_mandate_cap_paise + 1),
      rng: Rng.stream(1, 'y', STREAM.outcome),
    });
    expect(r.success).toBe(false);
    expect(r.code).toBe('MANDATE_CAP_EXCEEDED');
  });

  it('refuses an e-mandate debit with no advance notice served', () => {
    if (c.subscription.rail === 'card_on_file') return;
    const r = present({
      ...base,
      invoice_settled: false,
      predebit_notice_served_at: null,
      rng: Rng.stream(1, 'z', STREAM.outcome),
    });
    expect(r.code).toBe('PREDEBIT_NOTICE_MISSING');
  });
});

describe('balance model', () => {
  const at = (d: string): Timestamp => TimestampSchema.parse(d);

  const latent = {
    balance_refill_day: 7,
    funded_window_days: 10,
    available_on_refill_paise: rupees(8000),
    residual_balance_paise: rupees(50),
  } as Parameters<typeof availableAt>[0];

  it('is short before payday and funded after it', () => {
    // 3rd of the month, IST.
    expect(availableAt(latent, at('2026-08-02T22:00:00.000Z'), IST)).toBe(rupees(50));
    // 8th of the month, inside the funded window.
    expect(availableAt(latent, at('2026-08-08T06:00:00.000Z'), IST)).toBe(rupees(8000));
  });

  it('runs dry again once the window closes', () => {
    expect(availableAt(latent, at('2026-08-20T06:00:00.000Z'), IST)).toBe(rupees(50));
  });
});

describe('message delivery', () => {
  const base = {
    channel: 'email' as const,
    prior_contacts: 0,
    actionable: true,
  };

  function latentWith(intent: string): Parameters<typeof deliver>[0]['latent'] {
    return {
      responsiveness: { sms: 0.9, email: 0.9, whatsapp: 0.9, inapp: 0.9, fatigue_decay: 0.8 },
      intent,
    } as Parameters<typeof deliver>[0]['latent'];
  }

  it('never gets a disputing payer to act on a payment request', () => {
    // This is what stops "send more messages" from being a winning strategy.
    for (let i = 0; i < 200; i++) {
      const r = deliver({
        ...base,
        latent: latentWith('disputing'),
        rng: Rng.stream(i, 'd', STREAM.outcome),
      });
      expect(r.acted).toBe(false);
      expect(r.p_acted).toBe(0);
    }
  });

  it('never gets a churned payer to act either', () => {
    for (let i = 0; i < 200; i++) {
      const r = deliver({
        ...base,
        latent: latentWith('churned'),
        rng: Rng.stream(i, 'c', STREAM.outcome),
      });
      expect(r.acted).toBe(false);
    }
  });

  it('decays with each prior contact', () => {
    const fresh = deliver({
      ...base,
      latent: latentWith('willing'),
      prior_contacts: 0,
      rng: Rng.stream(1, 'f', STREAM.outcome),
    });
    const tired = deliver({
      ...base,
      latent: latentWith('willing'),
      prior_contacts: 5,
      rng: Rng.stream(1, 'f', STREAM.outcome),
    });
    expect(tired.p_acted).toBeLessThan(fresh.p_acted);
  });
});
