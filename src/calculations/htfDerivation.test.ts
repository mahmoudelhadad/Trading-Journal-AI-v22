import { describe, expect, it } from 'vitest';
import { deriveReplayBars } from './htfDerivation.js';
import type { HistoricalBar } from '@apptypes/marketData.js';

const bar = (t: number, p: number, v = 1): HistoricalBar => ({ t, o: p, h: p + 2, l: p - 2, c: p + 1, v });

describe('HTF derivation', () => {
  it.each([['5m', 300_000], ['15m', 900_000], ['1h', 3_600_000]] as const)('folds %s on UTC epoch buckets', (tf, bucket) => {
    const result = deriveReplayBars([bar(bucket + 60_000, 10, 2), bar(bucket + 180_000, 20, 3)], tf);
    expect(result).toEqual([{ t: bucket, o: 10, h: 22, l: 8, c: 21, v: 5 }]);
  });
  it('does not synthesize missing minutes or empty buckets', () => {
    expect(deriveReplayBars([bar(0, 10), bar(240_000, 20)], '5m')).toHaveLength(1);
    expect(deriveReplayBars([bar(0, 10), bar(600_000, 20)], '5m').map((b) => b.t)).toEqual([0, 600_000]);
  });
});
