export interface Authority {
  session: number;
  window: number;
  op: number;
  lastCommittedOp: number;
  barrierDepth: number;
}

export type AuthorityToken =
  | { kind: 'authoritative'; session: number; window: number; op: number }
  | { kind: 'prefetch'; session: number; window: number };

export type CommitDecision =
  | { ok: true }
  | { ok: false; reason: 'barrier' | 'wrong_kind' | 'stale_session' | 'stale_window' | 'superseded' | 'already_committed' };

function bump(value: number): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Replay authority generation exhausted Number.MAX_SAFE_INTEGER.');
  }
  return value + 1;
}

export function createAuthority(): Authority {
  return { session: 1, window: 1, op: 0, lastCommittedOp: -1, barrierDepth: 0 };
}

export function beginSession(a: Authority): void {
  const session = bump(a.session);
  const window = bump(a.window);
  const op = bump(a.op);
  a.session = session; a.window = window; a.op = op; a.lastCommittedOp = -1;
}

export function invalidateSession(a: Authority): void { beginSession(a); }
export function replaceWindow(a: Authority): void {
  const window = bump(a.window);
  const op = bump(a.op);
  a.window = window; a.op = op;
}

export function beginAuthoritativeOperation(a: Authority): AuthorityToken | null {
  if (a.barrierDepth > 0) return null;
  a.op = bump(a.op);
  return { kind: 'authoritative', session: a.session, window: a.window, op: a.op };
}

export function capturePrefetchAuthority(a: Authority): AuthorityToken | null {
  return a.barrierDepth > 0 ? null : { kind: 'prefetch', session: a.session, window: a.window };
}

export function canCommitAuthoritative(a: Authority, token: AuthorityToken): CommitDecision {
  if (a.barrierDepth > 0) return { ok: false, reason: 'barrier' };
  if (token.kind !== 'authoritative') return { ok: false, reason: 'wrong_kind' };
  if (token.session !== a.session) return { ok: false, reason: 'stale_session' };
  if (token.window !== a.window) return { ok: false, reason: 'stale_window' };
  if (token.op !== a.op) return { ok: false, reason: 'superseded' };
  if (token.op <= a.lastCommittedOp) return { ok: false, reason: 'already_committed' };
  return { ok: true };
}

export function canCommitPrefetch(a: Authority, token: AuthorityToken): CommitDecision {
  if (a.barrierDepth > 0) return { ok: false, reason: 'barrier' };
  if (token.kind !== 'prefetch') return { ok: false, reason: 'wrong_kind' };
  if (token.session !== a.session) return { ok: false, reason: 'stale_session' };
  if (token.window !== a.window) return { ok: false, reason: 'stale_window' };
  return { ok: true };
}

export function markCommitted(a: Authority, token: AuthorityToken): CommitDecision {
  const decision = canCommitAuthoritative(a, token);
  if (decision.ok && token.kind === 'authoritative') a.lastCommittedOp = token.op;
  return decision;
}

export function enterImportBarrier(a: Authority): void {
  invalidateSession(a);
  a.barrierDepth += 1;
}

export function settleImportBarrier(a: Authority): boolean {
  if (a.barrierDepth === 0) return false;
  invalidateSession(a);
  a.barrierDepth -= 1;
  return a.barrierDepth === 0;
}

export function disposeAuthority(a: Authority): void { invalidateSession(a); }
