import React, { createContext, useContext, useState } from 'react';
import { createStorageService } from '@services/storage.js';
import { createScopedLocalDatabase } from '@services/localDatabase.js';
import { runSyncMetadataStampingPass } from '@sync/stamp.js';
import type { UserStorageScope } from '@services/storageNamespace.js';

export interface UserStorageContextValue {
  scope: UserStorageScope;
  storage: ReturnType<typeof createStorageService>;
  database: ReturnType<typeof createScopedLocalDatabase>;
}

const UserStorageContext = createContext<UserStorageContextValue | undefined>(undefined);

export function UserStorageProvider({ scope, children }: { scope: UserStorageScope; children: React.ReactNode }) {
  const [value] = useState<UserStorageContextValue>(() => {
    const storage = createStorageService(scope);
    runSyncMetadataStampingPass(storage);
    return Object.freeze({
      scope,
      storage,
      database: createScopedLocalDatabase(storage),
    });
  });
  return <UserStorageContext.Provider value={value}>{children}</UserStorageContext.Provider>;
}

export function useUserStorage(): UserStorageContextValue {
  const value = useContext(UserStorageContext);
  if (!value) throw new Error('useUserStorage must be used within UserStorageProvider.');
  return value;
}
