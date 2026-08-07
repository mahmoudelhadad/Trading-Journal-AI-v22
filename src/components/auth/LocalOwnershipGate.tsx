import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@hooks/useAuth.js';
import { COLORS as C } from '@constants/lists.js';
import { Button } from '@components/ui/Button.js';
import { Spinner } from '@components/ui/Spinner.js';
import { UserStorageProvider } from '@contexts/UserStorageContext.js';
import { createUserStorageScope, type UserStorageScope } from '@services/storageNamespace.js';
import {
  claimLegacyOwnership,
  declineLegacyOwnership,
  inspectLegacyOwnership,
  type OwnershipInspection,
} from '@services/legacyOwnership.js';
import { preflightGlobalIndexedDb } from '@services/localDatabase.js';
import { isStorageCutoverEnabled, isSyncEngineEnabled } from '@services/syncEngineSetup.js';

type GateState =
  | { kind: 'loading' }
  | { kind: 'safety_block'; message: string }
  | { kind: 'ownership'; inspection: OwnershipInspection };

function GatePanel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ width: 'min(560px, 100%)', border: `1px solid ${C.border}`, borderRadius: 12, background: C.card, padding: 24 }}>
        {children}
      </div>
    </div>
  );
}

function LocalOwnershipSession({ userId, children }: { userId: string; children: React.ReactNode }) {
  const [scope] = useState<UserStorageScope>(() => createUserStorageScope(userId, localStorage));
  const [state, setState] = useState<GateState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  const inspect = useCallback(async () => {
    if (isSyncEngineEnabled() || isStorageCutoverEnabled()) {
      setState({ kind: 'safety_block', message: 'Local ownership safety requires Sync and Storage Cutover to remain disabled.' });
      return;
    }
    const idb = await preflightGlobalIndexedDb();
    if (idb.kind === 'blocked') {
      setState({
        kind: 'safety_block',
        message: idb.reason === 'marker_present'
          ? 'This browser has an existing global IndexedDB cutover marker. User-scoped data is blocked pending safe migration.'
          : 'The existing IndexedDB cutover marker could not be read safely. User-scoped data remains blocked.',
      });
      return;
    }
    setState({ kind: 'ownership', inspection: await inspectLegacyOwnership(userId, scope) });
  }, [scope, userId]);

  useEffect(() => {
    let cancelled = false;
    inspect().catch(() => {
      if (!cancelled) setState({ kind: 'safety_block', message: 'Local ownership could not be established safely.' });
    });
    return () => { cancelled = true; };
  }, [inspect]);

  if (state.kind === 'loading') return <GatePanel><Spinner message="Preparing your local journal…" /></GatePanel>;
  if (state.kind === 'safety_block') {
    return <GatePanel><h2 style={{ marginTop: 0 }}>Local data safety block</h2><p>{state.message}</p></GatePanel>;
  }

  const inspection = state.inspection;
  if (inspection.kind === 'ready') {
    return <UserStorageProvider scope={scope}>{children}</UserStorageProvider>;
  }

  const runClaim = async () => {
    setBusy(true);
    const result = await claimLegacyOwnership(userId, scope);
    if (result.kind === 'verified') await inspect();
    else setState({ kind: 'ownership', inspection: result.kind === 'destination_conflict'
      ? { kind: 'destination_conflict' }
      : result.kind === 'malformed_legacy'
        ? { kind: 'quarantined', reason: 'malformed_legacy', canContinue: true }
      : result.kind === 'lock_unavailable'
        ? { kind: 'lock_unavailable' }
        : result.kind === 'source_changed'
          ? { kind: 'retry_required' }
          : { kind: 'lock_unavailable' } });
    setBusy(false);
  };

  const continueWithoutClaim = async () => {
    setBusy(true);
    if (await declineLegacyOwnership(userId)) await inspect();
    else setState({ kind: 'ownership', inspection: { kind: 'lock_unavailable' } });
    setBusy(false);
  };

  if (inspection.kind === 'claim_required') {
    return (
      <GatePanel>
        <h2 style={{ marginTop: 0 }}>Local journal data found</h2>
        <p>Claim this browser’s existing local journal only if it belongs to this account.</p>
        <p>Continuing without claiming starts an independent journal. Once you add scoped data, this legacy data cannot be claimed automatically later.</p>
        <div style={{ display: 'flex', gap: 10 }}>
          <Button variant="primary" size="sm" disabled={busy} onClick={runClaim}>Claim local journal</Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={continueWithoutClaim}>Continue without claiming</Button>
        </div>
      </GatePanel>
    );
  }

  if (inspection.kind === 'retry_required') {
    return <GatePanel><h2 style={{ marginTop: 0 }}>Local claim needs retry</h2><p>Partial destination data is quarantined and has not been opened.</p><Button variant="primary" size="sm" disabled={busy} onClick={runClaim}>Retry complete claim</Button></GatePanel>;
  }

  if (inspection.kind === 'quarantined' && inspection.canContinue) {
    return <GatePanel><h2 style={{ marginTop: 0 }}>Legacy data quarantined</h2><p>The preserved local data cannot be claimed because at least one stored value is malformed.</p><Button variant="secondary" size="sm" disabled={busy} onClick={continueWithoutClaim}>Continue with an independent journal</Button></GatePanel>;
  }

  const message = inspection.kind === 'destination_conflict'
    ? 'This account already has scoped local data, so the legacy journal cannot be replaced or merged automatically.'
    : inspection.kind === 'lock_unavailable'
      ? 'The browser ownership lock is unavailable. No legacy claim or ownership transition was attempted.'
      : 'Local ownership metadata is ambiguous or invalid. The journal remains quarantined.';
  return <GatePanel><h2 style={{ marginTop: 0 }}>Local ownership unavailable</h2><p>{message}</p></GatePanel>;
}

export function LocalOwnershipGate({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return null;
  return <LocalOwnershipSession key={user.id} userId={user.id}>{children}</LocalOwnershipSession>;
}
