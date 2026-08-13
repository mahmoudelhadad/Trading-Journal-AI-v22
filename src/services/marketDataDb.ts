/**
 * services/marketDataDb.ts
 *
 * B1 — the historical market-data database's identity.
 *
 * A SEPARATE IndexedDB database, not a new object store inside the
 * Journal database. That choice is the whole reason B1 requires no
 * Journal migration: `trading-journal-ai` keeps its version and its six
 * stores, the resolver is untouched, the sync spec is not reopened, and
 * rollback is "delete this database" rather than a schema downgrade.
 *
 * It reuses services/indexedDb.ts's generic primitive UNMODIFIED. That
 * file is already parameterized on name/version/stores, already
 * registers the mandatory `onversionchange` self-close handler, already
 * surfaces `onblocked` informationally, and already classifies
 * `quota_exceeded` distinctly. B1 adds a new CALLER, not a new
 * primitive.
 *
 * NO INDEXES, deliberately. Every access path is a primary-key `get()`,
 * or a read of the small `series` store. `bar_chunks` is never scanned:
 * a range read is pure key computation followed by one `get()` per
 * chunk. An index would have no reader, and creating one would require
 * changing the frozen primitive.
 */

import { openIndexedDb, type IndexedDbHandle, type IndexedDbResult, type IndexedDbStoreSpec } from './indexedDb.js';

export const MARKET_DATA_DB_NAME = 'trading-journal-ai-marketdata';
export const MARKET_DATA_DB_VERSION = 1;

export const MARKET_DATA_STORE_NAMES = {
  SERIES:     'series',
  BAR_CHUNKS: 'bar_chunks',
} as const;

export const MARKET_DATA_STORES: readonly IndexedDbStoreSpec[] = [
  { name: MARKET_DATA_STORE_NAMES.SERIES,     keyPath: 'seriesId' },
  { name: MARKET_DATA_STORE_NAMES.BAR_CHUNKS, keyPath: 'chunkId' },
];

/**
 * Origin-wide exclusive lock name for every market-data mutation.
 * One global lock rather than per-series: imports are infrequent and
 * manual, a full cache clear needs global exclusion anyway, and a
 * single lock removes lock-ordering and deadlock entirely.
 */
export const MARKET_DATA_MUTATION_LOCK = 'trading-journal-ai-marketdata:mutation';

/**
 * FROZEN, FAIL-SAFE ORDER: manifests are cleared BEFORE chunk payload.
 *
 * The reverse order is unsafe — if the second clear fails, every
 * manifest is still visible while its chunks are gone, and previously
 * readable series start reporting integrity failures. Clearing
 * manifests first means a failure leaves nothing visible and nothing
 * reachable, and re-running finishes the job.
 */
export const CLEAR_STORE_ORDER = [
  MARKET_DATA_STORE_NAMES.SERIES,
  MARKET_DATA_STORE_NAMES.BAR_CHUNKS,
] as const;

export interface OpenMarketDataDbOptions {
  onVersionChangeForcedClose?: () => void;
  onBlocked?: () => void;
}

/** Open (creating if necessary) the historical market-data database. */
export function openMarketDataDb(
  options: OpenMarketDataDbOptions = {},
): Promise<IndexedDbResult<IndexedDbHandle>> {
  return openIndexedDb({
    name:    MARKET_DATA_DB_NAME,
    version: MARKET_DATA_DB_VERSION,
    stores:  MARKET_DATA_STORES,
    onVersionChangeForcedClose: options.onVersionChangeForcedClose,
    onBlocked:                  options.onBlocked,
  });
}
