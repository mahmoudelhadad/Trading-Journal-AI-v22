import { describe, expect, it } from 'vitest';
import { beginAuthoritativeOperation, beginSession, canCommitAuthoritative, canCommitPrefetch, capturePrefetchAuthority, createAuthority, disposeAuthority, enterImportBarrier, invalidateSession, markCommitted, replaceWindow, settleImportBarrier } from './replayAuthority.js';

describe('replay authority', () => {
  it('rejects late A after B starts and commits', () => {
    const a = createAuthority(); const tokenA = beginAuthoritativeOperation(a)!; const tokenB = beginAuthoritativeOperation(a)!;
    expect(markCommitted(a, tokenB)).toEqual({ ok: true });
    expect(canCommitAuthoritative(a, tokenA)).toEqual({ ok: false, reason: 'superseded' });
  });
  it('rejects prefetch after window replacement', () => {
    const a = createAuthority(); const token = capturePrefetchAuthority(a)!; replaceWindow(a);
    expect(canCommitPrefetch(a, token)).toEqual({ ok: false, reason: 'stale_window' });
  });
  it('rejects a prior session after import invalidation', () => {
    const a = createAuthority(); const token = beginAuthoritativeOperation(a)!; enterImportBarrier(a);
    expect(canCommitAuthoritative(a, token)).toEqual({ ok: false, reason: 'barrier' });
  });
  it('separates token kinds and makes authoritative commits single-use', () => {
    const a = createAuthority(); const prefetch = capturePrefetchAuthority(a)!;
    expect(canCommitAuthoritative(a, prefetch)).toEqual({ ok: false, reason: 'wrong_kind' });
    const token = beginAuthoritativeOperation(a)!; expect(markCommitted(a, token)).toEqual({ ok: true });
    expect(markCommitted(a, token)).toEqual({ ok: false, reason: 'already_committed' });
  });
  it('allows current prefetch for buffer only', () => {
    const a = createAuthority(); expect(canCommitPrefetch(a, capturePrefetchAuthority(a)!)).toEqual({ ok: true });
  });
  it('handles nested barriers and establishes only on 1 to 0', () => {
    const a = createAuthority(); enterImportBarrier(a); enterImportBarrier(a);
    expect(settleImportBarrier(a)).toBe(false); expect(a.barrierDepth).toBe(1);
    expect(settleImportBarrier(a)).toBe(true); expect(a.barrierDepth).toBe(0);
  });
  it('invalidates generations safely', () => {
    const a = createAuthority(); const token = beginAuthoritativeOperation(a)!; beginSession(a);
    expect(canCommitAuthoritative(a, token).ok).toBe(false);
  });
  it('throws instead of wrapping an authoritative op past MAX_SAFE_INTEGER', () => {
    const a = createAuthority();
    a.op = Number.MAX_SAFE_INTEGER - 1;
    a.lastCommittedOp = Number.MAX_SAFE_INTEGER - 1;
    const finalToken = beginAuthoritativeOperation(a)!;
    expect(markCommitted(a, finalToken)).toEqual({ ok: true });
    expect(a.lastCommittedOp).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => beginAuthoritativeOperation(a)).toThrowError(/generation exhausted/);
    expect(a.op).toBe(Number.MAX_SAFE_INTEGER);
    expect(a.lastCommittedOp).toBe(Number.MAX_SAFE_INTEGER);
  });
  it.each([
    ['session', (a: ReturnType<typeof createAuthority>) => beginSession(a), 'session'],
    ['window during beginSession', (a: ReturnType<typeof createAuthority>) => beginSession(a), 'window'],
    ['op during beginSession', (a: ReturnType<typeof createAuthority>) => beginSession(a), 'op'],
    ['window during replaceWindow', (a: ReturnType<typeof createAuthority>) => replaceWindow(a), 'window'],
    ['op during replaceWindow', (a: ReturnType<typeof createAuthority>) => replaceWindow(a), 'op'],
  ] as const)('saturates atomically for %s', (_label, transition, saturatedField) => {
    const a = createAuthority();
    a[saturatedField] = Number.MAX_SAFE_INTEGER;
    const before = { ...a };
    expect(() => transition(a)).toThrowError(/generation exhausted/);
    expect(a).toEqual(before);
  });
  it('keeps barrier entry atomic when invalidation saturates', () => {
    const a = createAuthority(); a.session = Number.MAX_SAFE_INTEGER;
    expect(() => enterImportBarrier(a)).toThrowError(/generation exhausted/);
    expect(a.barrierDepth).toBe(0);
  });
  it('keeps barrier settlement atomic when invalidation saturates', () => {
    const a = createAuthority(); enterImportBarrier(a); a.window = Number.MAX_SAFE_INTEGER;
    expect(() => settleImportBarrier(a)).toThrowError(/generation exhausted/);
    expect(a.barrierDepth).toBe(1);
  });
  it('applies saturation to explicit invalidation and disposal transitions', () => {
    const invalidated = createAuthority(); invalidated.op = Number.MAX_SAFE_INTEGER;
    expect(() => invalidateSession(invalidated)).toThrowError(/generation exhausted/);
    const disposed = createAuthority(); disposed.session = Number.MAX_SAFE_INTEGER;
    expect(() => disposeAuthority(disposed)).toThrowError(/generation exhausted/);
  });
});
