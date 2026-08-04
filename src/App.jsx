/**
 * App.jsx
 *
 * Phase 19 — Integration: the real application root.
 *
 * Replaces the Phase 0 placeholder. Wires together every hook and page
 * built across Phases 1-18 into one running application, reachable
 * through AppShell (Phase 4). This phase makes existing, already-
 * validated code reachable — it does NOT change any calculation, any
 * LocalStorage key, or any page/component's internal behavior. Every
 * page continues to receive data purely via props, exactly as each
 * page's own Phase report specified ("this page receives trades as
 * props from the parent that owns the hook").
 *
 * TABS wired: the 6 pages that were actually built in the modular
 * architecture (Dashboard, Raw, Equity, Calendar, Strategy, Insights).
 * The original single-file app's Prop Firm Tracker and Position
 * Calculator tabs were never migrated to this architecture in any
 * phase — they are not wired here because they do not exist to wire
 * (a genuine migration gap, not an integration bug — see
 * MIGRATION_NOTES.md).
 *
 * HEADER ACTIONS wired: + New Trade (switches to the Raw tab AND
 * signals Raw's own, unchanged TradeForm modal to open directly, via
 * RawPage's openAddTrigger/onAddSignalHandled props — fixed post-
 * integration; previously only switched tabs, requiring a second
 * manual click), 📂 Import/
 * Export (ImportWizard, Phase 13), 💼 Accounts (AccManager, built this
 * phase to fill a migration gap — see MIGRATION_NOTES.md), ⚙ Settings
 * (SettingsModal, Phase 19 composite — see its own file header).
 */

import React, { useState, useMemo, useCallback } from 'react';
import { AppShell } from '@components/layout/AppShell.js';
import { RawPage } from '@pages/Raw.js';
import { DashboardPage } from '@pages/Dashboard.js';
import { EquityPage } from '@pages/Equity.js';
import { CalendarPage } from '@pages/Calendar.js';
import { StrategyPage } from '@pages/Strategy.js';
import { InsightsPage } from '@pages/Insights.js';
import { BacktestPage } from '@pages/Backtest.js';
import { ImportWizard } from '@components/import/ImportWizard.js';
import { AccManager } from '@components/account/AccManager.js';
import { SettingsModal } from '@components/settings/SettingsModal.js';
import { UserMenu } from '@components/auth/UserMenu.js';
import { ListEditor } from '@components/settings/ListEditor.js';
import { Spinner } from '@components/ui/Spinner.js';
import { COLORS } from '@constants/lists.js';
import { useAccounts } from '@hooks/useAccounts.js';
import { useTrades } from '@hooks/useTrades.js';
import { useLists } from '@hooks/useLists.js';
import { useSettings } from '@hooks/useSettings.js';
import { useFilters } from '@hooks/useFilters.js';
import { useAdvancedFilters } from '@hooks/useAdvancedFilters.js';
import { useTradeReview } from '@hooks/useTradeReview.js';
import { useRecoveryBin } from '@hooks/useRecoveryBin.js';
import { useRestorePoints } from '@hooks/useRestorePoints.js';

// ─── Tabs — matches the pages actually built ───────────────────
const TABS = [
  { id: 'dashboard', label: '📊 Dashboard' },
  { id: 'raw',       label: '📋 Raw' },
  { id: 'equity',    label: '📈 Equity' },
  { id: 'calendar',  label: '📅 Calendar' },
  { id: 'strategy',  label: '🧠 Strategy' },
  { id: 'insights',  label: '🤖 Insights' },
  { id: 'backtest',  label: '🧪 Backtest' },
];

export default function App() {
  // ── Core hooks — each owns exactly one LocalStorage-backed concern ──
  const { accounts, addAccount, editAccount, deleteAccount, hydrated: accountsHydrated } = useAccounts();
  const {
    rawTrades, allTrades,
    addTrade, updateTrade, deleteTrade, deleteAllTrades, importTrades,
    hydrated: tradesHydrated,
  } = useTrades(accounts);
  const { lists, updateList, resetList, hydrated: listsHydrated } = useLists();
  const { settings, updateSettings, resetSettings, hydrated: settingsHydrated } = useSettings();
  const {
    accFilter, mktFilter, setAccFilter, setMktFilter, applyFilters,
    activeFilter, setActiveFilter, clearActiveFilter,
  } = useFilters();

  // Phase 14/15/18 capabilities — reachable via SettingsModal (see its
  // own file header for the composition decision)
  const { savedFilters, saveFilter, deleteFilter, toggleFavorite } = useAdvancedFilters();
  const {
    checklistTemplates, addChecklistTemplate, deleteChecklistTemplate,
    customFieldDefs, addCustomFieldDef, deleteCustomFieldDef,
  } = useTradeReview();
  const { entries: recoveryBinEntries, softDelete, restore: restoreFromBin, restoreAll: restoreAllFromBin, permanentlyDelete, emptyBin } = useRecoveryBin();
  const { restorePoints, create: createRestorePoint, restore: restoreFromPoint, remove: deleteRestorePoint } = useRestorePoints();

  // ── Globally-filtered trades — same derivation every page expects ──
  const trades = useMemo(() => applyFilters(allTrades), [allTrades, applyFilters]);

  // Recovery Bin wiring — the existing useRecoveryBin/RecoveryBinPanel
  // stack was already complete (Phase 18); the only gap was that
  // nothing ever called softDelete(). These two composite functions
  // close that gap by wrapping the EXISTING deleteTrade/restore/
  // importTrades functions — none of those are modified.
  //
  // handleSoftDeleteTrade(tid): looks up the trade DIRECTLY from
  // rawTrades (not the enriched `trades` prop, which also carries
  // extra computed `_r`/`_pl`/etc. fields) — guaranteeing a clean,
  // original RawTrade snapshot is what gets stored in the bin — then
  // calls softDelete() BEFORE deleteTrade(), so a trade is never
  // removed from active trades without first being safely captured
  // in the bin. Used at BOTH existing delete call sites (single via
  // handleDelete, bulk via onBulkDeleteTrade) — see pages/Raw.tsx.
  const handleSoftDeleteTrade = useCallback((tid) => {
    const trade = rawTrades.find((t) => t._tid === tid);
    if (trade) {
      const label = `${trade.symbol || 'Trade'}${trade.direction ? ' ' + trade.direction : ''} — ${trade.date || 'no date'}`;
      softDelete(trade, label);
    }
    deleteTrade(tid);
  }, [rawTrades, softDelete, deleteTrade]);

  // handleRestoreFromBin(id): calls the EXISTING restore() (removes
  // the bin entry, returns the original trade), then reinserts that
  // exact trade via the EXISTING importTrades() — which appends whole
  // RawTrade objects as-is, preserving their original _tid, unlike
  // addTrade() which always mints a new one. No changes to useTrades.ts
  // were needed; importTrades already provided this capability.
  const handleRestoreFromBin = useCallback((id) => {
    const trade = restoreFromBin(id);
    if (trade) {
      importTrades([trade]);
    }
  }, [restoreFromBin, importTrades]);

  // handleRestoreAllFromBin(): "Restore All" — calls the new
  // restoreAll() (single state update, clears the whole bin at once,
  // returns every item), then reinserts ALL of them via ONE
  // importTrades() call — not a loop calling importTrades per trade,
  // and not a loop calling handleRestoreFromBin/restore() per entry.
  // Each trade keeps its original _tid, exactly like single restore,
  // since it reuses the same importTrades() path. The confirmation
  // dialog itself lives in RecoveryBinPanel.tsx, next to the button —
  // this function performs the operation only after that confirm
  // already happened.
  const handleRestoreAllFromBin = useCallback(() => {
    const trades = restoreAllFromBin();
    if (trades.length > 0) {
      importTrades(trades);
    }
  }, [restoreAllFromBin, importTrades]);

  // ── Tab state ──
  const [tab, setTab] = useState('dashboard');

  // Pending flag for the global "+ New Trade" button — see pages/
  // Raw.tsx's openAddTrigger/onAddSignalHandled doc comment for the
  // full rationale (revised from an earlier increment-a-counter
  // design that proved fragile against remount/StrictMode timing).
  // Purely additive; does not touch tab or modal state below.
  const [openAddPending, setOpenAddPending] = useState(false);

  // ── Modal state ──
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [showAccManager, setShowAccManager] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showListEditor, setShowListEditor] = useState(false);

  // Phase 22 — applying a saved filter makes it the global lens every
  // page below reads through. The group is SNAPSHOT with
  // structuredClone, so deleting or editing the source SavedFilter
  // afterwards cannot change what the user is currently looking at.
  // Declared here, after the modal state it closes over.
  const handleApplyFilter = useCallback((f) => {
    setActiveFilter({ sourceId: f.id, name: f.name, group: structuredClone(f.group) });
    setShowSettings(false);
  }, [setActiveFilter]);

  const defaultAccId = accounts[0]?.id ?? 'acc_1';

  // "New Trade" header button: switch to Raw tab AND set the pending
  // flag so RawPage opens its own, unchanged Add Trade form (see
  // pages/Raw.tsx). The existing setTab('raw') call is preserved
  // exactly; setting openAddPending is the only addition. RawPage
  // calls handleAddSignalHandled() once it has acted on the flag,
  // resetting it back to false.
  const handleNewTrade = useCallback(() => {
    setTab('raw');
    setOpenAddPending(true);
  }, []);

  const handleAddSignalHandled = useCallback(() => {
    setOpenAddPending(false);
  }, []);

  const headerActions = [
    { id: 'new',      icon: '+',  label: 'New Trade',      onClick: handleNewTrade, variant: 'primary' },
    { id: 'import',   icon: '📂', label: 'Import/Export',   onClick: () => setShowImportWizard(true) },
    { id: 'accounts', icon: '💼', label: 'Accounts',        onClick: () => setShowAccManager(true) },
    { id: 'settings', icon: '⚙', label: 'Settings',         onClick: () => setShowSettings(true) },
  ];

  const filterAccounts = accounts.map((a) => ({ id: a.id, name: a.name, color: a.color }));

  // ── Hydration gate (Phase 6f) ───────────────────────────────────────
  // The four core hooks now load through services/localDatabase.ts,
  // whose API is asynchronous because IndexedDB is (§3.4). Until all
  // four have finished their initial read, their state is still the
  // "nothing saved yet" placeholder — rendering the app against that
  // would briefly show an empty journal to a user who has data, and
  // would let a mutation land before the real records arrived.
  //
  // This gate is intentional design, not a workaround: it is the point
  // at which "the local database is the only thing the UI ever reads"
  // (§0) becomes true asynchronously. It reuses the existing Spinner
  // and COLORS rather than introducing a new visual language, and
  // mirrors AuthGate.tsx's own `loading` branch.
  //
  // While the cutover completion marker is absent — which is the case
  // on every installation today — the resolver routes to LocalStorage,
  // so what loads here is byte-identical to what the previous
  // synchronous initializers read.
  const localDataReady = accountsHydrated && tradesHydrated && listsHydrated && settingsHydrated;

  if (!localDataReady) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: COLORS.bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Spinner />
      </div>
    );
  }

  return (
    <AppShell
      headerProps={{
        title: 'Trading Journal',
        subtitle: `${trades.length} trades · ${accounts.length} account${accounts.length !== 1 ? 's' : ''}`,
        actions: headerActions,
        userMenu: <UserMenu onSettingsClick={() => setShowSettings(true)} />,
      }}
      filterBarProps={{
        accounts: filterAccounts,
        accFilter,
        setAccFilter,
        mktFilter,
        setMktFilter,
        // Phase 22 — chip. `trades` is the already-computed memo above
        // and `allTrades` comes straight from useTrades(), so both
        // counts are exact with no extra computation.
        activeFilter: activeFilter ? { name: activeFilter.name } : undefined,
        visibleTradeCount: trades.length,
        totalTradeCount: allTrades.length,
        onClearActiveFilter: clearActiveFilter,
      }}
      tabBarProps={{ tabs: TABS, activeTab: tab, onChange: setTab }}
      modals={
        <>
          {showImportWizard && (
            <ImportWizard
              trades={trades}
              rawTrades={rawTrades}
              accounts={accounts}
              onImport={(newTrades) => { importTrades(newTrades); }}
              onClose={() => setShowImportWizard(false)}
            />
          )}

          {showAccManager && (
            <AccManager
              accounts={accounts}
              onAdd={addAccount}
              onEdit={editAccount}
              onDelete={deleteAccount}
              onClose={() => setShowAccManager(false)}
            />
          )}

          {showSettings && (
            <SettingsModal
              onClose={() => setShowSettings(false)}
              onOpenLists={() => { setShowSettings(false); setShowListEditor(true); }}
              settings={settings}
              onUpdateSettings={updateSettings}
              onResetSettings={resetSettings}
              restorePoints={restorePoints}
              onCreateRestorePoint={createRestorePoint}
              onRestoreFromPoint={restoreFromPoint}
              onDeleteRestorePoint={deleteRestorePoint}
              recoveryBinEntries={recoveryBinEntries}
              onRestoreFromBin={handleRestoreFromBin}
              onRestoreAllFromBin={handleRestoreAllFromBin}
              onPermanentlyDelete={permanentlyDelete}
              onEmptyBin={emptyBin}
              trades={trades}
              savedFilters={savedFilters}
              onSaveFilter={saveFilter}
              onDeleteFilter={deleteFilter}
              onToggleFavoriteFilter={toggleFavorite}
              onApplyFilter={handleApplyFilter}
              checklistTemplates={checklistTemplates}
              onAddChecklistTemplate={addChecklistTemplate}
              onDeleteChecklistTemplate={deleteChecklistTemplate}
              customFieldDefs={customFieldDefs}
              onAddCustomFieldDef={addCustomFieldDef}
              onDeleteCustomFieldDef={deleteCustomFieldDef}
            />
          )}

          {showListEditor && (
            <ListEditor
              lists={lists}
              onChange={updateList}
              onReset={resetList}
              onClose={() => setShowListEditor(false)}
            />
          )}
        </>
      }
    >
      {tab === 'dashboard' && <DashboardPage trades={trades} accounts={accounts} accFilter={accFilter} />}

      {tab === 'raw' && (
        <RawPage
          trades={trades}
          accounts={accounts}
          lists={lists}
          defaultAccId={defaultAccId}
          addTrade={addTrade}
          updateTrade={updateTrade}
          deleteAllTrades={deleteAllTrades}
          softDeleteTrade={handleSoftDeleteTrade}
          openAddTrigger={openAddPending}
          onAddSignalHandled={handleAddSignalHandled}
        />
      )}

      {tab === 'equity' && <EquityPage trades={trades} accounts={accounts} accFilter={accFilter} />}

      {tab === 'calendar' && <CalendarPage trades={trades} />}

      {tab === 'strategy' && <StrategyPage trades={trades} lists={lists} />}

      {tab === 'insights' && <InsightsPage trades={trades} />}

      {/* Receives UNFILTERED allTrades, not the globally-filtered
          `trades` every other page takes — see pages/Backtest.tsx */}
      {tab === 'backtest' && <BacktestPage allTrades={allTrades} accounts={accounts} />}
    </AppShell>
  );
}
