/**
 * hooks/useRestorePoints.ts
 *
 * Phase 18 — Restore Points hook.
 *
 * NEW hook — thin React wrapper around services/backupService.ts's
 * restore-point functions (createRestorePoint/listRestorePoints/
 * restoreFromPoint/deleteRestorePoint). Contains ZERO snapshot logic
 * of its own — every operation delegates to the already-validated
 * Phase 16/18 backupService functions, which themselves reuse
 * buildBackup()/restoreBackup(). This hook's only job is exposing that
 * service as reactive state for a future UI to consume.
 *
 * SCOPE NOTE: not consumed by any existing page in this phase.
 *
 * PHASE 6g-1: `create`/`restore` are now `async` — `createRestorePoint`/
 * `restoreFromPoint` (backupService.ts) call `buildBackup`/
 * `restoreBackup`, which read/write the four resolver-backed sections
 * (trades/accounts/lists/settings) and are therefore async themselves
 * (§3.4). `listRestorePoints`/`deleteRestorePoint` stay synchronous —
 * RESTORE_POINTS was never part of the Step 6 migration (Phase 20
 * audit note, backupService.ts) — so `refresh`/`remove` are unchanged.
 */

import { useState, useCallback, useMemo } from 'react';
import { createBackupService, type RestoreResult } from '@services/backupService.js';
import { useUserStorage } from '@contexts/UserStorageContext.js';
import type { RestorePoint } from '@calculations/recoveryBin.js';

// ─── Hook ────────────────────────────────────────────────────

export interface UseRestorePointsReturn {
  restorePoints: RestorePoint[];
  /** Create a new restore point with the given label, refreshing the list */
  create:        (label: string) => Promise<void>;
  /** Restore the app to a given restore point */
  restore:       (id: string) => Promise<RestoreResult>;
  /** Delete a restore point, refreshing the list */
  remove:        (id: string) => void;
  /** Re-read the restore points list from storage */
  refresh:       () => void;
}

export function useRestorePoints(): UseRestorePointsReturn {
  const { storage, database } = useUserStorage();
  const backup = useMemo(() => createBackupService(storage, database), [storage, database]);
  const [restorePoints, setRestorePoints] = useState<RestorePoint[]>(() => backup.listRestorePoints());

  const refresh = useCallback(() => {
    setRestorePoints(backup.listRestorePoints());
  }, [backup]);

  const create = useCallback(async (label: string) => {
    await backup.createRestorePoint(label);
    refresh();
  }, [backup, refresh]);

  const restore = useCallback((id: string): Promise<RestoreResult> => {
    return backup.restoreFromPoint(id);
  }, [backup]);

  const remove = useCallback((id: string) => {
    backup.deleteRestorePoint(id);
    refresh();
  }, [backup, refresh]);

  return { restorePoints, create, restore, remove, refresh };
}
