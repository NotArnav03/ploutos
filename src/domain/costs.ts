import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { COSTS_PATH } from './paths.js';
import { paise, scalePaise, type Paise } from './money.js';
import type { Channel, Rail } from './schemas.js';

/**
 * Cost model.
 *
 * Mechanical costs (messages, gateway attempts) and the goodwill assumption are
 * kept in separate accumulators all the way through to the report, because they
 * have different epistemic standing. Mechanical costs are things a merchant
 * actually pays. Goodwill is a modelling assumption that cannot be validated
 * from a simulation, so the headline net figure uses mechanical cost only and
 * the goodwill-inclusive figure is reported beside it, labelled.
 *
 * Folding an unfalsifiable penalty into the headline would be the easiest way
 * to make the agent look good by construction, since the agent contacts less
 * than the naive baseline by design.
 */

const CostsFileSchema = z.object({
  version: z.number().int().positive(),
  channel_cost_paise: z.object({
    sms: z.number().int().nonnegative(),
    whatsapp: z.number().int().nonnegative(),
    email: z.number().int().nonnegative(),
    inapp: z.number().int().nonnegative(),
  }),
  attempt_cost_paise: z.object({
    upi_autopay: z.object({
      failed: z.number().int().nonnegative(),
      succeeded: z.number().int().nonnegative(),
    }),
    enach: z.object({
      failed: z.number().int().nonnegative(),
      succeeded: z.number().int().nonnegative(),
    }),
    card_on_file: z.object({
      failed: z.number().int().nonnegative(),
      succeeded_bps: z.number().int().nonnegative(),
    }),
  }),
  payment_link_cost_paise: z.number().int().nonnegative(),
  human_handoff_cost_paise: z.number().int().nonnegative(),
  goodwill: z.object({
    free_contacts: z.number().int().nonnegative(),
    penalty_per_extra_contact_bps: z.number().int().nonnegative(),
    cancellation_penalty_bps: z.number().int().nonnegative(),
    attributed_after_contacts: z.number().int().nonnegative(),
  }),
  inference: z.object({
    model: z.string(),
    usd_per_million_input: z.number().nonnegative(),
    usd_per_million_output: z.number().nonnegative(),
  }),
});
export type CostsFile = z.infer<typeof CostsFileSchema>;

let cached: CostsFile | null = null;

export function loadCosts(file = COSTS_PATH): CostsFile {
  if (file === COSTS_PATH && cached) return cached;
  const raw = parseYaml(readFileSync(file, 'utf8')) as unknown;
  const parsed = CostsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`${file} failed validation:\n${detail}`);
  }
  if (file === COSTS_PATH) cached = parsed.data;
  return parsed.data;
}

const BPS = 10_000;

export class CostModel {
  constructor(private readonly costs: CostsFile = loadCosts()) {}

  /**
   * What the model decisions in a run cost, in USD.
   *
   * Not converted to paise and not folded into `net_recovered_paise`. The
   * mechanical costs in this file are rupees a merchant pays a gateway; this is
   * dollars paid to a model vendor, and silently adding them at some assumed
   * exchange rate would put an unstated assumption inside the headline number.
   * It is reported beside the rupee figures instead.
   */
  inferenceCostUsd(tokensIn: number, tokensOut: number): number {
    const p = this.costs.inference;
    return (
      (tokensIn / 1_000_000) * p.usd_per_million_input +
      (tokensOut / 1_000_000) * p.usd_per_million_output
    );
  }

  get inferenceModel(): string {
    return this.costs.inference.model;
  }

  messageCost(channel: Channel): Paise {
    return paise(this.costs.channel_cost_paise[channel]);
  }

  /** Cost of one presentment. Success on cards carries a rate on the amount. */
  attemptCost(rail: Rail, succeeded: boolean, settled: Paise): Paise {
    const table = this.costs.attempt_cost_paise;
    if (rail === 'card_on_file') {
      return succeeded
        ? scalePaise(settled, table.card_on_file.succeeded_bps / BPS)
        : paise(table.card_on_file.failed);
    }
    const t = table[rail];
    return paise(succeeded ? t.succeeded : t.failed);
  }

  paymentLinkCost(): Paise {
    return paise(this.costs.payment_link_cost_paise);
  }

  handoffCost(): Paise {
    return paise(this.costs.human_handoff_cost_paise);
  }

  /**
   * Goodwill penalty for a finished case. An ASSUMPTION, reported separately
   * and never folded into the headline net figure.
   */
  goodwillCost(args: {
    contacts: number;
    ltv: Paise;
    endedInCancellation: boolean;
  }): Paise {
    const g = this.costs.goodwill;
    const extra = Math.max(0, args.contacts - g.free_contacts);
    let total = scalePaise(args.ltv, (extra * g.penalty_per_extra_contact_bps) / BPS);

    if (args.endedInCancellation && args.contacts >= g.attributed_after_contacts) {
      total = paise(total + scalePaise(args.ltv, g.cancellation_penalty_bps / BPS));
    }
    return total;
  }
}
