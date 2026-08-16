export const USER_STORAGE_LOGICAL_KEYS = [
  'fxj_v4_trades',
  'fxj_v4_accounts',
  'fxj_v4_lists',
  'fxj_prop_rules',
  'fxj_v4_settings',
  'fxj_v4_saved_filters',
  'fxj_v4_checklist_templates',
  'fxj_v4_checklist_completions',
  'fxj_v4_custom_field_defs',
  'fxj_v4_custom_field_values',
  'fxj_v4_recovery_bin',
  'fxj_v4_restore_points',
  'fxj_v4_sync_cursors',
  'fxj_v4_backtest_sessions',
  'fxj_v4_backtest_results',
] as const;

export type UserStorageLogicalKey = typeof USER_STORAGE_LOGICAL_KEYS[number];

export interface RawStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface UserStorageScope {
  readonly userId: string;
  readonly namespaceVersion: 'v1';
  readonly physicalKey: (logicalKey: UserStorageLogicalKey) => string;
  readonly getRaw: (logicalKey: UserStorageLogicalKey) => string | null;
  readonly setRaw: (logicalKey: UserStorageLogicalKey, value: string) => void;
  readonly remove: (logicalKey: UserStorageLogicalKey) => void;
}

const SUPABASE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const LOGICAL_KEY_SET = new Set<string>(USER_STORAGE_LOGICAL_KEYS);

export function validateUserStorageId(userId: string): string {
  if (!SUPABASE_UUID.test(userId)) {
    throw new Error('Authenticated user ID is not a supported UUID.');
  }
  return userId;
}

export function isUserStorageLogicalKey(value: string): value is UserStorageLogicalKey {
  return LOGICAL_KEY_SET.has(value);
}

export function scopedPhysicalKey(userId: string, logicalKey: UserStorageLogicalKey): string {
  const exactUserId = validateUserStorageId(userId);
  if (!isUserStorageLogicalKey(logicalKey)) throw new Error('Unrecognized user storage key.');
  return `fxj:user:v1:${encodeURIComponent(exactUserId)}:${logicalKey}`;
}

export function createUserStorageScope(userId: string, rawStorage: RawStorage): UserStorageScope {
  const exactUserId = validateUserStorageId(userId);
  const physicalKey = (logicalKey: UserStorageLogicalKey) => scopedPhysicalKey(exactUserId, logicalKey);
  return Object.freeze({
    userId: exactUserId,
    namespaceVersion: 'v1' as const,
    physicalKey,
    getRaw: (logicalKey: UserStorageLogicalKey) => rawStorage.getItem(physicalKey(logicalKey)),
    setRaw: (logicalKey: UserStorageLogicalKey, value: string) => rawStorage.setItem(physicalKey(logicalKey), value),
    remove: (logicalKey: UserStorageLogicalKey) => rawStorage.removeItem(physicalKey(logicalKey)),
  });
}
