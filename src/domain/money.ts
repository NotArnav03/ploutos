import { z } from 'zod';

/**
 * Money is integer paise. Never a float, never a string, never rupees.
 *
 * Every amount that crosses a module boundary in this system is Paise. The
 * brand exists so that a raw `number` cannot be passed where money is expected
 * without going through `paise()` or `rupees()`, which makes an accidental
 * float impossible to introduce quietly.
 */
export const PaiseSchema = z.number().int().nonnegative().brand<'Paise'>();
export type Paise = z.infer<typeof PaiseSchema>;

/** Signed paise, for deltas in the ledger (a reversal is negative). */
export const PaiseDeltaSchema = z.number().int().brand<'PaiseDelta'>();
export type PaiseDelta = z.infer<typeof PaiseDeltaSchema>;

export function paise(n: number): Paise {
  if (!Number.isInteger(n)) throw new RangeError(`paise() needs an integer, got ${n}`);
  if (n < 0) throw new RangeError(`paise() needs a non-negative value, got ${n}`);
  return n as Paise;
}

/** Convenience for readable fixtures. Rejects sub-paise precision outright. */
export function rupees(n: number): Paise {
  const p = Math.round(n * 100);
  if (Math.abs(n * 100 - p) > 1e-9) {
    throw new RangeError(`rupees(${n}) is not a whole number of paise`);
  }
  return paise(p);
}

export function delta(n: number): PaiseDelta {
  if (!Number.isInteger(n)) throw new RangeError(`delta() needs an integer, got ${n}`);
  return n as PaiseDelta;
}

export function addPaise(a: Paise, b: Paise): Paise {
  return paise(a + b);
}

export function subPaise(a: Paise, b: Paise): Paise {
  return paise(a - b);
}

export function sumPaise(xs: readonly Paise[]): Paise {
  return paise(xs.reduce<number>((acc, x) => acc + x, 0));
}

/**
 * Multiply money by a rate and round half-up to the nearest paise. Used for
 * intervention costs and never for anything that is presented for debit.
 */
export function scalePaise(a: Paise, rate: number): Paise {
  if (!Number.isFinite(rate) || rate < 0) throw new RangeError(`bad rate ${rate}`);
  return paise(Math.round(a * rate));
}

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
});

/** Human-readable, Indian digit grouping. Display only, never parsed back. */
export function formatINR(p: Paise | PaiseDelta): string {
  return INR.format(p / 100);
}
