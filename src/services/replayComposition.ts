import { createHistoricalBarReader, type HistoricalBarReader } from './historicalBarReader.js';
import { openMarketDataDb } from './marketDataDb.js';
import { commitImport, createIndexedDbChunkSource, type CommitImportInput } from './marketDataStore.js';
import { computeSourceChecksumSha256, normalizeExpiry, parseNinjaTraderHistorical } from './ninjaTraderHistoricalAdapter.js';
import { createReplayRuntime, type ReplayRuntime, type ReplayRuntimeDependencies } from './replayRuntime.js';
import type { IndexedDbHandle } from './indexedDb.js';
import type { IndexedDbResult } from './indexedDb.js';
import type { ReplayImportRequest, ReplayImportResult } from '@apptypes/replay.js';

export interface ReplayComposition {
  runtime: ReplayRuntime;
  importNinjaTrader(request: ReplayImportRequest): Promise<ReplayImportResult>;
}

export interface ReplayCompositionPorts {
  openMarketDataDb?: () => Promise<IndexedDbResult<IndexedDbHandle>>;
  commitImport?: typeof commitImport;
}

export function createReplayComposition(
  host: Omit<ReplayRuntimeDependencies, 'openReader'> = {},
  ports: ReplayCompositionPorts = {},
): ReplayComposition {
  const openDb = ports.openMarketDataDb ?? openMarketDataDb;
  const commit = ports.commitImport ?? commitImport;
  let handlePromise: Promise<IndexedDbHandle> | null = null;
  let readerPromise: Promise<HistoricalBarReader> | null = null;
  function openHandle(): Promise<IndexedDbHandle> {
    if (handlePromise === null) {
      handlePromise = openDb().then((result) => {
        if (result.kind === 'failure') throw new Error(result.error.message);
        return result.value;
      });
    }
    return handlePromise;
  }
  function openReader(): Promise<HistoricalBarReader> {
    if (readerPromise === null) readerPromise = openHandle().then((handle) => createHistoricalBarReader(createIndexedDbChunkSource(handle)));
    return readerPromise;
  }
  const runtime = createReplayRuntime({
    ...host,
    openReader,
  });

  return {
    runtime,
    async importNinjaTrader(request) {
      const expiry = normalizeExpiry(request.expiryText);
      if (expiry === null) return { ok: false, message: 'Contract expiry must use MM-YY notation.' };
      const parsed = parseNinjaTraderHistorical(request.text, {
        source: 'ninjatrader', root: request.root, expiryText: request.expiryText,
        timeframe: '1m', dataType: 'Last', sourceTimeZone: 'UTC', sourceTimestampConvention: 'end-of-bar',
      });
      if (!parsed.ok) return { ok: false, message: parsed.error };
      const checksum = await computeSourceChecksumSha256(request.text);
      if (checksum === null) return { ok: false, message: 'SHA-256 is unavailable; the import was not started.' };
      const input: CommitImportInput = {
        series: parsed.series, bars: parsed.bars, sourceRowCount: parsed.sourceRowCount,
        warnings: parsed.warnings, source: 'ninjatrader', dataType: 'Last', sourceTimeZone: 'UTC',
        sourceTimestampConvention: 'end-of-bar', sourceChecksumSha256: checksum, importedAt: Date.now(),
      };
      return runtime.runImport(parsed.series, async () => {
        const result = await commit(await openHandle(), input);
        return result.ok
          ? { ok: true, message: `Imported ${result.summary.barsAdded} new bars (${result.summary.barCount} total).` }
          : { ok: false, reason: result.reason, message: result.message ?? result.reason };
      }).then((result) => ({ ok: result.ok, message: result.message ?? (result.ok ? 'Import complete.' : result.reason) }));
    },
  };
}
