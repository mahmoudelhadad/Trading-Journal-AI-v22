import { describe, expect, it } from 'vitest';
import { fr, getSignColor } from './formatters.js';
import { COLORS as C } from '@constants/lists.js';

describe('finite-safe numeric formatters', () => {
  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'renders unavailable value %s as an em dash',
    (value) => {
      expect(fr.r(value)).toBe('—');
      expect(fr.pct(value)).toBe('—');
      expect(fr.usd(value)).toBe('—');
      expect(fr.pt(value)).toBe('—');
    },
  );

  it('preserves finite positive, negative, and zero formatting', () => {
    expect(fr.r(1.25)).toBe('+1.25R');
    expect(fr.r(-1.25)).toBe('-1.25R');
    expect(fr.r(0)).toBe('+0.00R');
    expect(fr.pct(0.125)).toBe('12.5%');
    expect(fr.usd(12.5)).toBe('+$12.50');
    expect(fr.usd(-12.5)).toBe('-$12.50');
    expect(fr.pt(0)).toBe('+0.00');
  });

  it('uses the dim sign color for unavailable/non-finite values', () => {
    expect(getSignColor(null)).toBe(C.dim);
    expect(getSignColor(Number.NaN)).toBe(C.dim);
    expect(getSignColor(Number.POSITIVE_INFINITY)).toBe(C.dim);
  });

  it('does not render finite-input formatting overflow as Infinity', () => {
    expect(fr.pct(1e308)).toBe('—');
  });
});
