import { describe, expect, it } from 'vitest';
import { addPaise, formatINR, paise, rupees, scalePaise, subPaise, sumPaise } from '../src/domain/money.js';

describe('money', () => {
  it('refuses non-integer paise', () => {
    expect(() => paise(10.5)).toThrow(/integer/);
  });

  it('refuses negative amounts', () => {
    expect(() => paise(-1)).toThrow(/non-negative/);
  });

  it('converts whole rupees exactly', () => {
    expect(rupees(499)).toBe(49900);
    expect(rupees(1234.56)).toBe(123456);
  });

  it('refuses sub-paise precision instead of rounding it away', () => {
    // A silent round here is exactly how a batch total drifts from the sum of
    // its invoices, which is the first thing a payments reviewer checks.
    expect(() => rupees(0.001)).toThrow(/whole number of paise/);
  });

  it('sums without floating point drift', () => {
    const amounts = Array.from({ length: 1000 }, () => rupees(0.01));
    expect(sumPaise(amounts)).toBe(1000);
  });

  it('adds and subtracts', () => {
    expect(addPaise(rupees(10), rupees(5))).toBe(1500);
    expect(subPaise(rupees(10), rupees(5))).toBe(500);
  });

  it('refuses a subtraction that would go negative', () => {
    expect(() => subPaise(rupees(5), rupees(10))).toThrow(/non-negative/);
  });

  it('rounds a scaled amount to whole paise', () => {
    expect(scalePaise(paise(1000), 0.025)).toBe(25);
    expect(scalePaise(paise(333), 0.5)).toBe(167);
  });

  it('formats with Indian digit grouping', () => {
    // 12,34,567 rupees, not 1,234,567.
    expect(formatINR(rupees(1234567))).toContain('12,34,567');
  });
});
