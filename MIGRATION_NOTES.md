# Migration Notes / Known Issues

This document tracks every preserved quirk, known bug, and intentional
behavioral note discovered during the migration from the original
single-file app to the modular React + TypeScript architecture.

**Rule in effect throughout this migration:** bugs present in the
original application are preserved exactly, not silently fixed. Any
bug listed here is a candidate for an explicit, separately-approved
post-migration bug-fix phase — never fixed inline during migration.

---

## Known Issues (Preserved From Original App)

### 🐛 KI-001 — Bulk delete via header checkbox does nothing

**Status:** Confirmed present in both the original app and this migration (by design — restored in Phase 7B per explicit approval).

**Symptom:** Selecting multiple trades via the header "select all" checkbox
(or individual row checkboxes) on the Raw page, then clicking
"🗑 Delete N selected", shows the confirm dialog and appears to succeed
(dialog closes, selection clears) — but **no trades are actually deleted**.

**Root cause:** `Object.keys()` always returns `string[]` in JavaScript,
even when the underlying object's keys were written using numeric trade
IDs (`_tid`, generated via `Date.now()`). The bulk-delete handler collects
selected IDs via `Object.keys(selected)`, producing strings, then passes
each one to the delete function, which compares `t._tid !== tid`. Since
`t._tid` is a `number` and `tid` is a `string`, this strict inequality is
**always true** — so the filter removes nothing.

**Why it's preserved, not fixed:** Discovered during Phase 7 Validation.
An earlier migration choice (Phase 2B) had accidentally used
`String(Date.now())` instead of `Date.now()` for new trade IDs, which
inadvertently fixed this bug as a side effect. Per user decision (approved
Phase 7B), `_tid` was restored to its original numeric type to keep the
migration behaviorally identical to the original app — which reintroduced
this dormant bug exactly as it exists upstream.

**Unaffected workflow:** The single-row "Del" button (per trade row) works
correctly — it passes `t._tid` directly without going through
`Object.keys()`, so it isn't subject to this type mismatch.

**Location in migrated code:**
- `src/components/trade/TradeTable.tsx` — `deleteSelected()` (bug reproduced, with explanatory inline comment)
- `src/hooks/useTrades.ts` — `deleteTrade(tid: number)` (comparison point)

**Planned resolution:** To be addressed in an explicit, separately-approved
post-migration bug-fix phase. **Do not fix during ongoing migration
phases** unless explicitly requested.

---

### 🐛 KI-002 — Rating Gauge scale labels (0–5) never render

**Status:** Confirmed present in the original app; preserved visually in migration (Phase 6).

**Symptom:** The "⭐ Avg Personal Rating" gauge widget on the Dashboard
shows a colored gradient bar but no "0 1 2 3 4 5" scale labels underneath
it, despite the original code appearing to render them.

**Root cause:** Original code: `h("span","0")` — the second argument to
`React.createElement` is the **props** object, not children. Passing a
string causes React to iterate its character indices as prop names; no
children (the visible text) are ever passed. The spans render empty.

**Location in migrated code:** `src/components/charts/RatingGauge.tsx` —
reproduces the same visual result (six empty `<span>` elements) since JSX
cannot directly express the broken `createElement` call. Documented
extensively inline.

**Planned resolution:** To be addressed in an explicit, separately-approved
post-migration bug-fix phase.

---

### 🐛 KI-003 — Calendar day cells showed a "clickable" cursor that did nothing

**Status:** Present in the original app; RESOLVED (not preserved) in Phase 10, per explicit pre-approval.

**Symptom:** In the original app's Calendar tab, day cells containing trades
set `cursor: pointer` in their inline style, visually implying they were
clickable — but no `onClick` handler existed anywhere on the cell. Clicking
a day did nothing.

**Root cause:** Incomplete implementation — the visual affordance (pointer
cursor) was added but the interaction it implied was never built.

**Resolution:** The original migration plan (approved before any migration
work began) explicitly scoped "Click Day → Show Trades" as part of the
Calendar Page's Phase 10 deliverable. Phase 10 completes this pre-approved
feature: clicking a day with trades now opens a read-only list of that
day's trades (see `pages/Calendar.tsx` → `DayTradesModal`). This is *not*
a silent bug fix during migration — it was explicit, scoped, and approved
work for this specific phase, disclosed here for a complete audit trail
since the original behavior (dead cursor, no interaction) technically
changed.

**Location in migrated code:** `src/pages/Calendar.tsx`

---

### 🐛 KI-004 — Strategy page's Before/After 9:30 trade count shows no "trades" label when count > 0

**Status:** Confirmed present in the original app; preserved exactly in Phase 11.

**Symptom:** In the "Before vs After 9:30 AM" comparison on the Strategy
page, the trade-count text should read e.g. "12 trades" but instead shows
just the bare number "12" whenever there is at least one trade in that
period. The word "trades" only appears when the count is exactly 0
(showing "0 trades").

**Root cause:** Operator precedence bug in the original app:
`d.trades||0+" trades"`. In JavaScript, `+` binds tighter than `||`, so
this parses as `d.trades || (0+" trades")`, i.e. `d.trades || "0 trades"`.
When `d.trades` is any truthy number, the expression evaluates to that
bare number — the `"0 trades"` fallback string is only ever reached when
`d.trades` is falsy (0).

**Resolution:** Preserved exactly, per your instruction. Reproduced with
an inline comment in `pages/Strategy.tsx` pointing back to this entry.

**Location in migrated code:** `src/pages/Strategy.tsx` (Before/After 9:30 block)

---

### 🐛 KI-005 — `cleanNum()`'s ternary is dead code (both branches return the same value)

**Status:** Confirmed present in the original app; preserved exactly in Phase 13.

**Symptom:** None visible — the function behaves correctly. This is a
code-quality observation, not a functional bug.

**Root cause:** The original app's `cleanNum()` function:
```js
function cleanNum(v){
  var s=cleanVal(v).replace(/,/g,"");
  return isNaN(+s)||s===""?s:s;
}
```
The ternary's condition (`isNaN(+s)||s===""`) is evaluated, but BOTH the
true branch and false branch return the exact same value, `s`. The
condition has no effect on the output whatsoever — the function always
just returns `cleanVal(v)` with commas stripped, regardless of whether
the result is numeric or empty.

**Resolution:** Preserved exactly in `services/importService.ts`'s
`cleanNum()`, with an inline comment noting the dead condition. Since
the function's actual behavior (strip commas) is unaffected by this
dead code, there was nothing to "fix" without changing the function's
signature/purpose — simplifying the ternary away would be a code
cleanup, not a behavior preservation, so it was left exactly as-is.

**Location in migrated code:** `src/services/importService.ts`

---

## Migration-Introduced Corrections (Not Original Bugs — Fixed During Migration)

These were regressions I introduced during migration (not present in the
original app), caught during Phase 7 Validation, and corrected in Phase 7B.
Listed here for a complete audit trail.

### ✅ Fixed — `_tid` type drift (Phase 2B → corrected Phase 7B)
Original: `_tid` is always a `number` (`Date.now()`). Phase 2B's `addTrade`
incorrectly wrapped it as `String(Date.now())`. Restored to `Date.now()`
(number) in Phase 7B. See KI-001 above for the side effect this restoration reintroduces.

### ✅ Fixed — `mergeLists` empty-array handling (Phase 2A → corrected Phase 7B)
Original: `merged[k] = (saved && saved[k]) || DEFAULT_LISTS[k]` — an empty
saved array `[]` is truthy in JS, so an intentionally-emptied list stays
empty. Phase 2A's `mergeLists` incorrectly checked `.length > 0`, silently
resetting emptied lists back to defaults. Restored to the exact original
truthy-OR logic in Phase 7B.

---

## Architecture Notes (Not Bugs)

### 📝 AN-001 — `useAnalytics` (Phase 2B) initially unused by Dashboard (Phase 6)

`Dashboard.tsx` recomputes win-rate/R/P&L math inline rather than
consuming the `useAnalytics` hook. This mirrors the *original* app, which
also computed everything inline inside `DashboardTab` (no shared analytics
module existed). Not a defect — noted for a future consolidation pass.

**Update (Phase 8):** `useAnalytics.ts`'s internal `computeStreaks`
function was relocated to `calculations/streaks.ts` as part of the Phase 8
Analytics Engine work (a purely structural move, logic unchanged and
re-verified — see Phase 8 report). This is the first step toward
resolving AN-001; full consolidation is deferred to a later phase.

### 📝 AN-002 — No keyboard shortcuts exist in the original app

Confirmed via full-text search across the original source. Nothing to
migrate; not a gap in the migration.

### 📝 AN-003 — `Sidebar.tsx` remains an unused placeholder

Added in Phase 4 per the approved migration plan's file list, for a
possible future layout redesign. Not imported or wired into `AppShell`.

### 📝 AN-004 — Phase 11 centralized 6 metrics/aggregations previously computed independently per-page

Two consolidations were made in Phase 11, both numerically verified to
produce byte-identical output to what was being computed before:

1. `calculations/rolling.ts` gained a new exported `summarizeTrades()`
   function — field-for-field identical to the original app's `aggG(ts)`
   helper, which the original app already shared across StrategyTab,
   DailyTab, WeeklyTab, and MonthlyTab. `aggregateByPeriod()` (Phase 8)
   was refactored to call it internally instead of duplicating the same
   green/red/totalR/netPL/winRate math. The new Strategy page (Phase 11)
   consumes it directly for all of its by-field groupings and its
   Before/After 9:30 comparison.
2. `pages/Strategy.tsx` consumes `avgPlannedR`, `avgActualR`,
   `avgHoldingMins`, `avgWinningHoldingMins`, and `avgLosingHoldingMins`
   from `useAdvancedAnalytics()`'s `core` object (`calculations/
   analytics.ts`, Phase 8) instead of recomputing them inline, as the
   original app did (and as `Dashboard.tsx` in Phase 6 still does, since
   the analytics engine did not exist yet at that point in the
   migration — see AN-001).

Both changes are internal-only; no page's rendered output changed as a
result. This is expected to continue: as later phases build pages that
need metrics `Dashboard.tsx` currently computes inline, those inline
computations should similarly be migrated to consume the shared
`calculations/` modules rather than being copied — full consolidation
of `Dashboard.tsx` itself is deferred to a dedicated future phase, per
the "temporary duplication acceptable during migration" rule.

### 📝 AN-005 — Insights page reuses `summarizeTrades().avgR`, NOT `core.avgActualR`, for its overall Avg R

Two "average R" formulas now coexist in the centralized calculation
layer, and they are NOT interchangeable:

- `calculations/analytics.ts`'s `core.avgActualR` — filters out trades
  with a null `_r` BEFORE averaging (`mean` over only the valid values).
- `calculations/rolling.ts`'s `summarizeTrades(ts).avgR` — sums `_r ?? 0`
  over ALL trades in `ts` and divides by `ts.length`, so a trade with no
  `_r` (e.g. an incomplete/open trade) still counts in the denominator
  as a zero-R contribution, diluting the average.

The original app's `InsightsTab` (and `Dashboard.tsx`'s Phase-6 `avgR`)
both use the second convention. Phase 12 verified this distinction and
deliberately reused `summarizeTrades().avgR` for the Insights page's
overall Avg R, Plan-Followed comparison averages, Total R, and Net P/L
— NOT `core.avgActualR`, which would have silently changed this page's
numbers versus the original app whenever any trade has an incomplete
R value. This is documented here as a reusable reference for any future
phase touching Dashboard.tsx or building new pages that need an
"average R" figure: check which convention is needed before choosing
which shared function to call.

### 📝 AN-006 — Phase 13 Import Wizard: pre-approved scope additions and one UX decision

Two features were added to the Import Wizard that did NOT exist in the
original app: **Duplicate Detection** and an accurate import-count on
the "Import" button. Both are documented here for a complete audit trail.

1. **Duplicate Detection** was explicitly pre-scoped in the original
   migration plan's IMPORT/EXPORT section, approved before any
   migration work began: *"Improve existing import system. Support:
   CSV, Excel, Better Validation, Duplicate Detection, Column Mapping
   Improvements, Import Preview, Error Report."* `detectDuplicate()`
   (`services/importService.ts`) uses a 4-field heuristic (same date +
   symbol + entryPrice + direction as an existing trade). This is a
   deliberate, documented choice of matching rule — not the only
   possible one, and it can produce false positives for two genuinely
   different trades that happen to share all 4 fields (e.g. two
   identical scalps at the same price). The tool never silently drops
   flagged rows: a "Skip likely duplicates" checkbox (default ON) gives
   the user full control, and turning it off imports everything
   including flagged rows.

2. **Import button shows the actual count that will be imported**
   (`rows.length - duplicateCount` when skip-duplicates is on) rather
   than the original app's fixed `rawRows.length` (always the total
   parsed row count, regardless of what would actually be imported).
   This is a direct, necessary consequence of implementing the
   pre-scoped Duplicate Detection feature properly — a user turning on
   "skip duplicates" needs to see how many trades will actually be
   added, not a stale total. Not a general UI redesign; scoped
   entirely to making the new duplicate-skip feature legible.

3. **"Error Report" scope item**: the original app's post-import
   message only ever showed a success count. This phase extends that
   message to also report how many rows were skipped as duplicates,
   when applicable — the smallest possible interpretation of the
   pre-scoped "Error Report" item, not a new reporting subsystem.

No other feature was added. No new file formats, no new column-mapping
UI beyond the existing read-only display carried over from the
original app, no modal-layout redesign.

### 📝 AN-007 — Phase 14 Advanced Filters: built as a standalone, opt-in capability, not wired into any existing page

The original migration plan (approved before any migration work began)
explicitly listed under ADVANCED FILTERS: *"Support filtering by
everything. Allow: Multiple Filters, AND / OR, Saved Filters, Favorite
Filters, Quick Filters."* This is genuinely new functionality with no
original-app equivalent (the original app only ever supported simple,
hardcoded field=value AND-only filters).

Per this phase's explicit "do not redesign the UI" rule, the new
`calculations/filterEngine.ts`, `hooks/useAdvancedFilters.ts`, and
`components/filters/*` were built and fully validated, but are **not
consumed by any existing page** — Raw's 4-field filter, the global
account/market FilterBar, and Strategy's Multi-Filter Comparison tool
all continue to work exactly as before, completely untouched.

This mirrors the Phase 8 precedent exactly: `useAdvancedAnalytics` was
built and validated a full phase (Phase 8) before any page consumed it
(Phase 9's Equity page). The Advanced Filters capability is now
similarly "ready and tested," awaiting a future phase's explicit,
separately-approved decision about which page(s) should offer it and
how, so that wiring it in can itself be reviewed as its own scoped
change rather than bundled into this phase's UI-preservation guarantee.

**Operator scope** (documented, intentional): 'equals', 'notEquals',
'contains', 'gt', 'gte', 'lt', 'lte' — a curated set covering
categorical and numeric trade fields, not an open-ended expression
language. "Filtering by everything" is interpreted as "any trade field
can be used as a condition," not "arbitrary boolean/regex/date-range
expressions" — avoiding over-engineering beyond what was requested.

**Case sensitivity** (documented, intentional): `equals`/`notEquals`
use case-sensitive exact string match, matching the existing app-wide
convention (Raw's filters and Strategy's Multi-Filter Comparison both
use strict `===`). `contains` is deliberately case-INSENSITIVE — a
substring search is far less useful case-sensitively — this is the one
documented exception to the app's existing case-sensitivity convention.

**Storage**: a new, additive LocalStorage key `fxj_v4_saved_filters`
was introduced. No existing key was touched; a user with no saved
filters simply gets an empty array (`loadSavedFilters()` returns `[]`
on a missing key, following the same pattern as `loadTrades()`).

### 📝 AN-008 — Phase 15 Trade Review: scope, data model, and a same-phase duplication fix

**Scope**: The original migration plan's TRADE REVIEW section reads:
*"Rating, psychology, checklist, custom fields."* Rating
(`personalRating`) and psychology (`emotions`) ALREADY existed as
`RawTrade` fields, captured by `TradeForm.tsx` since Phase 5 — the
original app never had a separate "Trade Review" page or component;
this data was always part of the single trade-entry form (confirmed by
a zero-hit search of the original app reference for any review/
checklist component). Phase 15 therefore adds ONLY the two genuinely
missing capabilities: **Checklists** and **Custom Fields**.

**Data model decision**: Checklist completions and custom field values
are stored SEPARATELY from `RawTrade` (new keys, keyed by trade
`_tid`), rather than adding new fields to the `RawTrade` interface.
This means the `RawTrade` schema is completely unchanged — zero risk
to existing trade data — and `TradeForm.tsx` was not modified.

**Scope containment**: Exactly mirroring the Phase 14 Advanced Filters
precedent, all Phase 15 code (`calculations/tradeReview.ts`,
`hooks/useTradeReview.ts`, `components/trade/TradeReview.tsx`,
`components/trade/TradeReviewSettings.tsx`) is new, validated, and
**not wired into any existing page** in this phase. Verified via
`grep` — zero references from any page or from `TradeForm.tsx`/
`TradeTable.tsx`/`TradeRow.tsx`.

**Same-phase duplication catch and fix**: While writing
`tradeReview.ts`, an ID-generation helper (`nextId()`) was initially
written as a second, independent copy of the identical function
already introduced in `filterEngine.ts` (Phase 14). This was caught
during this phase's own self-review — consistent with the explicit
"search for duplicated utility functions" verification requested for
Phase 14 — and immediately consolidated into a new shared module,
`calculations/idGenerator.ts`, which both `filterEngine.ts` and
`tradeReview.ts` now import from. Re-verified numerically identical
behavior in both call sites after the consolidation (22/22 filter-
engine checks unchanged, 20/20 new trade-review checks pass).

### 📝 AN-009 — Phase 16 Settings: migrated list editor, newly-wired existing hooks, deferred Theme

**List Editor — faithful migration**: `components/settings/
ListEditor.tsx` is migrated verbatim from the original app's
`SettingsManager` component. It contains zero list-manipulation
business logic of its own — `addItem`/`removeItem`/`moveUp`/`moveDown`/
`editItem` are thin array-shape builders that hand the new array to
`onChange` (= the EXISTING `useLists().updateList`, Phase 2A), exactly
matching the original's `props.onChange`/`props.onReset` delegation
pattern. This is the first phase to actually render a UI for the
`useLists` hook.

**General Settings — first UI for an existing hook**: `useSettings()`
(Phase 2A) had zero consuming UI until this phase. `GeneralSettings.tsx`
is a new, thin wrapper exposing `currency`/`riskPercent` — again, zero
settings-persistence logic of its own.

**Backup & Restore — new, pre-approved, zero duplicated persistence**:
`services/backupService.ts` is pure composition over all 10 EXISTING
`load`/`save` pairs in `storage.js` (trades, accounts, lists,
propRules, settings, savedFilters, checklistTemplates,
checklistCompletions, customFieldDefs, customFieldValues) — it contains
no persistence logic of its own, only orchestration. Adding an 11th
storage key in a future phase requires exactly one new line in
`BACKUP_SECTIONS`, not a parallel implementation.

**Theme — explicitly deferred, not built**: The original migration
plan's SETTINGS section listed "Theme" as a pre-approved item. A real
theme system (e.g. a light mode) would require touching the hardcoded
`COLORS` object consumed by every single component in the codebase —
this is unambiguously a redesign, not a migration, and directly
conflicts with this phase's "do not redesign any existing UI" rule. No
theme toggle (functional or placeholder) was built. This is intentionally
deferred to a future, explicitly-scoped phase, not silently dropped.

**Composition decision — three separate components, not one merged
modal**: `ListEditor` (a faithful migration of the original's specific
list-editing modal), `GeneralSettings`, and `BackupPanel` are kept as
three independent, standalone components rather than combined into one
new "Settings" modal. Deciding how (or whether) to compose them into a
single settings surface is itself a UI-workflow decision, deferred to
a future phase alongside the Header/AppShell wiring work (see AN-003 —
`Sidebar.tsx` remains a similarly-deferred placeholder for the same
reason: composition/layout decisions are left for an explicitly-scoped
wiring phase, not decided implicitly while building the underlying
capability).

**Scope containment**: Consistent with Phases 8/9/14/15, none of this
phase's code is wired into any existing page — verified via `grep`,
zero references from any page file.

**Comment-syntax bug caught during this phase's own build**: Two files
(`backupService.ts`, `BackupPanel.tsx`) initially contained the literal
text `load*/save*` inside a JSDoc block comment. Since JS block
comments cannot be nested, that `*/` was interpreted as the comment's
CLOSING delimiter, corrupting everything after it into invalid syntax.
Caught immediately by this phase's own syntax validation step (93
files checked, 2 failed) and fixed by rewording the comment text
before any further work proceeded. Not a logic bug — the malformed
code never executed (it failed to parse) — noted here for completeness
per your dead-code/duplication verification request.

### 📝 AN-010 — Phase 17 Performance: memoization applied directly, virtualization built standalone

**Risk-calibrated scope decision**: the original migration plan's
PERFORMANCE section lists *"Support 100,000+ Trades, Virtualized
Tables, Memoized Calculations, Lazy Loading, Background Calculations,
Fast Search, Fast Filtering."* Two categories of change carry very
different risk profiles:

1. **Memoization** (wrapping an already-correct, already-pure
   computation in `useMemo`) cannot change WHAT is computed — only
   WHEN. This is provably safe: the exact same expressions, copied
   verbatim, now only re-run when their actual inputs change instead
   of on every render. Applied directly to `Dashboard.tsx`,
   `Equity.tsx`, `Calendar.tsx`, and `Insights.tsx` — the four pages
   that had little-to-no memoization of their derived-data blocks
   (verified via audit: Dashboard 0 real `useMemo` calls before this
   phase — its "1" grep hit was only a comment; Equity 0; Calendar 0;
   Insights 0; Strategy already had 11 and was left untouched).

2. **Virtualization** (windowed/partial DOM rendering) is a genuinely
   structural change to an existing component's rendering strategy,
   with real regression risk around scroll behavior, row-height
   consistency, and interaction with `TradeTable.tsx`'s existing bulk-
   select/edit/delete columns. Consistent with the "do not redesign
   any existing UI" rule and the precedent already established for
   `useAdvancedAnalytics` (Phase 8→9), Advanced Filters (Phase 14), and
   Trade Review (Phase 15): built and thoroughly validated as a new,
   generic, standalone `components/ui/VirtualizedList.tsx` primitive,
   NOT wired into `TradeTable.tsx` in this phase. A future,
   explicitly-scoped phase can wire it in with your separate approval.

**Verification method for the memoization changes**: since this
sandbox cannot run actual React rendering, each refactored page was
verified via (a) exact pre/post block-text comparison confirming the
wrapped code is byte-identical to the prior implementation, (b) an
automated field-by-field cross-check confirming every value
destructured from a `useMemo` result is actually present in that
memo's `return {}` (a bug class my per-file syntax validator cannot
catch, since it only transpiles, it does not type-check), and (c) a
dependency-array audit confirming every external value read inside
each memo callback is listed in its dependency array (ruling out stale
values) — see the Phase 17 validation report for the full check-by-
check results.

**Hooks-order note (pre-existing, not introduced this phase)**:
`Insights.tsx`'s `useAdvancedAnalytics()` call sits after an early
`return` (the empty-trades guard), a conditional-hook-call pattern
that predates Phase 17 (introduced in Phase 12). Flagged here per "do
not fix unless explicitly requested" rather than silently changed —
the new Phase 17 `useMemo` was placed carefully so it does not make
this pre-existing pattern any worse.

**"Fast Search / Fast Filtering" — no code added**: `calculations/
filterEngine.ts` (Phase 14) already performs a single-pass O(n)
`.filter()`, which is the optimal approach for an arbitrary predicate
over an unindexed array — there is no meaningfully "faster" general
approach without speculative indexing tied to specific, currently-
unknown query patterns. Adding such indexing now would be unfounded
over-engineering (per your explicit Phase 12 "avoid over-engineering"
rule, still in effect), so nothing was added here; this scope item is
considered served by the existing implementation plus this phase's
memoization work (avoiding redundant re-filtering on unrelated
re-renders).

**"Lazy Loading" / "Background Calculations" — deferred, not started**:
Neither was addressed this phase. Lazy Loading (route/component-level
code splitting) is an App Shell/bundling concern tied to the deferred
Phase 4 wiring work; Background Calculations (e.g. Web Workers for the
Analytics Engine) would be a substantial architectural addition
warranting its own dedicated, explicitly-scoped phase rather than a
partial implementation bundled into this one.

**Dead code found and removed (pre-existing, not introduced this
phase)**: `pages/Equity.tsx` imported `fr` from `calculations/
formatters.ts` but never used it — the page has always used inline
`.toFixed()`/`.toLocaleString()` formatting directly (confirmed
unchanged since Phase 9). Caught by this phase's explicit dead-code
verification step and removed, since an unused import carries zero
runtime behavior and its removal cannot change any output — the safest
possible class of cleanup. Not counted as an issue "introduced during
Phase 17."

### 📝 AN-011 — Phase 18 Data Safety: soft-delete/restore-points as standalone architecture, delete workflow untouched

**Scope**: The original migration plan's DATA SAFETY section lists
*"Automatic Backups. Restore Points. Undo Delete. Soft Delete.
Recovery Bin."* All five are related facets of one underlying need —
a way to recover from an accidental or unwanted change.

**Critical scope decision**: `hooks/useTrades.ts`'s existing
`deleteTrade`/`deleteAllTrades` (Phase 2B, fixed Phase 7B) were **not**
modified to automatically soft-delete. Doing so would change the
existing Raw page's actual delete behavior (what happens the instant
you click "Del") — a workflow change, not an addition, and explicitly
out of scope under "do not redesign any existing UI or workflow."
`useTrades.ts`'s fingerprint was re-verified unchanged after this
phase. The new `useRecoveryBin()` hook is generic (`<T>`) and fully
usable, but is not wired into any delete button in this phase —
consistent with the precedent from Phases 8, 14, 15, and 17.

**"Undo Delete" — served by the Recovery Bin itself, not a separate
mechanism**: rather than building a second toast/snackbar-style undo
system, the Recovery Bin already surfaces the most-recently-deleted
item first (sorted by `deletedAt` descending) — restoring it IS the
undo action. Avoids two overlapping mechanisms for the same need, per
the established "avoid over-engineering" rule.

**"Automatic Backups" and "Restore Points" share one implementation**:
`maybeCreateAutoBackup()` calls `createRestorePoint()` directly — an
automatic backup literally IS a restore point (same data shape, same
storage key, same `MAX_RESTORE_POINTS` cap), created on a time-based
throttle (24h, `AUTO_BACKUP_INTERVAL_MS`) instead of a button click,
distinguished only by an `"Auto: "` label prefix. Both, in turn, reuse
`buildBackup()`/`restoreBackup()` from Phase 16 with zero new
snapshot-building or snapshot-applying logic — verified via grep that
no other file re-implements the section-iteration pattern.

**One new shared utility, deliberately not applied retroactively**:
`services/storage.js` gained a small `loadArrayOrDefault(key)` helper,
used only by the two NEW Phase 18 key pairs (`RECOVERY_BIN`,
`RESTORE_POINTS`). The 10 pre-existing `load*` functions (Phases 1,
2A, 14, 15) still use their original inline
`Array.isArray(data) ? data : []` pattern and were deliberately left
untouched — retroactively refactoring already-validated, already-
shipped code for a purely cosmetic consolidation carries real
regression risk for zero behavioral benefit. Consolidating only the
new additions avoids adding to the duplication without touching stable
code, consistent with the same reasoning applied throughout this
migration (e.g. Phase 6's Dashboard/Insights `avgR` duplication,
deliberately left in place — see AN-001, AN-005).

**Retention policy assumptions** (not user-configurable in this
phase): Recovery Bin entries expire after 30 days
(`RECOVERY_BIN_RETENTION_MS`); Restore Points are capped at 10, oldest
dropped first (`MAX_RESTORE_POINTS`, `addRestorePoint`'s FIFO logic);
automatic backups are throttled to once per 24 hours
(`AUTO_BACKUP_INTERVAL_MS`). All three are reasonable, documented
defaults balancing usefulness against unbounded LocalStorage growth.

**`maybeCreateAutoBackup()` has zero callers in this phase, by
design**: it is a complete, unit-tested public API function meant to
be invoked once on app startup by a future App Shell wiring phase —
the same "validated but not yet wired" pattern already established for
`buildBackup()`/`restoreBackup()` in Phase 16 (which also had zero
external callers until their own file's other functions used them).
Confirmed not dead code by direct unit test (see Phase 18 validation
report) — a function that has no callers YET, but is exported,
documented, and independently correct, is different in kind from
actual dead code (unreachable or genuinely useless code).

**Rule 7 compliance**: the Phase 17 conditional-hook-call observation
in `pages/Insights.tsx` (documented in AN-010) was left completely
untouched this phase — `Insights.tsx` was not modified in Phase 18 at
all, confirmed via fingerprint match.

### 📝 AN-012 — Phase 19 Integration: the application is now reachable end-to-end

**What changed**: `src/App.jsx` was replaced from the Phase 0 static
placeholder with the real application root, wiring together all core
hooks (`useAccounts`, `useTrades`, `useLists`, `useSettings`,
`useFilters`) and all 6 built pages (Dashboard, Raw, Equity, Calendar,
Strategy, Insights) through `AppShell` (Phase 4). Verified via a full
dependency-graph traversal from `main.jsx`: 0 broken imports, 81 files
now reachable (versus effectively 1 — the placeholder — before this
phase).

**Two components built this phase to fill genuine migration gaps**
(not new feature development — both existed in the original app and
were flagged as missing in the pre-Phase-19 Architecture Cleanup
audit):
- `components/account/AccManager.tsx` — the original app's Account
  Manager was never migrated in Phases 1-18, even though its backing
  hook (`useAccounts`) has existed since Phase 2B. Migrated verbatim
  from the original app now, since "wire account management" requires
  something to wire.
- `components/settings/SettingsModal.tsx` — a NEW composite wrapper
  (introduces zero new business logic) implementing the composition
  decision explicitly deferred in Phase 16 (AN-009): every previously
  standalone-but-unwired capability from Phases 14/15/16/18 (Advanced
  Filters, Trade Review templates, General Settings, Backup/Restore,
  Recovery Bin) is now reachable through ONE modal, behind the same
  single ⚙ button the original app used — section-switcher UI, not a
  redesign of the original entry point.

**Integration bug caught and fixed during this phase's own build**:
`ListEditor.tsx` (Phase 16) renders its own top-level `<Modal>`
internally, by design. My first draft of `SettingsModal` embedded it
as an inline section, which would have stacked two Modal overlays — a
genuine visual bug. Caught before any validation was run, fixed by
keeping `ListEditor.tsx` completely unmodified and instead giving the
General section a "Manage Dropdown Lists" button that closes
`SettingsModal` and opens `ListEditor` as its own separate, mutually-
exclusive top-level modal. Zero changes to `ListEditor.tsx` itself.

**Known limitations, explicitly not addressed this phase (integration-
only, no redesign permitted)**:
1. The "+ New Trade" header button switches to the Raw tab but cannot
   imperatively open Raw's internal Add-Trade form, since `RawPage`
   (Phase 5) intentionally owns that modal state itself with no
   exposed "open" prop. Opening the form still requires the existing
   "+ Add Trade" button inside the Raw page itself. Changing this
   would mean modifying `Raw.tsx`'s existing prop surface — out of
   scope for integration-only work.

   > **SUPERSEDED post-Phase-19.** Fixed by adding
   > `openAddTrigger`/`onAddSignalHandled` to `RawPage` and an
   > `openAddPending` flag in `App.jsx`; the header button now switches
   > tab *and* opens the form. See the `App.jsx` and `pages/Raw.tsx`
   > file headers. Noted here during the Phase 22 documentation pass.
2. `components/trade/TradeReview.tsx` (the PER-TRADE checklist/custom-
   field view, Phase 15) is still not wired — it needs a specific
   trade's `_tid`, which means embedding it into `TradeForm.tsx` or
   `TradeRow.tsx`, both existing components this phase must not modify.
   `TradeReviewSettings.tsx` (the template/field DEFINITION UI) IS
   wired, via SettingsModal's "Checklists & Fields" section.
3. SavedFiltersList's "Apply" action (inside the Advanced Filters
   section) does not restrict what Dashboard/Equity/Calendar/Strategy/
   Insights display — doing so would require threading a new filter-
   group concept into the trades pipeline every page already consumes,
   a genuine architectural addition rather than "wiring reachable."

   > **SUPERSEDED by Phase 22 (2026-08-04).** This limitation no longer
   > applies. "Apply" now sets a global lens that narrows Dashboard,
   > Raw, Equity, Calendar, Strategy and Insights. The architectural
   > addition anticipated above is `calculations/visibleTrades.ts`; see
   > AD-016. The Backtest page is deliberately exempt and still
   > consumes unfiltered `allTrades`. The original text is retained
   > because it was accurate as of Phase 19.
4. `useRecoveryBin()` is wired and the Recovery Bin panel is fully
   functional and reachable, but `useTrades().deleteTrade` still is
   NOT connected to it (per AN-011, preserved deliberately) — the bin
   will show real entries only once a future phase makes that
   connection.

   > **SUPERSEDED post-Phase-19.** That connection was made:
   > `App.jsx`'s `handleSoftDeleteTrade` captures the original
   > `RawTrade` from `rawTrades` and calls `softDelete()` before
   > `deleteTrade()`, at both the single and bulk delete call sites.
   > The bin now receives real entries. Noted here during the Phase 22
   > documentation pass.
5. The original single-file app's Prop Firm Tracker and Position Size
   Calculator tabs were never migrated to this modular architecture in
   any of Phases 1-18 — there is nothing to wire for them. Not an
   integration bug; a pre-existing migration gap, noted here for
   completeness.

**Scope discipline confirmed**: all 7 calculation-module fingerprints
verified byte-identical to their Phase 18 state; all 6 page files
confirmed untouched via file-modification timestamps (every page shows
a timestamp from its own original migration phase, not this session).
No LocalStorage key was added, removed, or changed. No file was
renamed. No dead code was removed (the Architecture Cleanup audit's
findings remain open, awaiting your explicit approval per finding).

### 📝 AN-013 — Phase 20 Architecture Cleanup & Final Verification

**Executed cleanup items** (all verified via regression testing before
being considered complete):

1. **Dead code removed** (Bug classification: none of these were bugs —
   all were confirmed-unreachable code with zero behavioral role):
   - `hooks/useAnalytics.ts` deleted — confirmed zero real callers
     anywhere (finding H-1). Superseded by `summarizeTrades()` +
     `computeStreaks()`, already used directly elsewhere.
   - `types/filter.js` deleted — confirmed zero imports anywhere.
   - Empty `contexts/` folder removed.
   - `createAccount()` factory removed from `types/account.ts` —
     discovered mid-cleanup to have zero callers (AccManager builds
     account objects inline instead).
   - Barrel exports (`hooks/index.ts`, `types/index.js`) updated to
     remove references to all of the above.

2. **H-2 fixed — dependency-direction violation** (Architecture
   Improvement): `Account` and `RawTrade` were each defined twice —
   once as an unused JSDoc `@typedef` in `types/`, once as the real,
   actively-used TypeScript `interface` inside a hook file
   (`hooks/useAccounts.ts` / `hooks/useTrades.ts`). This meant
   `calculations/tradeCalc.ts` and `services/importService.ts` — pure
   business logic — had to import types FROM hook files, violating
   "business logic must never depend on UI." Fixed surgically: the
   canonical interfaces now live in `types/account.ts` / `types/
   trade.ts` (converted from dead `.js` JSDoc files to real `.ts`);
   the hook files import and RE-EXPORT them, so all 10+/4+ existing
   `import type {...} from '@hooks/...'` call sites continue to work
   completely unchanged (zero risk, zero behavior change — confirmed
   via 43 regression checks against freshly re-transpiled source).
   `tradeCalc.ts` and `importService.ts` now import directly from
   `types/`, resolving the actual violation. Verified via a full
   circular-dependency scan: zero cycles (see item 6 below for a
   methodology note on this check).

3. **H-3 fixed — Dashboard.tsx duplicated calculation logic removed**
   (Duplicated Logic): Dashboard's inline `green`/`red`/`be`/`totalR`/
   `avgR`/`netPL` re-derivation was replaced with a single
   `summarizeTrades(trades)` call (calculations/rolling.ts, Phase 11).
   Only the `wr` STRING formatting (a display concern, not a
   calculation) stays local to the page. Verified byte-identical
   output across 353 checks (50 randomized trials + edge cases) before
   this was considered complete.

4. **M-4 fixed — Calendar's magic hex colors centralized** (Technical
   Debt): `'#0F2A1A'`, `'#2A0F0F'`, `'#22C55E44'`, `'#EF444444'` moved
   to named `COLORS.winBg` / `.lossBg` / `.winBorder` / `.lossBorder`
   constants. Exact same hex values — zero visual change.

5. **M-2 partially fixed — shared `groupTradesBy()` helper extracted**
   (Duplicated Logic): added to `calculations/rolling.ts`. Migrated
   `Insights.tsx`'s 3 near-identical `Record<key, Trade[]>`
   accumulation blocks (setupGroups/sessGroups/hourGroups) to use it.
   Verified byte-identical grouping behavior across 67 checks,
   including the more complex hour-key-derivation case. Dashboard's
   `byMo`/`bySym`/`byHour` (which store pre-aggregated `{r, mkt/n}`
   values, not full trade arrays) and Calendar's `byDay` were NOT
   migrated — different data shape, would need a second helper
   variant; deferred to a future pass rather than rushed into this
   phase (documented under "Known Limitations" below).

6. **Documentation-only fix — backup/restore-point exclusion clarified**
   (mixed classification: RESTORE_POINTS exclusion = confirmed correct
   by design; RECOVERY_BIN exclusion = Technical Debt, low severity):
   discovered `services/backupService.ts`'s `BACKUP_SECTIONS` list
   covers only 10 of the app's 12 LocalStorage keys — `RECOVERY_BIN`
   and `RESTORE_POINTS` are excluded. Investigated rather than silently
   "fixed": RESTORE_POINTS' exclusion is correct and load-bearing
   (including a snapshot of "all restore points" inside each restore
   point would be self-referential — restoring an old backup would
   silently overwrite the current restore-point list with a stale
   one). RECOVERY_BIN's exclusion is a genuine but currently-inert gap
   (the bin is always empty today, since `useTrades().deleteTrade`
   isn't connected to `softDelete()` per AN-011) — flagged for
   reconsideration whenever that connection is made, not fixed now
   (fixing it would change `buildBackup()`'s output shape, a genuine
   behavior change requiring separate approval). Added an explanatory
   comment; `BACKUP_SECTIONS` itself was NOT modified.

**Audits performed (verification only, see Phase 20 report for full
results)**:
- **React Audit**: confirmed the ONLY conditional-hook-call pattern in
  the codebase is the already-documented, deliberately-preserved one
  in `Insights.tsx` (AN-010) — per your explicit rule 7, left
  unchanged. All 26 `useMemo`/`useCallback` call sites across the app
  had their dependency arrays manually or automatically verified
  complete (Strategy.tsx's 11 memos were audited for the first time
  this phase; all others were previously verified in Phase 17).
  Identified one Low-severity, undocumented-until-now finding: `App.
  jsx`'s `headerActions` and `filterAccounts` arrays are recreated on
  every render (not memoized) — negligible practical impact (a
  handful of header buttons/filter chips, not a large list), left
  unfixed and documented rather than risk touching `App.jsx` again for
  a cosmetic-performance concern (Technical Debt, Low severity).
- **Storage Audit**: all 12 LocalStorage keys verified to have exactly
  matching load/save function pairs (12:12:12). No obsolete keys
  found. Backup/restore coverage gap documented above.
- **Type/Interface Audit**: confirmed zero duplicate interface names
  exist anywhere in the codebase (directly resulting from the H-2
  fix). Manually re-verified prop-interface correctness for every
  component nested inside `SettingsModal` plus `TradeRow`/`TradeTable`
  (automated regex verification proved unreliable for interfaces
  containing function-type fields — false positives caught and
  corrected via direct manual comparison, the same lesson already
  learned in Phase 19).
- **Dependency Audit**: a full circular-dependency scan initially
  reported 2 false-positive cycles, caused by the audit script's own
  regex matching an EXAMPLE import statement written inside a
  documentation comment (in `types/account.ts`'s own file-header
  explaining the H-2 fix) as if it were real code. Corrected by
  stripping comments before analysis (the same technique already used
  for fingerprinting throughout this migration); confirmed **zero
  real circular dependencies** exist anywhere in the 100-file
  codebase. Re-ran the full dependency-graph traversal from
  `main.jsx`: 0 broken imports, 82 files reachable (up from 81 in
  Phase 19 — net effect of removing 2 previously-unreachable dead
  files while adding no new unreachable ones), 18 files remain
  unreachable, every one already explained by prior phases' scope
  notes (barrel `index.ts` files — never imported directly anywhere
  in this codebase's style; `Sidebar.tsx`, `TradeReview.tsx`,
  `ProgressBar.tsx`, `Spinner.tsx`, `VirtualizedList.tsx` — documented
  standalone/unwired components from Phases 4, 15, and 17).

**Deliberately NOT executed this phase** (documented, not silently
skipped — see the Phase 20 report's "Known Limitations" and
"Postponed to a Future Version" sections for full reasoning):
- M-1 (≈28 sites of inline `+`/`-`/`.toFixed()` formatting duplicating
  `fr.*`) — flagged as needing individual call-site verification in
  the original audit; deferred rather than risk a blanket change.
- M-3 (renaming `useFilters` → something less confusable with
  `useAdvancedFilters`) — cosmetic naming-clarity only, touches
  `App.jsx`; deferred as low-value-for-risk in this final phase.
- Dashboard/Calendar's remaining group-by duplication (see item 5
  above) — different data shape from `groupTradesBy()`'s current
  signature; deferred.

### 📝 AN-014 — Phase 20B Production Readiness Fixes

**Scope**: exactly the 5 items identified in the production-readiness
audit. No architecture refactor, no UI redesign, no calculation
changes, no business logic changes, no storage behavior changes.

1. **Critical bug fixed — Dashboard.tsx `ReferenceError`** (`pages/
   Dashboard.tsx`): `longs`/`shorts` were computed inside Phase 17's
   `useMemo` block but never added to its returned/destructured
   object, while the JSX below the memo still referenced them
   directly. This caused an unconditional `ReferenceError` on every
   Dashboard render — and with zero `ErrorBoundary` anywhere in the
   app (until this phase), this crashed the entire application on
   first load, since Dashboard is the default tab. Fix: added
   `longs, shorts` to both the memo's `return {}` and the outer
   destructuring — both values were already being computed; nothing
   about the calculation changed. Verified via a fresh field-list
   cross-check (return fields === destructured fields) and confirmed
   via real `tsc` that zero `TS2304` ("cannot find name") errors
   remain anywhere in the project.

2. **High bug fixed — `@types` path alias collision** (`vite.config.
   js`, `tsconfig.json`, and 5 source files): TypeScript reserves the
   literal prefix `@types/` for DefinitelyTyped-style ambient package
   scopes. Renamed the alias to `@apptypes` everywhere (the `types/`
   *folder* itself is unchanged — only the alias string). Proved the
   root cause in isolation before fixing (an identically-configured
   alias named anything else works fine; only the literal string
   `@types` triggers `TS6137`). Verified via real `tsc`: 0 `TS6137`
   errors remain (was 7).

3. **High gap fixed — global `ErrorBoundary` added** (`components/
   ErrorBoundary.tsx`, wired into `main.jsx` around `<App />`): the
   audit found zero error boundaries anywhere, meaning any single
   component-level error became a total, unrecoverable, blank-screen
   application failure — exactly what item 1 was doing in practice.
   Necessarily a class component (React provides no hook equivalent
   for `getDerivedStateFromError`/`componentDidCatch`) — the only
   class component in this codebase, by React's platform requirement,
   not a stylistic choice. Renders children unchanged when there's no
   error; shows a minimal fallback (reusing the existing `COLORS`
   palette, not a new visual language) with a reload button otherwise.

4. **High gap fixed — `TradeLike` interface completeness**
   (`calculations/tradeCalc.ts`): previously hand-declared only ~12 of
   `RawTrade`'s 39 fields; the rest silently fell through to
   `[key: string]: unknown`, providing no real compile-time safety for
   most trade fields and causing several genuine `tsc` errors (e.g.
   `t.account.trim()` failing to type-check). Fixed by deriving
   `TradeLike = Partial<Omit<RawTrade, '_tid'>> & { [key: string]:
   unknown }` — every field now gets its real, correct type from the
   canonical `RawTrade` interface (types/trade.ts), while the index
   signature remains as a safety net for anything unexpected. Type-
   level-only change: `enrichTrades()` and every consumer's runtime
   behavior is completely unchanged (every field was already present
   on real trade objects at runtime via the existing `...t` spread).
   Verified via real `tsc`: the `TradeTable.tsx` `.trim()` error and
   all 7 `exportService.ts` field-access errors are gone.

   **Also fixed as a direct, minimal consequence** (not separately
   listed, but required to let `tsc` cleanly resolve `TradeLike`-typed
   fields end-to-end): `calculations/formatters.ts`'s `formatDayShort()`
   parameter type was widened from `string` to `string | undefined` —
   its body already handled falsy input identically
   (`if (!date) return '—';` catches `undefined` exactly like `''`),
   so this is a type-signature correction with zero runtime behavior
   change, not a new business rule.

5. **Build/type-check status**: `npm install` still fails in this
   sandbox with `403 Forbidden` from the npm registry — re-verified
   at the start and end of this phase; this is a sandbox network
   policy, outside any code fix's ability to resolve. As a result,
   `npm run build`/`npm run preview` could not be executed even once,
   in this or any prior phase. What COULD be verified, and was: a
   real, global `tsc --noEmit` run (not the `ts.transpileModule()`
   per-file check used throughout Phases 1-20) against the actual
   project `tsconfig.json`. After all fixes: **zero non-environmental
   TypeScript errors remain.** The ~1,200 remaining `tsc` lines are
   100% attributable to the missing `node_modules` (no `@types/react`,
   `@types/node`, `recharts` types available in this sandbox) —
   confirmed via isolated reproduction (a working alias comparison for
   item 2) and via cross-referencing every remaining error's file list
   against files independently known to have "cannot find module"
   errors (100% overlap for the `TS7006`/`TS2339` "noise" categories).

   **One Medium/Technical-Debt item intentionally left unfixed**,
   since it was not one of the 5 explicitly-listed items and does not
   affect the "0 Critical / 0 High" bar: `backupService.ts`'s
   `BackupSection.save: (data: unknown) => void` is contravariantly
   unsound against the specific `save*` functions assigned into
   `BACKUP_SECTIONS` (6 `tsc` errors). No runtime bug currently
   exploits this — `restoreBackup()` always pairs the correct key with
   the correct function — but the type system doesn't structurally
   guarantee that stays true. Left for a future, explicitly-scoped
   pass per this phase's "do not refactor architecture" boundary.

### 📝 AN-015 — Phase 5 (Sync Architecture) known limitations, explicitly deferred

Three gaps discovered while building the sync engine (Phases 5a–5d),
each explicitly reviewed and deferred to a future, dedicated phase
rather than folded into Phase 5's approved scope. Listed here for
discoverability beyond the phase's own review transcript.

**1. No React state synchronization from Sync-Engine-driven storage
writes (found during Phase 5c).** `useTrades`/`useAccounts`/`useLists`/
`useSettings` hold their data in `useState`, updated only by their own
setters. The Sync Engine's store layer (`services/syncStores.ts`,
Phase 5a) reads/writes `services/storage.js` directly — a successful
push (marking a record `synced`), a tombstone purge, or a pull
applying incoming content from another device all happen with no
React setter ever called. Until something closes this, such changes
are invisible in the UI until the next full page reload. Pre-dates all
of Phase 5 (the hooks have always been plain `useState`, with nothing
to make it observable until the Sync Engine gave storage a second
writer) and does not violate any Phase 5c requirement — none of that
phase's approved scope covered this direction of data flow. Deferred
to its own dedicated phase, explicitly NOT folded into Phase 5d.

**2. No per-user LocalStorage namespacing, anywhere (found during
Phase 5d).** `services/storage.js`'s keys (`fxj_v4_trades`, etc.) are
fixed strings; no hook reads or writes based on the authenticated
user's ID. This pre-dates Phase 5 entirely — it would be true even
without any sync work — but SYNC_ARCHITECTURE_SPEC.md §3.5's design
("namespace every local store by `user_id`... never wholesale-cleared
on sign-out") depends on that namespacing existing: not clearing on
sign-out is only safe because each user's data is supposed to live in
its own slice. Practical consequence: on a shared device, signing out
and a different user signing in shows the previous user's local
trades/accounts/lists/settings. Explicitly scoped OUT of Phase 5d per
review — would require rewriting `storage.js`'s key scheme and every
hook's load/save calls, a foundational change warranting its own
phase, not an extension of "wire the auth session to start/stop the
engine."

**3. §3.5 sign-out sequence steps 1–2 not implemented (found during
Phase 5d).** Of the sign-out sequence's 5 steps, only step 3
(`stopSyncEngine()` — release leadership, cancel timers/listeners) and
its consequence, step 4 (reset in-memory state), are implemented.
Steps 1 and 2 are not:
  - **Step 1** — abort in-flight sync network requests, and guarantee
    any response arriving after sign-out begins is discarded without
    effect on `syncStatus`/`baseUpdatedAt`/cursor state. No
    cancellation/abort mechanism exists anywhere in `PushTransport`,
    `PullTransport`, or the LocalStore layer (confirmed via a full
    grep of `src/sync/` — zero real `AbortController`/`AbortSignal`
    usage), and adding one was explicitly ruled out for Phase 5d to
    avoid redesigning already-approved, already-frozen interfaces.
  - **Step 2** — revert every record left in `syncing` state.
    `runStartupReconciliation()` (scheduler.ts, §6.1) already performs
    exactly this rule, and an earlier draft of the Phase 5d sign-out
    path called it directly. Reviewed and reverted: that function is a
    startup concern, owned by the Scheduler's own "first cycle after
    becoming leader" orchestration — calling it from the sign-out path
    would hand the wiring layer a responsibility (deciding when
    reconciliation runs) that belongs to the Scheduler, a behavior
    change beyond what was approved for this phase, not merely a reuse
    of an existing function. A record stuck in `syncing` at sign-out is
    therefore only cleaned up the next time some tab becomes leader
    (ordinary startup reconciliation), not immediately at sign-out.
  Practical consequence of both gaps together: a push or pull already
  in flight when sign-out begins can still complete afterward and
  write its result, and any record left `syncing` by an interrupted
  request stays that way (excluded from the pending queue, per §3.2)
  until the next leader-election-triggered reconciliation. Narrow
  (requires sign-out to race an in-flight request) and disclosed
  rather than worked around with new infrastructure or a borrowed
  responsibility.
