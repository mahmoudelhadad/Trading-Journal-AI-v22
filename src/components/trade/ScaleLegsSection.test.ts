/**
 * components/trade/ScaleLegsSection.test.ts
 *
 * Dependency-free component coverage.
 *
 * The project's harness is Node-only (vitest.config.ts sets
 * `environment: 'node'`) with no jsdom, no happy-dom and no Testing
 * Library, and its `include` glob is `src/**\/*.test.ts` — a `.test.tsx`
 * file would be collected by nothing and silently pass. So this file is
 * `.ts`, builds elements with `React.createElement` instead of JSX, and
 * renders through `react-dom/server`, which is already a direct
 * dependency. No new dependency and no config change.
 *
 * Scope: rendered STRUCTURE only. DOM event wiring (clicking + Add
 * Entry, typing into a leg, collapsing the section) is deliberately out
 * of reach here and is covered by runtime acceptance. All the decision
 * logic behind those events lives in calculations/scaleLegs.ts and is
 * exhaustively unit-tested there.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RawTradeContent, TradeLeg } from '@apptypes/trade.js';
import { ScaleLegsSection } from './ScaleLegsSection.js';

const manualLegs: TradeLeg[] = [
  { kind: 'entry', quantity: '2', price: '28920', date: '2026-08-10', time: '09:32:00' },
  { kind: 'entry', quantity: '2', price: '28930', date: '2026-08-10', time: '09:41:00' },
  { kind: 'exit', quantity: '2', price: '28970.50', date: '2026-08-10', time: '10:15:00' },
  { kind: 'exit', quantity: '2', price: '28980', date: '2026-08-10', time: '10:48:00' },
];

const importedLegs: TradeLeg[] = [
  { kind: 'entry', quantity: '2', price: '28920', date: '2026-08-07', time: '09:32:14', sourceExecutionId: '1001' },
  { kind: 'exit', quantity: '2', price: '28980', date: '2026-08-07', time: '10:48:52', sourceExecutionId: '1002' },
];

const makeTrade = (overrides: Partial<RawTradeContent> = {}): RawTradeContent => ({
  ...({
    _tid: 1, market: 'futures', symbol: 'NQ', date: '2026-08-10', direction: 'Long',
    positionSize: '4', entryPrice: '28925', exitPrice: '28975.25',
    entryTime: '09:32', exitTime: '10:48',
  } as unknown as RawTradeContent),
  ...overrides,
});

const render = (trade: RawTradeContent, error: string | null = null): string =>
  renderToStaticMarkup(
    React.createElement(ScaleLegsSection, { trade, onChange: () => undefined, error }),
  );

describe('ScaleLegsSection — collapsed default', () => {
  it('renders the frozen collapsed label for a legless trade', () => {
    const trade = makeTrade();
    delete trade.legs;
    const markup = render(trade);
    expect(markup).toContain('SCALE IN / OUT (Optional)');
    expect(markup).toContain('▸');
  });

  it('shows no leg editor, add buttons or summary while collapsed', () => {
    const trade = makeTrade();
    delete trade.legs;
    const markup = render(trade);
    expect(markup).not.toContain('+ Add Entry');
    expect(markup).not.toContain('+ Add Exit');
    expect(markup).not.toContain('ENTRY');
    expect(markup).not.toContain('Entry qty');
  });
});

describe('ScaleLegsSection — manual expanded state', () => {
  it('auto-expands a saved scaled trade and shows the leg count', () => {
    const markup = render(makeTrade({ legs: manualLegs }));
    expect(markup).toContain('▾');
    expect(markup).toContain('4 legs');
    expect(markup).not.toContain('(Optional)');
  });

  it('marks each row with an immutable ENTRY / EXIT badge', () => {
    const markup = render(makeTrade({ legs: manualLegs }));
    expect(markup).toContain('ENTRY');
    expect(markup).toContain('EXIT');
  });

  it('has NO type dropdown — kind is fixed by which add button created the row', () => {
    const markup = render(makeTrade({ legs: manualLegs }));
    expect(markup).not.toContain('<select');
    expect(markup).toContain('+ Add Entry');
    expect(markup).toContain('+ Add Exit');
  });

  it('summarises with "Entry qty" and never with peak-exposure wording', () => {
    const markup = render(makeTrade({ legs: manualLegs }));
    expect(markup).toContain('Entry qty 4');
    expect(markup).toContain('Avg entry 28925');
    expect(markup).toContain('Avg exit 28975.25');
    expect(markup).not.toContain('Max size');
    expect(markup).not.toContain('Peak');
    expect(markup).not.toContain('peak');
  });

  it('explains aggregate ownership exactly once, not per field', () => {
    const markup = render(makeTrade({ legs: manualLegs }));
    const sentence = 'Size, entry, exit and times above are set by these legs.';
    expect(markup).toContain(sentence);
    expect(markup.split(sentence)).toHaveLength(2);
    expect(markup).not.toContain('from legs');
  });

  it('replaces the summary with the validation message when one is supplied', () => {
    const markup = render(
      makeTrade({ legs: manualLegs }),
      'exit quantity exceeds the open position at 10:15.',
    );
    expect(markup).toContain('exit quantity exceeds the open position at 10:15.');
    expect(markup).not.toContain('Entry qty 4');
  });

  it('shows a live derived summary rather than the stale stored aggregates', () => {
    // Stored aggregates say 4 @ 28925; the current legs say 2 @ 28900.
    const markup = render(makeTrade({
      legs: [
        { kind: 'entry', quantity: '2', price: '28900', date: '2026-08-10', time: '09:32:00' },
        { kind: 'exit', quantity: '2', price: '28950', date: '2026-08-10', time: '10:00:00' },
      ],
    }));
    expect(markup).toContain('Entry qty 2');
    expect(markup).toContain('Avg entry 28900');
    expect(markup).not.toContain('Entry qty 4');
  });
});

describe('ScaleLegsSection — imported NinjaTrader mode', () => {
  const importedTrade = makeTrade({
    legs:             importedLegs,
    date:             '2026-08-07',
    positionSize:     '2',
    entryPrice:       '28920',
    exitPrice:        '28980',
    sourcePlatform:   'ninjatrader',
    sourceAccountId:  'Sim101',
    sourceInstrument: 'NQ 09-26',
  });

  it('auto-expands and flags the imported, read-only origin', () => {
    const markup = render(importedTrade);
    expect(markup).toContain('▾');
    expect(markup).toContain('2 legs');
    expect(markup).toContain('Imported from NinjaTrader');
    expect(markup).toContain('read-only');
    expect(markup).toContain('Broker execution detail cannot be edited here.');
  });

  it('offers no add, remove or edit controls', () => {
    const markup = render(importedTrade);
    expect(markup).not.toContain('+ Add Entry');
    expect(markup).not.toContain('+ Add Exit');
    expect(markup).not.toContain('✕');
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('<select');
  });

  it('preserves full HH:mm:ss broker seconds in the display', () => {
    const markup = render(importedTrade);
    expect(markup).toContain('09:32:14');
    expect(markup).toContain('10:48:52');
  });

  it('shows the broker-reconciled aggregates without recomputing them', () => {
    const markup = render(importedTrade);
    expect(markup).toContain('Entry qty 2');
    expect(markup).toContain('Avg entry 28920');
    expect(markup).toContain('Avg exit 28980');
    expect(markup).not.toContain('Max size');
  });
});
