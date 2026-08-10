import { describe, expect, it, vi } from 'vitest';
import type { Account } from '@apptypes/account.js';
import * as pipValues from '@constants/pipValues.js';
import {
  executionProvenanceKey,
  importNinjaTrader,
  inspectNinjaTraderFiles,
  NT_PLATFORM,
} from './ninjaTraderAdapter.js';

const EXECUTION_HEADER = 'Instrument,Action,Quantity,Price,Time,ID,E/X,Position,Commission,Account,';
const TRADE_HEADER = 'Trade number,Instrument,Account,Market pos.,Qty,Entry price,Exit price,Commission,Clearing Fee,Exchange Fee,IP Fee,NFA Fee,';

type ExecutionValues = [string, string, string, string, string, string, string, string, string];
type TradeValues = [string, string, string, string, string, string, string, string, string, string, string, string];

const ex = (...values: ExecutionValues): string => `${values.slice(0, 7).join(',')},-,${values.slice(7).join(',')},`;
const tr = (...values: TradeValues): string => `${values.join(',')},`;
const csv = (header: string, rows: string[]): string => [header, ...rows].join('\r\n');

const account = (id: string): Account => ({
  id,
  name: id,
  capital: 100_000,
  color: '#000000',
  deletedAt: null,
} as Account);

const defaultExecutions = [
  ex('MNQ SEP26', 'Buy', '1', '20000.25', '8/6/2026 9:33:53 AM', '100000000001', 'Entry', '$0.50', 'SIM101'),
  ex('MNQ SEP26', 'Sell', '1', '20001.25', '8/6/2026 9:34:01 AM', '100000000002', 'Exit', '$0.50', 'SIM101'),
];
const defaultTrades = [
  tr('1', 'MNQ SEP26', 'SIM101', 'Long', '1', '20000.25', '20001.25', '$1.00', '$0.10', '$0.10', '$0.10', '$0.10'),
];

function run(
  executions = defaultExecutions,
  trades = defaultTrades,
  options: {
    existingProvenance?: ReadonlySet<string>;
    accountMap?: Record<string, string>;
    accounts?: Account[];
  } = {},
) {
  return importNinjaTrader({
    executionsCsv: csv(EXECUTION_HEADER, executions),
    tradesCsv: csv(TRADE_HEADER, trades),
    existingProvenance: options.existingProvenance ?? new Set(),
    accountMap: options.accountMap ?? { SIM101: 'journal-1' },
    accounts: options.accounts ?? [account('journal-1')],
  });
}

function expectError(result: ReturnType<typeof run>, text: RegExp): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatch(text);
}

describe('NinjaTrader adapter', () => {
  it('imports one entry and exit as one trade with two legs', () => {
    const result = run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].legs).toHaveLength(2);
    expect(result.episodeCount).toBe(1);
  });

  it('aggregates the key same-timestamp scaled Short episode and consumes Trades 8 and 9', () => {
    const executions = [
      ex('MNQ SEP26', 'Sell', '2', '29634.25', '8/6/2026 9:33:53 AM', '100000000546', 'Entry', '$0.65', 'SIM101'),
      ex('MNQ SEP26', 'Sell', '4', '29634.75', '8/6/2026 9:33:53 AM', '100000000562', 'Entry', '$1.30', 'SIM101'),
      ex('MNQ SEP26', 'Buy', '6', '29668.00', '8/6/2026 9:35:00 AM', '100000000590', 'Exit', '$1.95', 'SIM101'),
    ];
    const trades = [
      tr('8', 'MNQ SEP26', 'SIM101', 'Short', '2', '29634.25', '29668.00', '$1.30', '$1.00', '$0.50', '$0.25', '$0.25'),
      tr('9', 'MNQ SEP26', 'SIM101', 'Short', '4', '29634.75', '29668.00', '$2.60', '$2.00', '$1.00', '$0.50', '$2.00'),
    ];
    const result = run(executions, trades);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trades[0]).toMatchObject({
      direction: 'Short', positionSize: '6', entryPrice: '29634.5833333333', commission: '11.40',
    });
    expect(result.trades[0].legs).toHaveLength(3);
  });

  it('supports scale-in through separate orders', () => {
    const result = run([
      ex('MNQ SEP26', 'Buy', '1', '20000', '8/6/2026 9:00:00 AM', '100000000001', 'Entry', '$0.50', 'SIM101'),
      ex('MNQ SEP26', 'Buy', '2', '20001', '8/6/2026 9:01:00 AM', '100000000002', 'Entry', '$0.50', 'SIM101'),
      ex('MNQ SEP26', 'Sell', '3', '20002', '8/6/2026 9:02:00 AM', '100000000003', 'Exit', '$0.50', 'SIM101'),
    ], [
      tr('1', 'MNQ SEP26', 'SIM101', 'Long', '1', '20000', '20002', '$0.50', '$0', '$0', '$0', '$0'),
      tr('2', 'MNQ SEP26', 'SIM101', 'Long', '2', '20001', '20002', '$1.00', '$0', '$0', '$0', '$0'),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.trades[0].positionSize).toBe('3');
  });

  it('supports partial exits and scale-out', () => {
    const result = run([
      ex('MNQ SEP26', 'Buy', '3', '20000', '8/6/2026 9:00:00 AM', '100000000001', 'Entry', '$0.50', 'SIM101'),
      ex('MNQ SEP26', 'Sell', '1', '20001', '8/6/2026 9:01:00 AM', '100000000002', 'Exit', '$0.50', 'SIM101'),
      ex('MNQ SEP26', 'Sell', '2', '20002', '8/6/2026 9:02:00 AM', '100000000003', 'Exit', '$0.50', 'SIM101'),
    ], [
      tr('1', 'MNQ SEP26', 'SIM101', 'Long', '1', '20000', '20001', '$0.50', '$0', '$0', '$0', '$0'),
      tr('2', 'MNQ SEP26', 'SIM101', 'Long', '2', '20000', '20002', '$1.00', '$0', '$0', '$0', '$0'),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.trades[0].legs?.map((leg) => leg.kind)).toEqual(['entry', 'exit', 'exit']);
  });

  it('orders identical timestamps deterministically by execution ID when rows are shuffled', () => {
    const shuffled = [defaultExecutions[1], defaultExecutions[0]];
    const result = run(shuffled);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.trades[0].legs?.map((leg) => leg.sourceExecutionId)).toEqual(['100000000001', '100000000002']);
  });

  it('partitions multiple instruments independently', () => {
    const executions = [
      ...defaultExecutions,
      ex('MES SEP26', 'Sell', '1', '6000', '8/6/2026 10:00:00 AM', '200000000001', 'Entry', '$0.50', 'SIM101'),
      ex('MES SEP26', 'Buy', '1', '5999', '8/6/2026 10:01:00 AM', '200000000002', 'Exit', '$0.50', 'SIM101'),
    ];
    const trades = [...defaultTrades, tr('2', 'MES SEP26', 'SIM101', 'Short', '1', '6000', '5999', '$1', '$0', '$0', '$0', '$0')];
    const result = run(executions, trades);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.trades.map((trade) => trade.symbol).sort()).toEqual(['MES', 'MNQ']);
  });

  it('partitions multiple source accounts independently', () => {
    const second = defaultExecutions.map((row) => row.split('SIM101').join('SIM202'));
    const result = run([...defaultExecutions, ...second], [...defaultTrades, ...defaultTrades.map((row) => row.split('SIM101').join('SIM202'))], {
      accountMap: { SIM101: 'journal-1', SIM202: 'journal-2' },
      accounts: [account('journal-1'), account('journal-2')],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.trades).toHaveLength(2);
  });

  it('aborts when a Trades row is left over', () => {
    expectError(run(defaultExecutions, [...defaultTrades, tr('2', 'MNQ SEP26', 'SIM101', 'Long', '1', '1', '1', '$0', '$0', '$0', '$0', '$0')]), /Unconsumed Trades row/);
  });

  it('aborts when Trades quantity overshoots the episode', () => {
    expectError(run(defaultExecutions, [tr('1', 'MNQ SEP26', 'SIM101', 'Long', '2', '20000.25', '20001.25', '$1', '$0', '$0', '$0', '$0')]), /quantity overshoot/);
  });

  it('aborts on direction mismatch', () => {
    expectError(run(defaultExecutions, [defaultTrades[0].replace(',Long,', ',Short,')]), /direction/);
  });

  it('aborts both an open-at-end partition and an exit-first partition', () => {
    expectError(run([defaultExecutions[0]], []), /still open/);
    expectError(run([defaultExecutions[1]], []), /exit with no open position/);
  });

  it('aborts a reversal through zero', () => {
    expectError(run([
      ex('MNQ SEP26', 'Buy', '1', '20000', '8/6/2026 9:00:00 AM', '100000000001', 'Entry', '$0', 'SIM101'),
      ex('MNQ SEP26', 'Sell', '2', '20001', '8/6/2026 9:01:00 AM', '100000000002', 'Exit', '$0', 'SIM101'),
    ], []), /reverses through zero/);
  });

  it('sums all five fee columns across consumed rows', () => {
    const result = run(defaultExecutions, [tr('1', 'MNQ SEP26', 'SIM101', 'Long', '1', '20000.25', '20001.25', '$1.00', '$0.11', '$0.22', '$0.33', '$0.44')]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.trades[0].commission).toBe('2.10');
  });

  it('preserves a dated contract while mapping its root symbol', () => {
    const result = run();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.trades[0]).toMatchObject({ symbol: 'MNQ', sourceInstrument: 'MNQ SEP26' });
  });

  it('aborts when an allowlisted root is missing from PIP_TABLE', () => {
    const supported = vi.spyOn(pipValues, 'isSupportedSymbol').mockReturnValueOnce(false);
    expectError(run(), /missing from PIP_TABLE/);
    supported.mockRestore();
  });

  it('skips all episodes when every provenance key already exists', () => {
    const existing = new Set(defaultExecutions.map((_, index) => executionProvenanceKey(NT_PLATFORM, 'SIM101', 'MNQ SEP26', `10000000000${index + 1}`)));
    const result = run(defaultExecutions, defaultTrades, { existingProvenance: existing });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result).toMatchObject({ trades: [], skippedAlreadyImported: 1 });
  });

  it('aborts partial provenance overlap', () => {
    const existing = new Set([executionProvenanceKey(NT_PLATFORM, 'SIM101', 'MNQ SEP26', '100000000001')]);
    expectError(run(defaultExecutions, defaultTrades, { existingProvenance: existing }), /partial provenance overlap/);
  });

  it('keeps weighted-average aggregate P&L within half a cent of leg-wise gross', () => {
    const executions = [
      ex('MNQ SEP26', 'Buy', '2', '100.0001', '8/6/2026 9:00:00 AM', '100000000001', 'Entry', '$0', 'SIM101'),
      ex('MNQ SEP26', 'Buy', '1', '100.0002', '8/6/2026 9:01:00 AM', '100000000002', 'Entry', '$0', 'SIM101'),
      ex('MNQ SEP26', 'Sell', '3', '100.0101', '8/6/2026 9:02:00 AM', '100000000003', 'Exit', '$0', 'SIM101'),
    ];
    const result = run(executions, [
      tr('1', 'MNQ SEP26', 'SIM101', 'Long', '2', '100.0001', '100.0101', '$0', '$0', '$0', '$0', '$0'),
      tr('2', 'MNQ SEP26', 'SIM101', 'Long', '1', '100.0002', '100.0101', '$0', '$0', '$0', '$0', '$0'),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const trade = result.trades[0];
    const aggregateGross = (Number(trade.exitPrice) - Number(trade.entryPrice)) * Number(trade.positionSize) * 2;
    const legWiseGross = ((100.0101 * 3) - (100.0001 * 2 + 100.0002)) * 2;
    expect(Math.abs(aggregateGross - legWiseGross)).toBeLessThanOrEqual(0.005);
  });

  it('truncates seconds without rounding, including 23:59', () => {
    const first = run();
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.trades[0].entryTime).toBe('09:33');
    const late = run([
      ex('MNQ SEP26', 'Buy', '1', '1', '8/6/2026 11:59:58 PM', '100000000001', 'Entry', '$0.50', 'SIM101'),
      ex('MNQ SEP26', 'Sell', '1', '2', '8/6/2026 11:59:59 PM', '100000000002', 'Exit', '$0.50', 'SIM101'),
    ], [tr('1', 'MNQ SEP26', 'SIM101', 'Long', '1', '1', '2', '$1', '$0', '$0', '$0', '$0')]);
    expect(late.ok).toBe(true);
    if (late.ok) expect(late.trades[0].exitTime).toBe('23:59');
  });

  it('aborts overnight positions', () => {
    expectError(run([defaultExecutions[0], defaultExecutions[1].replace('8/6/2026', '8/7/2026')]), /Overnight positions are unsupported in v1.2/);
  });

  it('aborts a tampered Trades entry price', () => {
    expectError(run(defaultExecutions, [defaultTrades[0].replace('20000.25', '20000.2501')]), /Entry price reconciliation/);
  });

  it('aborts when the literal commission subtotal is off by one cent', () => {
    expectError(run(defaultExecutions, [defaultTrades[0].replace('$1.00', '$0.99')]), /Commission reconciliation/);
  });

  it('compares prices and commissions as exact scaled integers', () => {
    expectError(run(defaultExecutions, [defaultTrades[0].replace('20000.25', '20000.2501')]), /10\^4-scaled/);
    expectError(run(defaultExecutions, [defaultTrades[0].replace('$1.00', '$1.01')]), /integer cents/);
  });

  it('orders variable-length 11, 12, and 13 digit execution IDs with BigInt', () => {
    const executions = [
      ex('MNQ SEP26', 'Sell', '1', '3', '8/6/2026 9:02:00 AM', '1000000000000', 'Exit', '$0', 'SIM101'),
      ex('MNQ SEP26', 'Buy', '1', '2', '8/6/2026 9:01:00 AM', '100000000000', 'Entry', '$0', 'SIM101'),
      ex('MNQ SEP26', 'Buy', '1', '1', '8/6/2026 9:00:00 AM', '10000000000', 'Entry', '$0', 'SIM101'),
      ex('MNQ SEP26', 'Sell', '1', '3', '8/6/2026 9:03:00 AM', '1000000000001', 'Exit', '$0', 'SIM101'),
    ];
    const result = run(executions, [tr('1', 'MNQ SEP26', 'SIM101', 'Long', '2', '1.5', '3', '$0', '$0', '$0', '$0', '$0')]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.trades[0].legs?.map((leg) => leg.sourceExecutionId)).toEqual([
      '10000000000', '100000000000', '1000000000000', '1000000000001',
    ]);
  });

  it('aborts a non-numeric execution ID', () => {
    expectError(run([defaultExecutions[0].replace('100000000001', 'ABC'), defaultExecutions[1]], defaultTrades), /non-numeric execution ID/);
  });

  it('aborts when ID order contradicts chronological Time order', () => {
    expectError(run([
      defaultExecutions[0].replace('9:33:53 AM', '9:35:53 AM'),
      defaultExecutions[1].replace('9:34:01 AM', '9:34:01 AM'),
    ]), /contradicts chronological Time order/);
  });

  it('treats the same execution IDs under different source accounts as distinct', () => {
    const secondExecutions = defaultExecutions.map((row) => row.split('SIM101').join('SIM202'));
    const secondTrades = defaultTrades.map((row) => row.split('SIM101').join('SIM202'));
    const existing = new Set(defaultExecutions.map((_, index) => executionProvenanceKey(NT_PLATFORM, 'SIM101', 'MNQ SEP26', `10000000000${index + 1}`)));
    const result = run([...defaultExecutions, ...secondExecutions], [...defaultTrades, ...secondTrades], {
      existingProvenance: existing,
      accountMap: { SIM101: 'journal-1', SIM202: 'journal-2' },
      accounts: [account('journal-1'), account('journal-2')],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result).toMatchObject({ skippedAlreadyImported: 1, trades: [{ sourceAccountId: 'SIM202' }] });
  });

  it('accepts MNQ/NQ/ES/MES and aborts the whole import for GC', () => {
    for (const root of ['MNQ', 'NQ', 'ES', 'MES']) {
      const executions = defaultExecutions.map((row) => row.split('MNQ SEP26').join(`${root} SEP26`));
      const trades = defaultTrades.map((row) => row.split('MNQ SEP26').join(`${root} SEP26`));
      expect(run(executions, trades).ok).toBe(true);
    }
    expectError(run([
      ...defaultExecutions,
      ex('GC SEP26', 'Buy', '1', '3000', '8/6/2026 10:00:00 AM', '200000000001', 'Entry', '$0', 'SIM101'),
    ], defaultTrades), /unsupported instrument "GC SEP26"/);
  });

  it('inspects exact headers and returns sorted unique accounts and full instruments', () => {
    const result = inspectNinjaTraderFiles(
      csv(EXECUTION_HEADER, [...defaultExecutions, defaultExecutions[0].replace('SIM101', 'AAA').replace('MNQ SEP26', 'ES DEC26')]),
      csv(TRADE_HEADER, defaultTrades),
    );
    expect(result).toEqual({ ok: true, inspection: { sourceAccounts: ['AAA', 'SIM101'], instruments: ['ES DEC26', 'MNQ SEP26'] } });
  });
});
