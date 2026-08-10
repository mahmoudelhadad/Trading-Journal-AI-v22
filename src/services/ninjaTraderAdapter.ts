import { isSupportedSymbol } from '@constants/pipValues.js';
import type { Account } from '@apptypes/account.js';
import { createEmptyTrade } from '@apptypes/trade.js';
import type { RawTradeContent, TradeLeg } from '@apptypes/trade.js';
import { parseFileContent } from './importService.js';
import { validateTradeContent } from './tradeValidation.js';

export const NT_SUPPORTED_ROOTS = ['NQ', 'ES', 'MNQ', 'MES'] as const;
export const NT_PLATFORM = 'ninjatrader';

const EXECUTION_HEADERS = [
  'Instrument', 'Action', 'Quantity', 'Price', 'Time', 'ID', 'E/X', 'Commission', 'Account',
] as const;
const TRADE_HEADERS = [
  'Trade number', 'Instrument', 'Account', 'Market pos.', 'Qty', 'Entry price', 'Exit price',
  'Commission', 'Clearing Fee', 'Exchange Fee', 'IP Fee', 'NFA Fee',
] as const;
const PRICE_SCALE = 10_000n;
const PROVENANCE_SEPARATOR = '\u0000';

type Failure = { ok: false; error: string };
type Direction = 'Long' | 'Short';
type LegKind = 'entry' | 'exit';

interface ParsedTable {
  headers: Map<string, number>;
  rows: string[][];
}

interface Execution {
  account: string;
  instrument: string;
  action: 'Buy' | 'Sell';
  quantity: bigint;
  price: string;
  scaledPrice: bigint;
  timestamp: string;
  date: string;
  time: string;
  id: string;
  declaredKind: 'Entry' | 'Exit';
  commissionCents: bigint;
  rowNumber: number;
}

interface Episode {
  account: string;
  instrument: string;
  direction: Direction;
  executions: Array<Execution & { kind: LegKind }>;
  entryQuantity: bigint;
  entryValue: bigint;
  exitValue: bigint;
  executionCommissionCents: bigint;
}

interface TradeRow {
  account: string;
  instrument: string;
  tradeNumber: string;
  direction: string;
  quantity: bigint;
  entryValue: bigint;
  exitValue: bigint;
  commissionCents: bigint;
  totalFeesCents: bigint;
  rowNumber: number;
}

export function executionProvenanceKey(
  platform: string,
  sourceAccountId: string,
  sourceInstrument: string,
  sourceExecutionId: string,
): string {
  return [platform, sourceAccountId, sourceInstrument, sourceExecutionId].join(PROVENANCE_SEPARATOR);
}

export interface NinjaTraderInspection {
  sourceAccounts: string[];
  instruments: string[];
}

export function inspectNinjaTraderFiles(
  executionsCsv: string,
  tradesCsv: string,
): { ok: true; inspection: NinjaTraderInspection } | Failure {
  try {
    const executions = parseTable(executionsCsv, 'Executions', EXECUTION_HEADERS);
    if (!executions.ok) return executions;
    const trades = parseTable(tradesCsv, 'Trades', TRADE_HEADERS);
    if (!trades.ok) return trades;

    const sourceAccounts = new Set<string>();
    const instruments = new Set<string>();
    collectInspectionValues(executions.table, sourceAccounts, instruments);
    collectInspectionValues(trades.table, sourceAccounts, instruments);
    return {
      ok: true,
      inspection: {
        sourceAccounts: [...sourceAccounts].sort(),
        instruments: [...instruments].sort(),
      },
    };
  } catch (error) {
    return failure('NinjaTrader inspection failed', error);
  }
}

export interface NinjaTraderImportInput {
  executionsCsv: string;
  tradesCsv: string;
  accountMap: Record<string, string>;
  existingProvenance: ReadonlySet<string>;
  accounts: Account[];
}

export interface NinjaTraderImportSuccess {
  ok: true;
  trades: RawTradeContent[];
  episodeCount: number;
  skippedAlreadyImported: number;
}

export function importNinjaTrader(input: NinjaTraderImportInput): NinjaTraderImportSuccess | Failure {
  try {
    const executionTable = parseTable(input.executionsCsv, 'Executions', EXECUTION_HEADERS);
    if (!executionTable.ok) return executionTable;
    const tradeTable = parseTable(input.tradesCsv, 'Trades', TRADE_HEADERS);
    if (!tradeTable.ok) return tradeTable;

    const parsedExecutions = parseExecutions(executionTable.table);
    if (!parsedExecutions.ok) return parsedExecutions;
    const parsedTrades = parseTrades(tradeTable.table);
    if (!parsedTrades.ok) return parsedTrades;

    const episodes = buildEpisodes(parsedExecutions.executions);
    if (!episodes.ok) return episodes;
    const reconciled = reconcileEpisodes(episodes.episodes, parsedTrades.trades);
    if (!reconciled.ok) return reconciled;

    const imported: RawTradeContent[] = [];
    let skippedAlreadyImported = 0;
    for (const item of reconciled.items) {
      const { episode, consumed } = item;
      const accountId = input.accountMap[episode.account];
      if (!accountId) {
        return { ok: false, error: `Account mapping is missing for NinjaTrader account "${episode.account}".` };
      }

      const keys = episode.executions.map((execution) => executionProvenanceKey(
        NT_PLATFORM, episode.account, episode.instrument, execution.id,
      ));
      const present = keys.filter((key) => input.existingProvenance.has(key)).length;
      if (present === keys.length) {
        skippedAlreadyImported++;
        continue;
      }
      if (present !== 0) {
        return {
          ok: false,
          error: `Episode for ${episode.account} / ${episode.instrument} has partial provenance overlap (${present} of ${keys.length} executions).`,
        };
      }

      const trade = episodeToTrade(episode, consumed, accountId);
      const validationErrors = validateTradeContent(trade, input.accounts, { requireIdentity: true });
      if (validationErrors.length) {
        return {
          ok: false,
          error: `Final validation failed for ${episode.account} / ${episode.instrument}: ${validationErrors[0]}`,
        };
      }
      imported.push(trade);
    }

    return {
      ok: true,
      trades: imported,
      episodeCount: episodes.episodes.length,
      skippedAlreadyImported,
    };
  } catch (error) {
    return failure('NinjaTrader import failed', error);
  }
}

function parseTable<const T extends readonly string[]>(
  csv: string,
  fileName: string,
  requiredHeaders: T,
): { ok: true; table: ParsedTable } | Failure {
  const parsed = parseFileContent(csv);
  if (!parsed.length) return { ok: false, error: `${fileName} file is empty.` };
  const rawHeaders = parsed[0];
  const headers = new Map<string, number>();
  rawHeaders.forEach((header, index) => {
    if (header !== '' && !headers.has(header)) headers.set(header, index);
  });
  const missing = requiredHeaders.filter((header) => !headers.has(header));
  if (missing.length) {
    return { ok: false, error: `${fileName} file is missing required header${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.` };
  }
  return { ok: true, table: { headers, rows: parsed.slice(1) } };
}

function collectInspectionValues(
  table: ParsedTable,
  accounts: Set<string>,
  instruments: Set<string>,
): void {
  for (const row of table.rows) {
    const account = cell(table, row, 'Account');
    const instrument = cell(table, row, 'Instrument');
    if (account) accounts.add(account);
    if (instrument) instruments.add(instrument);
  }
}

function cell(table: ParsedTable, row: string[], header: string): string {
  return row[table.headers.get(header) ?? -1] ?? '';
}

function parseExecutions(table: ParsedTable): { ok: true; executions: Execution[] } | Failure {
  const executions: Execution[] = [];
  for (let index = 0; index < table.rows.length; index++) {
    const row = table.rows[index];
    const rowNumber = index + 2;
    const instrument = cell(table, row, 'Instrument');
    const account = cell(table, row, 'Account');
    if (!instrument || !account) {
      return { ok: false, error: `Executions row ${rowNumber} has a blank ${!instrument ? 'Instrument' : 'Account'}.` };
    }
    const rootError = validateInstrument(instrument, `Executions row ${rowNumber}`);
    if (rootError) return rootError;

    const action = cell(table, row, 'Action');
    if (action !== 'Buy' && action !== 'Sell') {
      return { ok: false, error: `Executions row ${rowNumber} for ${instrument} has invalid Action "${action}"; expected Buy or Sell.` };
    }
    const quantity = parsePositiveInteger(cell(table, row, 'Quantity'));
    if (quantity === null) {
      return { ok: false, error: `Executions row ${rowNumber} for ${instrument} has a non-positive or non-integer Quantity.` };
    }
    const id = cell(table, row, 'ID');
    if (!/^\d+$/.test(id)) {
      return { ok: false, error: `Executions row ${rowNumber} for ${instrument} has non-numeric execution ID "${id}".` };
    }
    const declaredKind = cell(table, row, 'E/X');
    if (declaredKind !== 'Entry' && declaredKind !== 'Exit') {
      return { ok: false, error: `Executions row ${rowNumber} for ${instrument} has invalid E/X "${declaredKind}"; expected Entry or Exit.` };
    }
    const parsedTimestamp = parseTimestamp(cell(table, row, 'Time'));
    if (!parsedTimestamp) {
      return { ok: false, error: `Executions row ${rowNumber} for ${instrument} has invalid Time "${cell(table, row, 'Time')}".` };
    }
    const price = parseScaledDecimal(cell(table, row, 'Price'), 4);
    if (!price || price.scaled <= 0n) {
      return { ok: false, error: `Executions row ${rowNumber} for ${instrument} has invalid Price "${cell(table, row, 'Price')}".` };
    }
    const commissionCents = parseCurrencyCents(cell(table, row, 'Commission'));
    if (commissionCents === null) {
      return { ok: false, error: `Executions row ${rowNumber} for ${instrument} has invalid Commission "${cell(table, row, 'Commission')}".` };
    }
    executions.push({
      account, instrument, action, quantity, price: price.normalized, scaledPrice: price.scaled,
      timestamp: parsedTimestamp.timestamp, date: parsedTimestamp.date, time: parsedTimestamp.time,
      id, declaredKind, commissionCents, rowNumber,
    });
  }
  return { ok: true, executions };
}

function parseTrades(table: ParsedTable): { ok: true; trades: TradeRow[] } | Failure {
  const trades: TradeRow[] = [];
  for (let index = 0; index < table.rows.length; index++) {
    const row = table.rows[index];
    const rowNumber = index + 2;
    const instrument = cell(table, row, 'Instrument');
    const account = cell(table, row, 'Account');
    if (!instrument || !account) {
      return { ok: false, error: `Trades row ${rowNumber} has a blank ${!instrument ? 'Instrument' : 'Account'}.` };
    }
    const rootError = validateInstrument(instrument, `Trades row ${rowNumber}`);
    if (rootError) return rootError;

    const tradeNumber = cell(table, row, 'Trade number');
    if (!/^\d+$/.test(tradeNumber)) {
      return { ok: false, error: `Trades row ${rowNumber} for ${instrument} has invalid Trade number "${tradeNumber}".` };
    }
    const quantity = parsePositiveInteger(cell(table, row, 'Qty'));
    if (quantity === null) {
      return { ok: false, error: `Trades row ${rowNumber} for ${instrument} has a non-positive or non-integer Qty.` };
    }
    const entryPrice = parseScaledDecimal(cell(table, row, 'Entry price'), 4);
    const exitPrice = parseScaledDecimal(cell(table, row, 'Exit price'), 4);
    if (!entryPrice || entryPrice.scaled <= 0n) {
      return { ok: false, error: `Trades row ${rowNumber} for ${instrument} has invalid Entry price.` };
    }
    if (!exitPrice || exitPrice.scaled <= 0n) {
      return { ok: false, error: `Trades row ${rowNumber} for ${instrument} has invalid Exit price.` };
    }
    const moneyHeaders = ['Commission', 'Clearing Fee', 'Exchange Fee', 'IP Fee', 'NFA Fee'] as const;
    const money = moneyHeaders.map((header) => parseCurrencyCents(cell(table, row, header)));
    const invalidMoney = money.findIndex((value) => value === null);
    if (invalidMoney !== -1) {
      const header = moneyHeaders[invalidMoney];
      return { ok: false, error: `Trades row ${rowNumber} for ${instrument} has invalid ${header} "${cell(table, row, header)}".` };
    }
    const cents = money as bigint[];
    trades.push({
      account,
      instrument,
      tradeNumber,
      direction: cell(table, row, 'Market pos.'),
      quantity,
      entryValue: entryPrice.scaled * quantity,
      exitValue: exitPrice.scaled * quantity,
      commissionCents: cents[0],
      totalFeesCents: cents.reduce((sum, value) => sum + value, 0n),
      rowNumber,
    });
  }
  return { ok: true, trades };
}

function buildEpisodes(executions: Execution[]): { ok: true; episodes: Episode[] } | Failure {
  const partitions = groupByPartition(executions);
  const episodes: Episode[] = [];
  for (const partition of partitions.values()) {
    partition.sort((left, right) => compareDigitStrings(left.id, right.id));
    for (let index = 1; index < partition.length; index++) {
      if (partition[index - 1].id === partition[index].id) {
        return { ok: false, error: `Duplicate execution ID ${partition[index].id} in ${partition[index].account} / ${partition[index].instrument}.` };
      }
      if (partition[index - 1].timestamp > partition[index].timestamp) {
        return {
          ok: false,
          error: `Execution ID order contradicts chronological Time order in ${partition[index].account} / ${partition[index].instrument} at ID ${partition[index].id}.`,
        };
      }
    }

    let position = 0n;
    let current: Episode | null = null;
    for (const execution of partition) {
      const signed = execution.action === 'Buy' ? execution.quantity : -execution.quantity;
      if (position === 0n) {
        if (execution.declaredKind === 'Exit') {
          return { ok: false, error: `Executions row ${execution.rowNumber} for ${execution.instrument} is an exit with no open position.` };
        }
        current = {
          account: execution.account,
          instrument: execution.instrument,
          direction: signed > 0n ? 'Long' : 'Short',
          executions: [],
          entryQuantity: 0n,
          entryValue: 0n,
          exitValue: 0n,
          executionCommissionCents: 0n,
        };
      }
      if (!current) return { ok: false, error: `Internal episode state failed for ${execution.instrument}.` };
      const nextPosition = position + signed;
      if (position !== 0n && nextPosition !== 0n && ((position > 0n) !== (nextPosition > 0n))) {
        return { ok: false, error: `Execution ID ${execution.id} reverses through zero in ${execution.account} / ${execution.instrument}.` };
      }
      const kind: LegKind = current.direction === 'Long'
        ? (signed > 0n ? 'entry' : 'exit')
        : (signed < 0n ? 'entry' : 'exit');
      if (execution.declaredKind.toLowerCase() !== kind) {
        return {
          ok: false,
          error: `Executions row ${execution.rowNumber} for ${execution.instrument} declares ${execution.declaredKind} but position accounting computes ${kind}.`,
        };
      }
      current.executions.push({ ...execution, kind });
      if (kind === 'entry') {
        current.entryQuantity += execution.quantity;
        current.entryValue += execution.scaledPrice * execution.quantity;
      } else {
        current.exitValue += execution.scaledPrice * execution.quantity;
      }
      current.executionCommissionCents += execution.commissionCents;
      position = nextPosition;
      if (position === 0n) {
        const firstEntry = current.executions.find((leg) => leg.kind === 'entry');
        const finalExit = [...current.executions].reverse().find((leg) => leg.kind === 'exit');
        if (!firstEntry || !finalExit) {
          return { ok: false, error: `Episode in ${current.account} / ${current.instrument} has incomplete entry/exit legs.` };
        }
        if (firstEntry.date !== finalExit.date) {
          return { ok: false, error: `Overnight positions are unsupported in v1.2 (${current.account} / ${current.instrument}, ${firstEntry.date} to ${finalExit.date}).` };
        }
        episodes.push(current);
        current = null;
      }
    }
    if (position !== 0n || current) {
      const sample = partition[0];
      return { ok: false, error: `Position is still open at end of Executions for ${sample.account} / ${sample.instrument}.` };
    }
  }
  episodes.sort((left, right) => compareDigitStrings(left.executions[0].id, right.executions[0].id));
  return { ok: true, episodes };
}

function reconcileEpisodes(
  episodes: Episode[],
  trades: TradeRow[],
): { ok: true; items: Array<{ episode: Episode; consumed: TradeRow[] }> } | Failure {
  const tradePartitions = groupByPartition(trades);
  for (const partition of tradePartitions.values()) {
    partition.sort((left, right) => compareDigitStrings(left.tradeNumber, right.tradeNumber));
  }
  const cursors = new Map<string, number>();
  const items: Array<{ episode: Episode; consumed: TradeRow[] }> = [];
  for (const episode of episodes) {
    const key = partitionKey(episode.account, episode.instrument);
    const partition = tradePartitions.get(key) ?? [];
    let cursor = cursors.get(key) ?? 0;
    let quantity = 0n;
    const consumed: TradeRow[] = [];
    while (quantity < episode.entryQuantity && cursor < partition.length) {
      const row = partition[cursor++];
      consumed.push(row);
      quantity += row.quantity;
      if (quantity > episode.entryQuantity) {
        return { ok: false, error: `Trades quantity overshoot at row ${row.rowNumber} for ${episode.account} / ${episode.instrument}.` };
      }
    }
    if (quantity < episode.entryQuantity) {
      return { ok: false, error: `Trades rows ran out for episode in ${episode.account} / ${episode.instrument}; expected quantity ${episode.entryQuantity}.` };
    }
    if (consumed.some((row) => row.direction !== episode.direction)) {
      const row = consumed.find((candidate) => candidate.direction !== episode.direction)!;
      return { ok: false, error: `Trades row ${row.rowNumber} direction "${row.direction}" does not match ${episode.direction} for ${episode.instrument}.` };
    }
    const tradeEntryValue = consumed.reduce((sum, row) => sum + row.entryValue, 0n);
    if (tradeEntryValue !== episode.entryValue) {
      return { ok: false, error: `Entry price reconciliation failed for ${episode.account} / ${episode.instrument} using integer 10^4-scaled values.` };
    }
    const tradeExitValue = consumed.reduce((sum, row) => sum + row.exitValue, 0n);
    if (tradeExitValue !== episode.exitValue) {
      return { ok: false, error: `Exit price reconciliation failed for ${episode.account} / ${episode.instrument} using integer 10^4-scaled values.` };
    }
    const tradeCommission = consumed.reduce((sum, row) => sum + row.commissionCents, 0n);
    if (tradeCommission !== episode.executionCommissionCents) {
      return { ok: false, error: `Commission reconciliation failed for ${episode.account} / ${episode.instrument}: Executions and Trades differ in integer cents.` };
    }
    cursors.set(key, cursor);
    items.push({ episode, consumed });
  }

  for (const [key, partition] of tradePartitions) {
    const cursor = cursors.get(key) ?? 0;
    if (cursor < partition.length) {
      const row = partition[cursor];
      return { ok: false, error: `Unconsumed Trades row ${row.rowNumber} remains for ${row.account} / ${row.instrument}.` };
    }
  }
  return { ok: true, items };
}

function episodeToTrade(episode: Episode, consumed: TradeRow[], accountId: string): RawTradeContent {
  const firstEntry = episode.executions.find((leg) => leg.kind === 'entry')!;
  const finalExit = [...episode.executions].reverse().find((leg) => leg.kind === 'exit')!;
  const root = instrumentRoot(episode.instrument);
  const legs: TradeLeg[] = episode.executions.map((execution) => ({
    kind: execution.kind,
    quantity: execution.quantity.toString(),
    price: execution.price,
    date: execution.date,
    time: execution.time,
    sourceExecutionId: execution.id,
  }));
  const totalFees = consumed.reduce((sum, row) => sum + row.totalFeesCents, 0n);
  return {
    ...createEmptyTrade(accountId),
    _tid: Date.now() + Math.random(),
    market: 'futures',
    symbol: root,
    accountId,
    direction: episode.direction,
    positionSize: episode.entryQuantity.toString(),
    entryPrice: formatWeightedAverage(episode.entryValue, episode.entryQuantity),
    exitPrice: formatWeightedAverage(episode.exitValue, episode.entryQuantity),
    commission: formatCents(totalFees),
    date: firstEntry.date,
    entryTime: firstEntry.time.slice(0, 5),
    exitTime: finalExit.time.slice(0, 5),
    legs,
    sourceInstrument: episode.instrument,
    sourcePlatform: NT_PLATFORM,
    sourceAccountId: episode.account,
  };
}

function validateInstrument(instrument: string, location: string): Failure | null {
  const root = instrumentRoot(instrument);
  if (!(NT_SUPPORTED_ROOTS as readonly string[]).includes(root)) {
    return { ok: false, error: `${location} has unsupported instrument "${instrument}"; supported roots are ${NT_SUPPORTED_ROOTS.join(', ')}.` };
  }
  if (!isSupportedSymbol(root)) {
    return { ok: false, error: `${location} instrument "${instrument}" has root "${root}" missing from PIP_TABLE.` };
  }
  return null;
}

function instrumentRoot(instrument: string): string {
  const space = instrument.indexOf(' ');
  return space === -1 ? instrument : instrument.slice(0, space);
}

function parseTimestamp(value: string): { date: string; time: string; timestamp: string } | null {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour < 1 || hour > 12 || minute > 59 || second > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  if (match[7] === 'AM') hour = hour === 12 ? 0 : hour;
  else hour = hour === 12 ? 12 : hour + 12;
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const time = `${String(hour).padStart(2, '0')}:${match[5]}:${match[6]}`;
  return { date, time, timestamp: `${date} ${time}` };
}

function parsePositiveInteger(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed > 0n ? parsed : null;
}

function parseScaledDecimal(value: string, decimals: number): { scaled: bigint; normalized: string } | null {
  const match = value.match(/^\+?(\d+)(?:\.(\d+))?$/);
  if (!match || (match[2]?.length ?? 0) > decimals) return null;
  const fraction = (match[2] ?? '').padEnd(decimals, '0');
  const scaled = BigInt(match[1]) * (10n ** BigInt(decimals)) + BigInt(fraction || '0');
  const normalizedFraction = (match[2] ?? '').replace(/0+$/, '');
  return { scaled, normalized: normalizedFraction ? `${match[1]}.${normalizedFraction}` : match[1] };
}

function parseCurrencyCents(value: string): bigint | null {
  let text = value.trim();
  let negative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith('$')) text = text.slice(1);
  text = text.replace(/,/g, '');
  const match = text.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return negative ? -cents : cents;
}

function formatCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function formatWeightedAverage(value: bigint, quantity: bigint): string {
  const integerPart = value / (quantity * PRICE_SCALE);
  let remainder = value % (quantity * PRICE_SCALE);
  if (remainder === 0n) return integerPart.toString();
  let fraction = '';
  for (let index = 0; index < 10 && remainder !== 0n; index++) {
    remainder *= 10n;
    const digit = remainder / (quantity * PRICE_SCALE);
    fraction += digit.toString();
    remainder %= quantity * PRICE_SCALE;
  }
  return `${integerPart}.${fraction.replace(/0+$/, '')}`;
}

function compareDigitStrings(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function partitionKey(account: string, instrument: string): string {
  return `${account}${PROVENANCE_SEPARATOR}${instrument}`;
}

function groupByPartition<T extends { account: string; instrument: string }>(items: T[]): Map<string, T[]> {
  const partitions = new Map<string, T[]>();
  for (const item of items) {
    const key = partitionKey(item.account, item.instrument);
    const partition = partitions.get(key) ?? [];
    partition.push(item);
    partitions.set(key, partition);
  }
  return partitions;
}

function failure(prefix: string, error: unknown): Failure {
  return { ok: false, error: `${prefix}: ${error instanceof Error ? error.message : String(error)}` };
}
