/**
 * services/syncEngineSetup.ts
 *
 * Phase 5d — assembles the real `SyncEngineDependencies` (§5, syncEngine.ts)
 * from Phase 5a's local stores (syncStores.ts) and Phase 5b's transports
 * (syncTransport.ts), which have never been combined until now. Also
 * owns the §13 Step 5 rollout gate ("Recommended rollout control: gate
 * Step 5 behind a feature flag") — per the approved decision, the
 * simplest possible mechanism: a single environment variable, no
 * framework.
 *
 * SCOPE — exactly what Phase 5d covers, nothing from Scheduler/Push
 * Manager/Pull Manager/Conflict Detector/the LocalStore layer is
 * modified here; this file only wires already-built, already-approved
 * pieces together.
 */

import { createAllLocalStores } from './syncStores.js';
import { createAllTransports } from './syncTransport.js';
import { SYNC_TABLE_ORDER } from '@sync/scheduler.js';
import type { SyncTableName, ReconciliationStore, Tier2AdmissionStore } from '@sync/scheduler.js';
import type { SyncEngineDependencies } from '@sync/syncEngine.js';

/**
 * Combines the local-store bundle (per table: push/pull stores,
 * reconciliation store, Tier 2 admission store) with the transport
 * bundle (per table: push/pull transports) into the shape
 * `startSyncEngine()` requires.
 */
export function buildSyncEngineDependencies(): SyncEngineDependencies {
  const localStores = createAllLocalStores();
  const transports = createAllTransports();

  const tables = {} as SyncEngineDependencies['tables'];
  const reconciliationStores = {} as Record<SyncTableName, ReconciliationStore>;
  const tier2AdmissionStores = {} as Record<SyncTableName, Tier2AdmissionStore>;

  for (const table of SYNC_TABLE_ORDER) {
    tables[table] = {
      pushStore: localStores[table].pushStore,
      pushTransport: transports[table].pushTransport,
      pullStore: localStores[table].pullStore,
      pullTransport: transports[table].pullTransport,
    };
    reconciliationStores[table] = localStores[table].reconciliationStore;
    tier2AdmissionStores[table] = localStores[table].tier2AdmissionStore;
  }

  return { tables, reconciliationStores, tier2AdmissionStores };
}

/**
 * §13 Step 5 rollout gate. Reads `VITE_SYNC_ENGINE_ENABLED` — unset or
 * anything other than the literal string `'true'` means disabled. No
 * feature-flag framework, per the approved decision — this is the
 * entire mechanism. Defaults to OFF: §13 Step 5 explicitly recommends
 * "small cohort first," and an unset flag should never silently start
 * pushing/pulling real user data.
 */
export function isSyncEngineEnabled(): boolean {
  return import.meta.env.VITE_SYNC_ENGINE_ENABLED === 'true';
}

/**
 * §13 Step 6 rollout gate — Phase 6g. Deliberately INDEPENDENT of
 * `isSyncEngineEnabled()` above.
 *
 * WHY A SEPARATE FLAG, AND WHY THAT IS SPEC-COMPLIANT: §13 Step 6
 * sub-step 0 requires only that the cutover be "elected by **the same
 * Web Lock** that governs ongoing sync" — it constrains the LOCK, not
 * the rollout control. The one feature-flag recommendation in the whole
 * document is scoped to Step 5 ("gate **Step 5** behind a feature
 * flag"), and §15.8 assigns Step 6 a different mitigation entirely
 * ("explicit completion-marker/verify/restart-from-scratch protocol for
 * Step 6"). So nothing here ties the two rollouts together.
 *
 * Keeping them separate matters practically: the LocalStorage ->
 * IndexedDB cutover is a local-storage scalability change, whereas the
 * sync engine performs real network I/O against the user's cloud
 * project. Reusing one flag would have made it impossible to roll out
 * the former without also enabling the latter — a coupling invented by
 * our Phase 5d wiring (leader election living inside
 * `startSyncEngine`), not by the specification. Phase 6g removes that
 * coupling via `startLeaderElection()` (src/sync/syncEngine.ts), which
 * shares the exact same Web Lock.
 *
 * Defaults to OFF for the same reason as the Step 5 gate: an unset flag
 * must never silently begin rewriting where a user's data lives.
 */
export function isStorageCutoverEnabled(): boolean {
  return import.meta.env.VITE_STORAGE_CUTOVER_ENABLED === 'true';
}
