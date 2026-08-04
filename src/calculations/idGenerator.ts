/**
 * calculations/idGenerator.ts
 *
 * Phase 15 — Shared unique-ID generator.
 *
 * CENTRALIZATION NOTE: This function was originally introduced in
 * Phase 14's filterEngine.ts (for filter/condition/group IDs), then
 * an identical copy was initially written in Phase 15's tradeReview.ts
 * (for checklist/field IDs) before this consolidation. Caught during
 * this same phase's self-review (the user explicitly asked to check
 * for duplicated utility functions) and extracted here immediately,
 * rather than deferred — both call sites now import from this single
 * module. Verified byte-identical behavior before and after via
 * regression re-test (see Phase 15 validation report).
 *
 * Not placed in `services/` (not I/O), not in `constants/` (not a
 * fixed value) — kept in `calculations/` alongside the other small,
 * pure, dependency-free helper modules already established there
 * (e.g. formatters.ts).
 */

let idCounter = 0;

/**
 * Generate a unique, human-readable ID string.
 * FORMULA: `${prefix}_${Date.now()}_${counter}` — timestamp plus a
 *          monotonically incrementing in-memory counter, so two IDs
 *          generated within the same millisecond never collide.
 * ASSUMPTIONS: The counter resets on page reload — this is fine, since
 *          IDs only need to be unique among items created within a
 *          single session (persisted items keep their original ID
 *          forever once saved to LocalStorage).
 */
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now()}_${idCounter}`;
}
