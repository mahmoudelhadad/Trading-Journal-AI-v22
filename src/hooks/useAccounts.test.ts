import { describe, expect, it } from 'vitest';
import { planAccountDeletion } from './useAccounts.js';
import type { Account } from './useAccounts.js';

const NOW = '2026-08-06T12:00:00.000Z';
const BASE_UPDATED_AT = '2026-08-05T12:00:00.000Z';

function account(id: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    name: id,
    capital: 10_000,
    color: '#3B82F6',
    syncId: `sync-${id}`,
    syncStatus: 'dirty',
    localUpdatedAt: BASE_UPDATED_AT,
    baseUpdatedAt: null,
    deletedAt: null,
    consecutiveFailures: 0,
    nextEligibleAttemptAt: null,
    lastError: null,
    conflictResolutionLog: [],
    ...overrides,
  };
}

describe('account deletion planning', () => {
  it('allows an unreferenced target when multiple active accounts exist', () => {
    const plan = planAccountDeletion([account('a'), account('b')], 'a', [], NOW);
    expect(plan.result).toEqual({ ok: true });
  });

  it('blocks one active referencing trade', () => {
    const plan = planAccountDeletion([account('a'), account('b')], 'a', [{ accountId: 'a' }], NOW);
    expect(plan.result).toEqual({ ok: false, reason: 'referenced_by_trades' });
  });

  it('blocks multiple active referencing trades', () => {
    const trades = [{ accountId: 'a' }, { accountId: 'a' }, { accountId: 'b' }];
    const plan = planAccountDeletion([account('a'), account('b')], 'a', trades, NOW);
    expect(plan.result).toEqual({ ok: false, reason: 'referenced_by_trades' });
  });

  it('allows a target when active trades reference only another account', () => {
    const plan = planAccountDeletion([account('a'), account('b')], 'a', [{ accountId: 'b' }], NOW);
    expect(plan.result).toEqual({ ok: true });
  });

  it('returns the original account collection for a referenced target', () => {
    const accounts = [account('a'), account('b')];
    const plan = planAccountDeletion(accounts, 'a', [{ accountId: 'a' }], NOW);
    expect(plan.accounts).toBe(accounts);
  });

  it('does not mutate provided trade objects when deletion is blocked', () => {
    const trade = Object.freeze({ accountId: 'a', note: 'unchanged' });
    const plan = planAccountDeletion([account('a'), account('b')], 'a', [trade], NOW);
    expect(plan.result).toEqual({ ok: false, reason: 'referenced_by_trades' });
    expect(trade).toEqual({ accountId: 'a', note: 'unchanged' });
  });

  it('never reassigns a referencing trade', () => {
    const trade = { accountId: 'a' };
    planAccountDeletion([account('a'), account('b')], 'a', [trade], NOW);
    expect(trade.accountId).toBe('a');
  });

  it('blocks deletion of the last active account', () => {
    const plan = planAccountDeletion([account('a')], 'a', [], NOW);
    expect(plan.result).toEqual({ ok: false, reason: 'last_account' });
  });

  it('gives last-account protection precedence over a trade reference', () => {
    const plan = planAccountDeletion([account('a')], 'a', [{ accountId: 'a' }], NOW);
    expect(plan.result).toEqual({ ok: false, reason: 'last_account' });
  });

  it('returns not_found without mutation for a missing target', () => {
    const accounts = [account('a'), account('b')];
    const plan = planAccountDeletion(accounts, 'missing', [], NOW);
    expect(plan.result).toEqual({ ok: false, reason: 'not_found' });
    expect(plan.accounts).toBe(accounts);
  });

  it('excludes a tombstoned trade from the supplied active-trade contract', () => {
    const storedTrades = [{ accountId: 'a', deletedAt: NOW }];
    const activeTrades = storedTrades.filter((trade) => trade.deletedAt === null);
    const plan = planAccountDeletion([account('a'), account('b')], 'a', activeTrades, NOW);
    expect(plan.result).toEqual({ ok: true });
  });

  it('uses exact strict accountId matching', () => {
    const plan = planAccountDeletion([account('a'), account('b')], 'a', [{ accountId: 'A' }], NOW);
    expect(plan.result).toEqual({ ok: true });
  });

  it('purges an allowed account that has never synced', () => {
    const unrelated = account('b');
    const plan = planAccountDeletion([account('a'), unrelated], 'a', [], NOW);
    expect(plan.accounts).toEqual([unrelated]);
  });

  it('tombstones an allowed account that was previously synced', () => {
    const target = account('a', { syncStatus: 'synced', baseUpdatedAt: BASE_UPDATED_AT });
    const plan = planAccountDeletion([target, account('b')], 'a', [], NOW);
    expect(plan.accounts[0]).toEqual({
      ...target,
      deletedAt: NOW,
      localUpdatedAt: NOW,
      syncStatus: 'pending_delete',
    });
  });

  it('changes only the intended account during successful tombstoning', () => {
    const target = account('a', { syncStatus: 'synced', baseUpdatedAt: BASE_UPDATED_AT });
    const unrelated = account('b');
    const plan = planAccountDeletion([target, unrelated], 'a', [], NOW);
    expect(plan.accounts[0]).not.toBe(target);
    expect(plan.accounts[1]).toBe(unrelated);
  });

  it('adds no sync or tombstone metadata when planning is blocked', () => {
    const target = account('a', { syncStatus: 'synced', baseUpdatedAt: BASE_UPDATED_AT });
    const accounts = [target, account('b')];
    const plan = planAccountDeletion(accounts, 'a', [{ accountId: 'a' }], NOW);
    expect(plan.accounts).toBe(accounts);
    expect(target).toEqual(account('a', { syncStatus: 'synced', baseUpdatedAt: BASE_UPDATED_AT }));
  });

  it('preserves unrelated accounts structurally during a successful purge', () => {
    const unrelated = account('b', { conflictResolutionLog: ['keep'] });
    const plan = planAccountDeletion([account('a'), unrelated], 'a', [], NOW);
    expect(plan.accounts[0]).toBe(unrelated);
  });
});
