import { describe, expect, it } from 'vitest';
import type { RawTradeContent, TradeLeg } from '@apptypes/trade.js';
import {
  buildScaledTradeCandidate,
  canonicalLegOrder,
  createManualLeg,
  deriveAggregatesFromLegs,
  foldPosition,
  decimalPlaces,
  formatExactQuotient,
  hasManualLegs,
  isImportedTrade,
  isWholeQuantity,
  openQuantityText,
  parseDecimal,
  parseScaled,
  scaleLegsReducer,
} from './scaleLegs.js';

const leg = (
  kind: 'entry' | 'exit',
  quantity: string,
  price: string,
  time: string,
  date = '2026-08-10',
): TradeLeg => ({ kind, quantity, price, date, time });

const tradeWith = (legs: TradeLeg[], overrides: Partial<RawTradeContent> = {}): RawTradeContent => ({
  ...({
    _tid: 1, market: 'futures', symbol: 'NQ', date: '2026-08-10', direction: 'Long',
    positionSize: '', entryPrice: '', exitPrice: '', entryTime: '', exitTime: '',
  } as unknown as RawTradeContent),
  ...overrides,
  legs,
});

describe('scaleLegs — exact arithmetic', () => {
  it('derives the RFC 2+2/2+2 example exactly', () => {
    const legs = [
      leg('entry', '2', '28920', '09:32:00'),
      leg('entry', '2', '28930', '09:41:00'),
      leg('exit', '2', '28970.50', '10:15:00'),
      leg('exit', '2', '28980', '10:48:00'),
    ];
    expect(deriveAggregatesFromLegs(legs)).toEqual({
      positionSize: '4',
      entryPrice:   '28925',
      exitPrice:    '28975.25',
      entryTime:    '09:32',
      exitTime:     '10:48',
    });
  });

  it('treats positionSize as total entry-side quantity, not peak exposure', () => {
    // Entry 2 -> Exit 1 -> Entry 1 -> Exit 2: entry-side total 3, peak exposure 2.
    const legs = [
      leg('entry', '2', '100', '09:00:00'),
      leg('exit', '1', '140', '09:30:00'),
      leg('entry', '1', '130', '10:00:00'),
      leg('exit', '2', '155', '10:30:00'),
    ];
    const aggregates = deriveAggregatesFromLegs(legs);
    expect(aggregates.positionSize).toBe('3');
    expect(aggregates.entryPrice).toBe('110');
    expect(aggregates.exitPrice).toBe('150');

    // Peak simultaneous exposure was only 2 — proving the two differ.
    const peak = foldPosition(legs).steps
      .reduce((max, step) => (step.openScaled !== null && step.openScaled > max ? step.openScaled : max), 0n);
    expect(formatExactQuotient(peak, 10n ** 4n)).toBe('2');
  });

  it('makes gross P/L exact: size * (avgExit - avgEntry) equals realized value difference', () => {
    const legs = [
      leg('entry', '2', '100', '09:00:00'),
      leg('exit', '1', '140', '09:30:00'),
      leg('entry', '1', '130', '10:00:00'),
      leg('exit', '2', '155', '10:30:00'),
    ];
    const { positionSize, entryPrice, exitPrice } = deriveAggregatesFromLegs(legs);
    const viaAggregates = Number(positionSize) * (Number(exitPrice) - Number(entryPrice));
    const realized = (1 * 140 + 2 * 155) - (2 * 100 + 1 * 130);
    expect(viaAggregates).toBe(realized);
    expect(viaAggregates).toBe(120);
  });

  it('cross-checks a NinjaTrader-shaped 4-decimal futures episode', () => {
    const legs = [
      leg('entry', '2', '28920.25', '09:32:14'),
      leg('entry', '2', '28930.75', '09:41:07'),
      leg('exit', '2', '28970.50', '10:15:33'),
      leg('exit', '2', '28980', '10:48:52'),
    ];
    const aggregates = deriveAggregatesFromLegs(legs);
    expect(aggregates.positionSize).toBe('4');
    expect(aggregates.entryPrice).toBe('28925.5');
    expect(aggregates.exitPrice).toBe('28975.25');
    // Imported legs keep real seconds; aggregate times are HH:mm.
    expect(aggregates.entryTime).toBe('09:32');
    expect(aggregates.exitTime).toBe('10:48');
  });

  it('keeps 5-decimal forex weighted averages free of float tails', () => {
    const legs = [
      leg('entry', '1', '1.08345', '09:00:00'),
      leg('entry', '2', '1.08347', '09:05:00'),
      leg('exit', '3', '1.08400', '10:00:00'),
    ];
    const { entryPrice } = deriveAggregatesFromLegs(legs);
    expect(entryPrice).toBe('1.0834633333');
    // The float route produces 1.0834633333333335 — proving bigint is required.
    expect(entryPrice).not.toContain('33333335');
    expect((1 * 1.08345 + 2 * 1.08347) / 3).not.toBe(Number(entryPrice));
  });

  it('supports fractional forex lots and uneven weighting', () => {
    expect(deriveAggregatesFromLegs([
      leg('entry', '0.25', '1.1', '09:00:00'),
      leg('entry', '0.75', '1.1', '09:01:00'),
      leg('exit', '1', '1.2', '10:00:00'),
    ]).positionSize).toBe('1');

    expect(deriveAggregatesFromLegs([
      leg('entry', '1', '100', '09:00:00'),
      leg('entry', '3', '200', '09:01:00'),
      leg('exit', '4', '250', '10:00:00'),
    ]).entryPrice).toBe('175');
  });

  it('trims trailing zeros and reports earliest entry / latest exit', () => {
    expect(formatExactQuotient(25000n, 10000n)).toBe('2.5');
    expect(formatExactQuotient(40000n, 10000n)).toBe('4');
    const aggregates = deriveAggregatesFromLegs([
      leg('entry', '1', '100.5000', '11:00:00'),
      leg('entry', '1', '100.5000', '09:15:00'),
      leg('exit', '2', '101', '16:45:00'),
    ]);
    expect(aggregates.entryPrice).toBe('100.5');
    expect(aggregates.entryTime).toBe('09:15');
    expect(aggregates.exitTime).toBe('16:45');
  });

  it('accepts the frozen plain-decimal grammar, including a bare leading dot', () => {
    // '.5' is ordinary manual input for half a forex lot and MUST parse
    // exactly — the earlier regex required a leading digit and rejected it.
    expect(parseScaled('.5', 4)).toBe(5000n);
    expect(parseScaled('0.5', 4)).toBe(5000n);
    expect(parseScaled('+.5', 4)).toBe(5000n);
    expect(parseScaled('+0.5', 4)).toBe(5000n);
    expect(parseScaled('1', 4)).toBe(10000n);
    expect(parseScaled('1.25', 4)).toBe(12500n);
    expect(decimalPlaces('.5')).toBe(1);
    expect(decimalPlaces('+0.50')).toBe(2);
  });

  it('rejects exponent and other non-decimal syntax that Number() would accept', () => {
    for (const value of ['1e0', '1e2', '1E2', '1e-2', 'NaN', 'Infinity', '0x1F', '1.', '1px', '', ' ', '-1', '1,000']) {
      expect(parseDecimal(value)).toBeNull();
      expect(parseScaled(value, 4)).toBeNull();
      expect(decimalPlaces(value)).toBeNull();
    }
    // Number() disagrees on exactly these — which is why it is not the authority.
    expect(Number.isFinite(Number('1e2'))).toBe(true);
    expect(Number.isFinite(Number('.5'))).toBe(true);
  });

  it('FAILS CLOSED when a quantity cannot be parsed — no vacuous zero balance', () => {
    const fold = foldPosition([
      leg('entry', '1e0', '1.10', '09:00:00'),
      leg('exit', '1e0', '1.20', '10:00:00'),
    ]);
    // Both totals remain 0n, so a naive equality check would call this
    // "balanced". `ok` is what prevents that reading.
    expect(fold.entryQtyScaled).toBe(0n);
    expect(fold.exitQtyScaled).toBe(0n);
    expect(fold.entryQtyScaled === fold.exitQtyScaled).toBe(true);
    expect(fold.ok).toBe(false);
    expect(fold.unparseableIndex).toBe(0);
  });

  it('marks the fold ok for a genuinely balanced episode', () => {
    const fold = foldPosition([
      leg('entry', '.5', '1.10', '09:00:00'),
      leg('exit', '0.5', '1.20', '10:00:00'),
    ]);
    expect(fold.ok).toBe(true);
    expect(fold.unparseableIndex).toBe(-1);
    expect(fold.entryQtyScaled).toBe(5000n);
    expect(fold.exitQtyScaled).toBe(5000n);
  });

  it('derives real aggregates for fractional forex legs written with a bare dot', () => {
    const aggregates = deriveAggregatesFromLegs([
      leg('entry', '.5', '1.10', '09:00:00'),
      leg('exit', '.5', '1.20', '10:00:00'),
    ]);
    expect(aggregates.positionSize).toBe('0.5');
    expect(aggregates.entryPrice).toBe('1.1');
    expect(aggregates.exitPrice).toBe('1.2');
    // The five owned aggregates must never all come back blank for a
    // legitimate non-empty episode.
    expect(Object.values(aggregates).every((value) => value === '')).toBe(false);
  });

  it('round-trips a manual HH:mm time through storage and an untouched reopen', () => {
    // The UI stores 'HH:mm:00' on keystroke, so the validator never sees a
    // bare 'HH:mm' from the form; reopening an untouched leg must still save.
    const saved = buildScaledTradeCandidate(tradeWith([
      leg('entry', '1', '100', '09:32'),
      leg('exit', '1', '110', '10:00'),
    ]));
    expect(saved.legs?.map((item) => item.time)).toEqual(['09:32:00', '10:00:00']);

    // Reopen the persisted trade and save again without touching anything.
    const reopened = buildScaledTradeCandidate(saved);
    expect(reopened.legs?.map((item) => item.time)).toEqual(['09:32:00', '10:00:00']);
    expect(reopened.entryTime).toBe('09:32');
    expect(reopened.exitTime).toBe('10:00');
  });

  it('rejects over-precise values and validates whole-quantity detection', () => {
    expect(parseScaled('1.123456789', 8)).toBeNull();
    expect(parseScaled('1.12345678', 8)).not.toBeNull();
    expect(parseScaled('1.12345', 4)).toBeNull();
    expect(isWholeQuantity('2')).toBe(true);
    expect(isWholeQuantity('2.0')).toBe(true);
    expect(isWholeQuantity('2.5')).toBe(false);
  });

  it('reports blank aggregates for an unbalanced episode instead of a misleading exit average', () => {
    const aggregates = deriveAggregatesFromLegs([
      leg('entry', '4', '100', '09:00:00'),
      leg('exit', '2', '110', '10:00:00'),
    ]);
    expect(aggregates.positionSize).toBe('4');
    expect(aggregates.entryPrice).toBe('100');
    expect(aggregates.exitPrice).toBe('');
    expect(openQuantityText([
      leg('entry', '4', '100', '09:00:00'),
      leg('exit', '2', '110', '10:00:00'),
    ])).toBe('2');
  });
});

describe('scaleLegs — canonical ordering', () => {
  it('sorts by time ascending', () => {
    const ordered = canonicalLegOrder([
      leg('exit', '1', '300', '11:00:00'),
      leg('entry', '1', '100', '09:00:00'),
      leg('entry', '1', '200', '10:00:00'),
    ]);
    expect(ordered.map((item) => item.price)).toEqual(['100', '200', '300']);
  });

  it('breaks equal-time ties on EXISTING array order, not original insertion order', () => {
    // A inserted first at 10:00, B second at 09:00.
    const a = leg('entry', '1', 'A', '10:00:00');
    const b = leg('entry', '1', 'B', '09:00:00');
    const first = canonicalLegOrder([a, b]);
    expect(first.map((item) => item.price)).toEqual(['B', 'A']);

    // B is later edited to 10:00. The tie-break is the CURRENT array
    // order [B, A] — not the original insertion order [A, B].
    const edited = [{ ...first[0], time: '10:00:00' }, first[1]];
    expect(canonicalLegOrder(edited).map((item) => item.price)).toEqual(['B', 'A']);
  });

  it('is idempotent', () => {
    const legs = [
      leg('exit', '1', '300', '11:00:00'),
      leg('entry', '1', '100', '09:00:00'),
      leg('entry', '1', '200', '09:00:00'),
    ];
    const once = canonicalLegOrder(legs);
    expect(canonicalLegOrder(once)).toEqual(once);
    expect(canonicalLegOrder(canonicalLegOrder(once))).toEqual(once);
  });

  it('compares HH:mm and HH:mm:ss consistently', () => {
    const ordered = canonicalLegOrder([
      leg('exit', '1', 'later', '10:00'),
      leg('entry', '1', 'earlier', '09:32:00'),
    ]);
    expect(ordered.map((item) => item.price)).toEqual(['earlier', 'later']);
  });
});

describe('scaleLegs — position folding', () => {
  it('allows a partial exit followed by a re-entry', () => {
    const fold = foldPosition([
      leg('entry', '2', '100', '09:00:00'),
      leg('exit', '1', '140', '09:30:00'),
      leg('entry', '1', '130', '10:00:00'),
      leg('exit', '2', '155', '10:30:00'),
    ]);
    expect(fold.overExitIndex).toBe(-1);
    expect(fold.earlyFlatIndex).toBe(-1);
    expect(fold.entryQtyScaled).toBe(fold.exitQtyScaled);
  });

  it('flags an exit larger than the open position', () => {
    const fold = foldPosition([
      leg('entry', '4', '100', '09:00:00'),
      leg('exit', '6', '110', '10:15:00'),
    ]);
    expect(fold.overExitIndex).toBe(1);
  });

  it('flags a position returning to flat before the final leg', () => {
    const fold = foldPosition([
      leg('entry', '2', '100', '09:00:00'),
      leg('exit', '2', '110', '09:30:00'),
      leg('entry', '2', '105', '10:00:00'),
      leg('exit', '2', '115', '10:30:00'),
    ]);
    expect(fold.earlyFlatIndex).toBe(1);
  });
});

describe('scaleLegs — reducer', () => {
  const base = tradeWith([]);

  it('adds entry and exit legs with the kind fixed at creation and no fabricated provenance', () => {
    const withEntry = scaleLegsReducer({ ...base, legs: undefined } as RawTradeContent, { type: 'addEntry' });
    expect(withEntry.legs).toHaveLength(1);
    expect(withEntry.legs?.[0].kind).toBe('entry');
    expect(withEntry.legs?.[0].date).toBe('2026-08-10');
    expect(withEntry.legs?.[0]).not.toHaveProperty('sourceExecutionId');

    const withExit = scaleLegsReducer(withEntry, { type: 'addExit' });
    expect(withExit.legs?.map((item) => item.kind)).toEqual(['entry', 'exit']);
  });

  it('never creates sourceExecutionId, not even as undefined', () => {
    const created = createManualLeg('entry', '2026-08-10');
    expect(Object.prototype.hasOwnProperty.call(created, 'sourceExecutionId')).toBe(false);
    expect(Object.keys(created).sort()).toEqual(['date', 'kind', 'price', 'quantity', 'time']);
  });

  it('updates a single field of one leg', () => {
    const withLeg = scaleLegsReducer(base, { type: 'addEntry' });
    const updated = scaleLegsReducer(withLeg, { type: 'updateLeg', index: 0, field: 'quantity', value: '3' });
    expect(updated.legs?.[0].quantity).toBe('3');
  });

  it('removes a middle leg', () => {
    let trade = tradeWith([
      leg('entry', '1', '100', '09:00:00'),
      leg('entry', '2', '200', '09:30:00'),
      leg('exit', '3', '300', '10:00:00'),
    ]);
    trade = scaleLegsReducer(trade, { type: 'removeLeg', index: 1 });
    expect(trade.legs?.map((item) => item.price)).toEqual(['100', '300']);
  });

  it('DELETES the legs property when the last leg is removed — never legs: []', () => {
    const trade = tradeWith([leg('entry', '1', '100', '09:00:00')]);
    const cleared = scaleLegsReducer(trade, { type: 'removeLeg', index: 0 });
    expect(cleared).not.toHaveProperty('legs');
    expect(Object.prototype.hasOwnProperty.call(cleared, 'legs')).toBe(false);
    expect(cleared.legs).toBeUndefined();
    expect(JSON.stringify(cleared)).not.toContain('legs');
  });

  // ── Editing order is stable (UX repair) ──────────────────────
  // Visible rows must never move while the user is editing. Mid-edit
  // reordering, combined with index-based React keys, let a trader end
  // up typing into an already-filled row.

  it('appends new rows in the order they were added, regardless of time', () => {
    let trade = tradeWith([]);
    delete trade.legs;
    trade = scaleLegsReducer(trade, { type: 'addEntry' });
    trade = scaleLegsReducer(trade, { type: 'addExit' });
    trade = scaleLegsReducer(trade, { type: 'addEntry' });
    trade = scaleLegsReducer(trade, { type: 'addExit' });
    expect(trade.legs?.map((l) => l.kind)).toEqual(['entry', 'exit', 'entry', 'exit']);

    // Give the LAST row the EARLIEST time — it must stay last while editing.
    trade = scaleLegsReducer(trade, { type: 'updateLeg', index: 3, field: 'time', value: '08:00:00' });
    expect(trade.legs?.map((l) => l.kind)).toEqual(['entry', 'exit', 'entry', 'exit']);
    expect(trade.legs?.[3].time).toBe('08:00:00');
  });

  it('never reorders the legs array when a time is edited', () => {
    const trade = tradeWith([
      leg('entry', '1', 'A', '10:00:00'),
      leg('entry', '1', 'B', '11:00:00'),
      leg('exit', '2', 'C', '12:00:00'),
    ]);
    const edited = scaleLegsReducer(trade, { type: 'updateLeg', index: 2, field: 'time', value: '09:00:00' });
    // C is now chronologically first but must remain visually last.
    expect(edited.legs?.map((l) => l.price)).toEqual(['A', 'B', 'C']);
    expect(edited.legs?.[2].time).toBe('09:00:00');
  });

  it('exposes no reordering action at all', () => {
    const trade = tradeWith([
      leg('exit', '1', '300', '11:00:00'),
      leg('entry', '1', '100', '09:00:00'),
    ]);
    // An unknown/removed action is inert and leaves order untouched.
    const after = scaleLegsReducer(trade, { type: 'canonicalize' } as never);
    expect(after.legs?.map((item) => item.price)).toEqual(['300', '100']);
    expect(after).toBe(trade);
  });

  it('keeps calculation helpers non-mutating on the visible array', () => {
    const legs = [
      leg('exit', '2', '110', '10:00:00'),
      leg('entry', '2', '100', '09:00:00'),
    ];
    const snapshot = legs.map((l) => l.price);
    canonicalLegOrder(legs);
    foldPosition(legs);
    deriveAggregatesFromLegs(legs);
    expect(legs.map((l) => l.price)).toEqual(snapshot);
  });
});

describe('scaleLegs — candidate construction', () => {
  it('canonicalizes, derives aggregates and keeps manual legs free of provenance', () => {
    const trade = tradeWith([
      leg('exit', '2', '28980', '10:48:00'),
      leg('entry', '2', '28920', '09:32:00'),
      leg('exit', '2', '28970.50', '10:15:00'),
      leg('entry', '2', '28930', '09:41:00'),
    ]);
    const candidate = buildScaledTradeCandidate(trade);
    expect(candidate.legs?.map((item) => item.time)).toEqual([
      '09:32:00', '09:41:00', '10:15:00', '10:48:00',
    ]);
    expect(candidate.positionSize).toBe('4');
    expect(candidate.entryPrice).toBe('28925');
    expect(candidate.exitPrice).toBe('28975.25');
    expect(candidate.entryTime).toBe('09:32');
    expect(candidate.exitTime).toBe('10:48');
    for (const item of candidate.legs ?? []) {
      expect(item).not.toHaveProperty('sourceExecutionId');
    }
  });

  it('propagates the logical trade date onto every manual leg', () => {
    const trade = tradeWith([
      leg('entry', '2', '100', '09:00:00', '2026-08-10'),
      leg('exit', '2', '110', '10:00:00', '2026-08-10'),
    ]);
    const moved = buildScaledTradeCandidate({ ...trade, date: '2026-09-01' });
    expect(moved.legs?.map((item) => item.date)).toEqual(['2026-09-01', '2026-09-01']);
  });

  it('stores manual HH:mm times as HH:mm:00 without fabricating distinguishing seconds', () => {
    const trade = tradeWith([
      leg('entry', '1', '100', '09:32'),
      leg('entry', '1', '101', '09:32'),
      leg('exit', '2', '110', '10:00'),
    ]);
    const candidate = buildScaledTradeCandidate(trade);
    expect(candidate.legs?.map((item) => item.time)).toEqual(['09:32:00', '09:32:00', '10:00:00']);
    // Same-minute legs legitimately share ':00'; order alone separates them.
    expect(candidate.legs?.[0].price).toBe('100');
    expect(candidate.legs?.[1].price).toBe('101');
  });

  it('returns imported trades completely untouched', () => {
    const importedLegs: TradeLeg[] = [
      { kind: 'entry', quantity: '2', price: '28920', date: '2026-08-07', time: '09:32:14', sourceExecutionId: '1001' },
      { kind: 'exit', quantity: '2', price: '28980', date: '2026-08-07', time: '10:48:52', sourceExecutionId: '1000' },
    ];
    const trade = tradeWith(importedLegs, {
      date:             '2026-09-01',
      sourcePlatform:   'ninjatrader',
      sourceAccountId:  'Sim101',
      sourceInstrument: 'NQ 09-26',
      positionSize:     '2',
      entryPrice:       '28920',
      exitPrice:        '28980',
    });
    const candidate = buildScaledTradeCandidate(trade);

    expect(isImportedTrade(trade)).toBe(true);
    expect(hasManualLegs(trade)).toBe(false);
    // Byte-for-byte: array order preserved even though 1000 < 1001 and the
    // leg dates differ from the (changed) trade date.
    expect(candidate.legs).toEqual(importedLegs);
    expect(candidate.legs?.map((item) => item.sourceExecutionId)).toEqual(['1001', '1000']);
    expect(candidate.legs?.map((item) => item.date)).toEqual(['2026-08-07', '2026-08-07']);
    expect(candidate.legs?.map((item) => item.time)).toEqual(['09:32:14', '10:48:52']);
    expect(candidate.entryPrice).toBe('28920');
  });

  it('persists canonical chronological order even when entered out of order', () => {
    // Rows as the user built them: deliberately NOT chronological.
    const trade = tradeWith([
      leg('exit', '2', '28980', '10:48:00'),
      leg('entry', '2', '28920', '09:32:00'),
      leg('exit', '2', '28970.50', '10:15:00'),
      leg('entry', '2', '28930', '09:41:00'),
    ]);
    const candidate = buildScaledTradeCandidate(trade);
    // The candidate is canonical...
    expect(candidate.legs?.map((l) => l.time)).toEqual(['09:32:00', '09:41:00', '10:15:00', '10:48:00']);
    // ...while the edited array the user was looking at is untouched.
    expect(trade.legs?.map((l) => l.time)).toEqual(['10:48:00', '09:32:00', '10:15:00', '09:41:00']);
    // Reopening the persisted trade therefore starts from canonical order.
    expect(buildScaledTradeCandidate(candidate).legs?.map((l) => l.time))
      .toEqual(['09:32:00', '09:41:00', '10:15:00', '10:48:00']);
  });

  it('returns legless trades unchanged, preserving the v1.2 save path', () => {
    const trade = tradeWith([]);
    delete trade.legs;
    expect(buildScaledTradeCandidate(trade)).toBe(trade);
  });
});
