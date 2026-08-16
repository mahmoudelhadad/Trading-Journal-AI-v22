import { DAY_MS, MINUTE_MS, type HistoricalBar, type HistoricalSeriesIdentity } from '@apptypes/marketData.js';
import type { HistoricalBarReader } from './historicalBarReader.js';
import { type ReplayCanonicalCaptureResult, type ReplaySnapshot, type ReplayTimeframe } from '@apptypes/replay.js';
import type { BacktestSessionSeries, ExecutionFill } from '@apptypes/backtestSession.js';
import { deriveReplayBars } from '@calculations/htfDerivation.js';
import { isReplaySpeed, projectReplayCursor } from '@calculations/replayClock.js';
import { mergeBarsInsertIfAbsent, revealClosedBars } from '@calculations/replayReveal.js';
import {
  beginAuthoritativeOperation, canCommitAuthoritative, canCommitPrefetch,
  capturePrefetchAuthority, createAuthority, enterImportBarrier, markCommitted,
  replaceWindow, settleImportBarrier, type AuthorityToken,
} from '@calculations/replayAuthority.js';

const INITIAL_DAYS = 2;
const EXTENSION_DAYS = 1;
const RETENTION_DAYS = 5;
const PREFETCH_TRIGGER_MS = 30 * MINUTE_MS;

export interface ReplayRuntimeDependencies {
  openReader: () => Promise<HistoricalBarReader>;
  monotonicNow?: () => number;
  requestFrame?: (callback: (time: number) => void) => number;
  cancelFrame?: (id: number) => void;
  visibility?: {
    isHidden: () => boolean;
    add: (listener: () => void) => void;
    remove: (listener: () => void) => void;
  };
}

export type ReplayMutationResult =
  | { ok: true; message?: string }
  | { ok: false; reason: string; message?: string };

export interface ReplayRuntime {
  attach(): void;
  detach(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): ReplaySnapshot;
  selectSeries(series: HistoricalSeriesIdentity): void;
  resumeSession(series: HistoricalSeriesIdentity, cursorUtcMs: number): Promise<boolean>;
  setTimeframe(timeframe: ReplayTimeframe): void;
  setSpeed(speed: number): boolean;
  play(): void;
  pause(): void;
  goTo(utcMs: number): Promise<void>;
  stepForward(): Promise<void>;
  runImport(series: HistoricalSeriesIdentity, mutation: () => Promise<ReplayMutationResult>): Promise<ReplayMutationResult>;
  beginExecutionCommand(series: BacktestSessionSeries): ReplayCanonicalCaptureResult & ({ ok: true; fill: ExecutionFill } | { ok: false });
  beginCompletionCommand(series: BacktestSessionSeries): ReplayCanonicalCaptureResult;
  releaseCanonicalCommand(): void;
  setSessionSafetyBlock(blocked: boolean): void;
  setSessionMutationBlocked(blocked: boolean): void;
  setSessionSeriesLock(series: HistoricalSeriesIdentity | null): void;
}

function utcDayStart(utcMs: number): number { return Math.floor(utcMs / DAY_MS) * DAY_MS; }

export function createReplayRuntime(deps: ReplayRuntimeDependencies): ReplayRuntime {
  const authority = createAuthority();
  const buffer = new Map<number, HistoricalBar>();
  const listeners = new Set<() => void>();
  const perfNow = deps.monotonicNow ?? (() => performance.now());
  const requestFrame = deps.requestFrame ?? ((cb) => requestAnimationFrame(cb));
  const cancelFrame = deps.cancelFrame ?? ((id) => cancelAnimationFrame(id));
  const visibility = deps.visibility ?? {
    isHidden: () => document.hidden,
    add: (listener) => document.addEventListener('visibilitychange', listener),
    remove: (listener) => document.removeEventListener('visibilitychange', listener),
  };

  let reader: HistoricalBarReader | null = null;
  let attached = false;
  let attachEpoch = 0;
  let pendingReestablish = true;
  let frameId: number | null = null;
  let resumeAfterVisibility = false;
  let activePrefetch: { edgeUtcMs: number } | null = null;
  let completedPrefetchEdgeUtcMs: number | null = null;
  let sessionSafetyBlocked = false;
  let sessionMutationBlocked = false;
  let sessionSeriesLock: HistoricalSeriesIdentity | null = null;
  let state: ReplaySnapshot = {
    series: { root: 'NQ', expiryYear: new Date().getUTCFullYear(), expiryMonth: 3, timeframe: '1m' },
    nowUtcMs: Date.now(), speed: 1, timeframe: '1m', playState: 'paused', bars: [],
    availability: { available: false }, coverageStartUtcMs: null, coverageEndUtcMs: null,
    loading: false, importing: false, error: null, canonicalBarrier: null,
  };
  let anchor = { cursorUtcMs: state.nowUtcMs, perfMs: 0, speed: state.speed };

  function publish(patch: Partial<ReplaySnapshot> = {}): void {
    state = { ...state, ...patch };
    const revealed = revealClosedBars(
      buffer.values(), state.nowUtcMs,
      state.coverageStartUtcMs ?? Number.NEGATIVE_INFINITY,
      state.coverageEndUtcMs ?? Number.POSITIVE_INFINITY,
    );
    state = { ...state, bars: deriveReplayBars(revealed, state.timeframe) };
    if (attached) listeners.forEach((listener) => listener());
  }

  function reanchor(): void {
    anchor = { cursorUtcMs: state.nowUtcMs, perfMs: perfNow(), speed: state.speed };
  }

  function seriesMatches(series: BacktestSessionSeries): boolean {
    return state.series.root === series.root && state.series.expiryYear === series.expiryYear
      && state.series.expiryMonth === series.expiryMonth && state.series.timeframe === series.timeframe;
  }

  function allowedBySessionSeries(series: HistoricalSeriesIdentity): boolean {
    return sessionSeriesLock === null || (sessionSeriesLock.root === series.root
      && sessionSeriesLock.expiryYear === series.expiryYear && sessionSeriesLock.expiryMonth === series.expiryMonth
      && sessionSeriesLock.timeframe === series.timeframe);
  }

  function settleAndPause(): void {
    if (state.playState === 'playing' && !visibility.isHidden()) {
      const projected = projectReplayCursor(anchor, perfNow());
      const end = state.availability.available && state.availability.observedLastUtcMs !== undefined
        ? state.availability.observedLastUtcMs + MINUTE_MS : projected;
      state = { ...state, nowUtcMs: Math.min(projected, end), playState: 'paused' };
    } else if (state.playState !== 'paused') state = { ...state, playState: 'paused' };
    resumeAfterVisibility = false;
    reanchor();
  }

  function beginCanonical(kind: 'action' | 'completion', series: BacktestSessionSeries, fillRequired: boolean): ReplayCanonicalCaptureResult {
    if (state.canonicalBarrier !== null) return { ok: false, reason: 'command_pending' };
    if (sessionSafetyBlocked || sessionMutationBlocked) return { ok: false, reason: 'not_ready' };
    settleAndPause();
    publish();
    if (!attached || state.loading || state.importing || state.error !== null) return { ok: false, reason: 'not_ready' };
    if (!seriesMatches(series)) return { ok: false, reason: 'series_mismatch' };
    const progress = { cursorUtcMs: state.nowUtcMs, displayTimeframe: state.timeframe, speed: state.speed } as const;
    if (!fillRequired) {
      publish({ canonicalBarrier: kind });
      return { ok: true, progress };
    }
    const candidates = [...buffer.values()].filter((bar) => bar.t + MINUTE_MS <= state.nowUtcMs)
      .sort((a, b) => b.t - a.t);
    const source = candidates[0];
    if (source === undefined) return { ok: false, reason: 'no_closed_bar' };
    const ageMs = state.nowUtcMs - (source.t + MINUTE_MS);
    if (ageMs < 0 || ageMs >= MINUTE_MS) return { ok: false, reason: 'stale_quote' };
    const fill: ExecutionFill = {
      decisionUtcMs: state.nowUtcMs, sourceBarStartUtcMs: source.t,
      sourceBarCloseUtcMs: source.t + MINUTE_MS, price: source.c, basis: 'revealed_1m_close',
    };
    publish({ canonicalBarrier: kind });
    return { ok: true, progress, fill };
  }

  function lifecycleCurrent(epoch: number): boolean { return attached && attachEpoch === epoch; }

  async function getReader(): Promise<HistoricalBarReader> {
    if (reader === null) reader = await deps.openReader();
    return reader;
  }

  function classifyAbort(token: AuthorityToken, epoch: number): 'barrier' | 'superseded' | 'lifecycle' | null {
    if (authority.barrierDepth > 0) return 'barrier';
    const decision = canCommitAuthoritative(authority, token);
    if (!decision.ok) return 'superseded';
    if (!lifecycleCurrent(epoch)) return 'lifecycle';
    return null;
  }

  function abortReestablish(reason: 'barrier' | 'superseded' | 'lifecycle'): void {
    if (reason === 'barrier') pendingReestablish = true;
    if (reason === 'lifecycle') {
      pendingReestablish = true;
      requestReestablish();
    }
  }

  async function startReestablish(targetUtcMs?: number, targetSeries: HistoricalSeriesIdentity = state.series): Promise<boolean> {
    if (!attached) { pendingReestablish = true; return false; }
    resumeAfterVisibility = false;
    pendingReestablish = false;
    const epoch = attachEpoch;
    const token = beginAuthoritativeOperation(authority);
    if (token === null) { pendingReestablish = true; return false; }
    publish({ loading: true, error: null });
    let opened: HistoricalBarReader;
    try { opened = await getReader(); }
    catch {
      const reason = classifyAbort(token, epoch);
      if (reason !== null) abortReestablish(reason);
      else publish({ loading: false, playState: 'paused', error: 'Market-data storage could not be opened.' });
      return false;
    }
    let aborted = classifyAbort(token, epoch);
    if (aborted !== null) { abortReestablish(aborted); return false; }
    let availability;
    try { availability = await opened.getLocalAvailability(targetSeries); }
    catch {
      const reason = classifyAbort(token, epoch);
      if (reason !== null) abortReestablish(reason);
      else publish({ loading: false, playState: 'paused', error: 'Historical availability could not be read.' });
      return false;
    }
    aborted = classifyAbort(token, epoch);
    if (aborted !== null) { abortReestablish(aborted); return false; }

    let cursor = targetUtcMs ?? state.nowUtcMs;
    if (availability.available && state.coverageStartUtcMs === null && targetUtcMs === undefined
      && (cursor < availability.observedFirstUtcMs || cursor > availability.observedLastUtcMs + MINUTE_MS)) {
      cursor = availability.observedFirstUtcMs + MINUTE_MS;
    }
    const fromUtcMs = utcDayStart(cursor);
    const toUtcMs = fromUtcMs + INITIAL_DAYS * DAY_MS;
    let result;
    try { result = await opened.readBars({ series: targetSeries, fromUtcMs, toUtcMs }); }
    catch {
      const reason = classifyAbort(token, epoch);
      if (reason !== null) abortReestablish(reason);
      else publish({ loading: false, playState: 'paused', error: 'Historical bars could not be read.' });
      return false;
    }
    aborted = classifyAbort(token, epoch);
    if (aborted !== null) { abortReestablish(aborted); return false; }
    const decision = markCommitted(authority, token);
    if (!decision.ok) return false;
    if (!result.ok) {
      publish({ loading: false, playState: 'paused', error: result.reason === 'series_unavailable'
        ? 'This historical series is unavailable.' : result.message,
        availability: availability.available ? availability : { available: false } });
      return false;
    }
    buffer.clear();
    activePrefetch = null;
    completedPrefetchEdgeUtcMs = null;
    mergeBarsInsertIfAbsent(buffer, result.bars);
    reanchor();
    publish({ series: targetSeries, nowUtcMs: cursor, loading: false, error: null, playState: 'paused',
      coverageStartUtcMs: fromUtcMs, coverageEndUtcMs: toUtcMs,
      availability: availability.available ? availability : { available: false } });
    return true;
  }

  function requestReestablish(): void {
    if (!pendingReestablish || !attached || authority.barrierDepth > 0) return;
    void startReestablish();
  }

  async function extendCoverage(resumePlayback = false): Promise<boolean> {
    if (state.coverageEndUtcMs === null || authority.barrierDepth > 0 || !attached) return false;
    const epoch = attachEpoch;
    const token = beginAuthoritativeOperation(authority);
    if (token === null) return false;
    const fromUtcMs = state.coverageEndUtcMs;
    const toUtcMs = fromUtcMs + EXTENSION_DAYS * DAY_MS;
    let opened: HistoricalBarReader;
    try { opened = await getReader(); }
    catch {
      if (classifyAbort(token, epoch) === null) publish({ playState: 'paused', error: 'Market-data storage could not be opened.' });
      return false;
    }
    let aborted = classifyAbort(token, epoch);
    if (aborted !== null) return false;
    let result;
    try { result = await opened.readBars({ series: state.series, fromUtcMs, toUtcMs }); }
    catch {
      if (classifyAbort(token, epoch) === null) publish({ playState: 'paused', error: 'Historical bars could not be read.' });
      return false;
    }
    aborted = classifyAbort(token, epoch);
    if (aborted !== null) return false;
    if (!result.ok || !markCommitted(authority, token).ok) {
      if (!result.ok) publish({ playState: 'paused', error: result.reason === 'series_unavailable' ? 'This historical series is unavailable.' : result.message });
      return false;
    }
    mergeBarsInsertIfAbsent(buffer, result.bars);
    publish({ coverageEndUtcMs: toUtcMs, playState: resumePlayback ? 'playing' : state.playState });
    if (resumePlayback) reanchor();
    return true;
  }

  async function prefetch(): Promise<void> {
    if (activePrefetch !== null || state.coverageEndUtcMs === null || completedPrefetchEdgeUtcMs === state.coverageEndUtcMs
      || authority.barrierDepth > 0 || !attached) return;
    const token = capturePrefetchAuthority(authority);
    if (token === null) return;
    const epoch = attachEpoch;
    const fromUtcMs = state.coverageEndUtcMs;
    const toUtcMs = fromUtcMs + EXTENSION_DAYS * DAY_MS;
    const attempt = { edgeUtcMs: fromUtcMs };
    activePrefetch = attempt;
    try {
      const opened = await getReader();
      if (activePrefetch !== attempt || authority.barrierDepth > 0
        || !canCommitPrefetch(authority, token).ok || !lifecycleCurrent(epoch)) return;
      const result = await opened.readBars({ series: state.series, fromUtcMs, toUtcMs });
      if (activePrefetch === attempt && result.ok && authority.barrierDepth === 0
        && canCommitPrefetch(authority, token).ok && lifecycleCurrent(epoch)) {
        mergeBarsInsertIfAbsent(buffer, result.bars); // buffer-only: coverage/view never advances
        completedPrefetchEdgeUtcMs = fromUtcMs;
      }
    } catch {
      // Prefetch is speculative and buffer-only. An authoritative read
      // owns any user-visible storage failure and retry decision.
    } finally {
      if (activePrefetch === attempt) activePrefetch = null;
    }
  }

  function evict(): void {
    const floor = utcDayStart(state.nowUtcMs) - RETENTION_DAYS * DAY_MS;
    for (const t of buffer.keys()) if (t < floor) buffer.delete(t);
  }

  function onFrame(): void {
    frameId = null;
    if (!attached) return;
    if (state.playState === 'playing' && !visibility.isHidden() && authority.barrierDepth === 0) {
      let cursor = projectReplayCursor(anchor, perfNow());
      const end = state.availability.available && state.availability.observedLastUtcMs !== undefined
        ? state.availability.observedLastUtcMs + MINUTE_MS : null;
      if (end !== null && cursor >= end) {
        cursor = end; publish({ nowUtcMs: cursor, playState: 'ended' }); reanchor();
      } else if (state.coverageEndUtcMs !== null && cursor >= state.coverageEndUtcMs) {
        publish({ nowUtcMs: state.coverageEndUtcMs, playState: 'paused' }); reanchor(); void extendCoverage(true);
      } else {
        publish({ nowUtcMs: cursor }); evict();
        if (state.coverageEndUtcMs !== null && state.coverageEndUtcMs - cursor <= PREFETCH_TRIGGER_MS) void prefetch();
      }
    }
    frameId = requestFrame(onFrame);
  }

  function onVisibility(): void {
    if (visibility.isHidden()) {
      if (state.playState === 'playing' && authority.barrierDepth === 0
        && !state.loading && !state.importing && state.error === null) {
        resumeAfterVisibility = true;
        publish({ playState: 'paused' });
      }
      reanchor();
      return;
    }
    const shouldResume = resumeAfterVisibility && attached && state.playState === 'paused'
      && authority.barrierDepth === 0 && !state.loading && !state.importing && state.error === null;
    resumeAfterVisibility = false;
    reanchor();
    if (shouldResume) publish({ playState: 'playing' });
  }

  return {
    attach() {
      if (attached) return;
      attachEpoch += 1; attached = true;
      visibility.add(onVisibility);
      reanchor();
      frameId = requestFrame(onFrame);
      if (visibility.isHidden()) onVisibility();
      requestReestablish();
    },
    detach() {
      if (!attached) return;
      attachEpoch += 1; attached = false;
      resumeAfterVisibility = false;
      activePrefetch = null;
      visibility.remove(onVisibility);
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot() { return state; },
    selectSeries(series) {
      if (state.canonicalBarrier !== null || sessionSafetyBlocked || !allowedBySessionSeries(series)) return;
      replaceWindow(authority);
      activePrefetch = null;
      completedPrefetchEdgeUtcMs = null;
      pendingReestablish = false;
      void startReestablish(undefined, series);
    },
    async resumeSession(series, cursorUtcMs) {
      if (state.canonicalBarrier !== null || sessionSafetyBlocked || !allowedBySessionSeries(series) || !Number.isSafeInteger(cursorUtcMs)) return false;
      replaceWindow(authority);
      activePrefetch = null;
      completedPrefetchEdgeUtcMs = null;
      pendingReestablish = false;
      return startReestablish(cursorUtcMs, series);
    },
    setTimeframe(timeframe) { if (state.canonicalBarrier === null && !sessionSafetyBlocked) publish({ timeframe }); },
    setSpeed(speed) { if (state.canonicalBarrier !== null || sessionSafetyBlocked || !isReplaySpeed(speed)) return false; publish({ speed }); reanchor(); return true; },
    play() { if (state.canonicalBarrier !== null || sessionSafetyBlocked || authority.barrierDepth > 0 || state.loading || state.error !== null) return; resumeAfterVisibility = false; publish({ playState: 'playing' }); reanchor(); },
    pause() { resumeAfterVisibility = false; publish({ playState: 'paused' }); reanchor(); },
    async goTo(utcMs) { if (state.canonicalBarrier !== null || sessionSafetyBlocked || !Number.isSafeInteger(utcMs)) return; await startReestablish(utcMs); },
    async stepForward() {
      if (state.canonicalBarrier !== null || sessionSafetyBlocked) return;
      resumeAfterVisibility = false;
      const findNext = () => [...buffer.values()]
        .filter((b) => b.t + MINUTE_MS > state.nowUtcMs
          && state.coverageEndUtcMs !== null && b.t < state.coverageEndUtcMs)
        .sort((a, b) => a.t - b.t)[0];
      let next = findNext();
      while (next === undefined && state.availability.available && state.availability.observedLastUtcMs !== undefined
        && (state.coverageEndUtcMs ?? 0) <= state.availability.observedLastUtcMs) {
        if (!await extendCoverage()) break;
        next = findNext();
      }
      if (next !== undefined) { publish({ nowUtcMs: next.t + MINUTE_MS, playState: 'paused' }); reanchor(); }
    },
    async runImport(series, mutation) {
      if (state.canonicalBarrier !== null || sessionSafetyBlocked || !allowedBySessionSeries(series)) return { ok: false, reason: 'command_pending', message: 'A Replay session command is still being saved or owns another series.' };
      resumeAfterVisibility = false;
      enterImportBarrier(authority);
      buffer.clear();
      activePrefetch = null;
      completedPrefetchEdgeUtcMs = null;
      publish({ importing: true, playState: 'paused', error: null });
      reanchor();
      let result: ReplayMutationResult;
      try {
        result = await mutation();
        if (result.ok) state = { ...state, series };
      }
      catch { result = { ok: false, reason: 'write_failed', message: 'The historical import failed unexpectedly.' }; }
      finally {
        const usable = settleImportBarrier(authority);
        if (usable) { pendingReestablish = true; requestReestablish(); }
      }
      publish({ importing: authority.barrierDepth > 0, error: result.ok ? null : (result.message ?? result.reason) });
      return result;
    },
    beginExecutionCommand(series) {
      return beginCanonical('action', series, true) as ReplayCanonicalCaptureResult & ({ ok: true; fill: ExecutionFill } | { ok: false });
    },
    beginCompletionCommand(series) { return beginCanonical('completion', series, false); },
    releaseCanonicalCommand() { if (state.canonicalBarrier !== null) publish({ canonicalBarrier: null }); },
    setSessionSafetyBlock(blocked) { sessionSafetyBlocked = blocked; if (blocked) { settleAndPause(); publish(); } },
    setSessionMutationBlocked(blocked) { sessionMutationBlocked = blocked; },
    setSessionSeriesLock(series) { sessionSeriesLock = series === null ? null : { ...series }; },
  };
}
