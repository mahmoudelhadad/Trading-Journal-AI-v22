import type { HistoricalRoot } from '@apptypes/marketData.js';

export const FUTURES_METADATA_VERSION = 1 as const;

export interface FuturesInstrumentMetadata {
  readonly metadataVersion: typeof FUTURES_METADATA_VERSION;
  readonly root: HistoricalRoot;
  readonly tickSize: number;
  readonly pointValue: number;
  readonly tickValue: number;
}

export const FUTURES_INSTRUMENTS: Readonly<Record<HistoricalRoot, FuturesInstrumentMetadata>> = Object.freeze({
  NQ: Object.freeze({ metadataVersion: 1, root: 'NQ', tickSize: 0.25, pointValue: 20, tickValue: 5 }),
  ES: Object.freeze({ metadataVersion: 1, root: 'ES', tickSize: 0.25, pointValue: 50, tickValue: 12.5 }),
});

export function getFuturesInstrument(root: HistoricalRoot): FuturesInstrumentMetadata {
  return FUTURES_INSTRUMENTS[root];
}
