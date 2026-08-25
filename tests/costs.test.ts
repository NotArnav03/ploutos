import { describe, expect, it } from 'vitest';
import { CostModel, loadCosts } from '../src/domain/costs.js';
import { paise, rupees } from '../src/domain/money.js';

describe('cost model', () => {
  const costs = new CostModel(loadCosts());

  it('prices messages per channel', () => {
    expect(costs.messageCost('sms')).toBe(20);
    expect(costs.messageCost('inapp')).toBe(0);
  });

  it('charges for a failed presentment', () => {
    // A failed retry is not free. This is what makes an untargeted retry
    // policy expensive rather than merely ineffective, and it is why the
    // headline reports a net figure rather than gross recovery.
    expect(costs.attemptCost('enach', false, paise(0))).toBeGreaterThan(0);
    expect(costs.attemptCost('upi_autopay', false, paise(0))).toBeGreaterThan(0);
  });

  it('charges card success as a rate on the settled amount', () => {
    // 200 bps of Rs 499.
    expect(costs.attemptCost('card_on_file', true, rupees(499))).toBe(998);
  });

  it('charges nothing on a successful upi debit', () => {
    expect(costs.attemptCost('upi_autopay', true, rupees(499))).toBe(0);
  });

  it('leaves the first contacts goodwill-free', () => {
    const free = costs.goodwillCost({
      contacts: 2,
      ltv: rupees(20000),
      endedInCancellation: false,
    });
    expect(free).toBe(0);
  });

  it('penalises contacts beyond the free allowance', () => {
    const some = costs.goodwillCost({
      contacts: 4,
      ltv: rupees(20000),
      endedInCancellation: false,
    });
    expect(some).toBeGreaterThan(0);
  });

  it('grows the penalty with contact count', () => {
    const ltv = rupees(20000);
    const three = costs.goodwillCost({ contacts: 3, ltv, endedInCancellation: false });
    const five = costs.goodwillCost({ contacts: 5, ltv, endedInCancellation: false });
    expect(five).toBeGreaterThan(three);
  });

  it('only attributes cancellation once the contact threshold is passed', () => {
    const ltv = rupees(20000);
    const quiet = costs.goodwillCost({ contacts: 1, ltv, endedInCancellation: true });
    const loud = costs.goodwillCost({ contacts: 4, ltv, endedInCancellation: true });
    // We cannot know contacts caused a cancellation, so attribution is
    // deliberately conservative and reported separately from mechanical cost.
    expect(quiet).toBe(0);
    expect(loud).toBeGreaterThan(0);
  });
});
