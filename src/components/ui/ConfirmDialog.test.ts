/**
 * components/ui/ConfirmDialog.test.ts
 *
 * Dependency-free component coverage for the v1.4 confirmation dialog.
 *
 * The project's harness is Node-only (vitest.config.ts sets
 * `environment: 'node'`) with no jsdom, no happy-dom and no Testing
 * Library, and its `include` glob is `src/**\/*.test.ts` — a `.test.tsx`
 * file would be collected by nothing and silently pass. So this file is
 * `.ts`, builds elements with `React.createElement` instead of JSX, and
 * renders through `react-dom/server`, which is already a direct
 * dependency. No new dependency and no config change. This mirrors
 * components/trade/ScaleLegsSection.test.ts exactly.
 *
 * SCOPE — deliberately narrow and deliberately honest: rendered
 * STRUCTURE and the prop contract only. Clicking Confirm/Cancel and
 * asserting that the right callback fired is NOT reachable in a
 * DOM-less harness, and this file does not pretend otherwise. That
 * wiring is covered by v1.4 Runtime Acceptance (RA-1..RA-17), including
 * the RA-15 proof that no native window.confirm is invoked.
 *
 * Also deliberately absent: assertions on the six call sites' exact
 * confirmation copy. Reaching those strings would mean exporting them
 * from Raw.tsx / TradeTable.tsx / RecoveryBinPanel.tsx purely for the
 * test harness, which v1.4 declined — production module structure is
 * not reshaped for test access. The frozen wording is protected by
 * diff inspection and runtime acceptance instead.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { COLORS as C } from '@constants/lists.js';
import { ConfirmDialog } from './ConfirmDialog.js';

// ─── Helpers ─────────────────────────────────────────────────

const noop = (): void => {};

const BASE = {
  title:        'Delete this trade?',
  confirmLabel: 'Delete Trade',
  onConfirm:    noop,
  onCancel:     noop,
};

function render(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}): string {
  return renderToStaticMarkup(
    React.createElement(ConfirmDialog, { ...BASE, ...props }),
  );
}

/** Count of opening <div> tags — used to prove no placeholder node exists. */
function divCount(markup: string): number {
  return (markup.match(/<div/g) ?? []).length;
}

// ─── Tests ───────────────────────────────────────────────────

describe('ConfirmDialog', () => {
  it('renders the title', () => {
    expect(render()).toContain('Delete this trade?');
  });

  it('renders the message when one is supplied', () => {
    const markup = render({
      message: 'They will be moved to the Recovery Bin and can be restored from there.',
    });
    expect(markup).toContain('They will be moved to the Recovery Bin and can be restored from there.');
  });

  it('renders NO message element when message is omitted', () => {
    const withMessage = render({ message: 'Supporting sentence.' });
    const without     = render();

    // The text itself is gone...
    expect(without).not.toContain('Supporting sentence.');
    // ...and so is its container: exactly one fewer <div>, proving the
    // omitted branch emits no empty placeholder node.
    expect(divCount(without)).toBe(divCount(withMessage) - 1);
  });

  it('renders no message element for an empty-string message', () => {
    // `message && ...` would emit an empty text node here; the ternary
    // in the component means an empty string is treated as omitted.
    expect(divCount(render({ message: '' }))).toBe(divCount(render()));
  });

  it('renders a Cancel control with the exact label', () => {
    expect(render()).toContain('>Cancel</button>');
  });

  it('renders the confirm label', () => {
    expect(render({ confirmLabel: 'Delete ALL' })).toContain('>Delete ALL</button>');
  });

  it("defaults to the danger variant's existing Button styling", () => {
    // Button's danger variant: background '#3A1A1A', foreground C.red.
    // Asserting through the real Button output, not a duplicated map.
    const markup = render();
    expect(markup).toContain('background:#3A1A1A');
    expect(markup).toContain(`color:${C.red}`);
  });

  it("renders the primary variant through the existing Button contract", () => {
    // Button's primary variant: background C.blue, foreground #ffffff.
    const markup = render({ confirmVariant: 'primary', confirmLabel: 'Restore All' });
    expect(markup).toContain(`background:${C.blue}`);
    expect(markup).toContain('>Restore All</button>');
    // The destructive styling must not leak into the additive action —
    // '#3A1A1A' is used by no other variant, so its absence is decisive.
    expect(markup).not.toContain('background:#3A1A1A');
  });

  it('renders above a host modal by using zIndex 400', () => {
    // Sites 4-6 open inside SettingsModal (a Modal at the default 300).
    expect(render()).toContain('z-index:400');
  });
});
