/**
 * components/settings/GeneralSettings.tsx
 *
 * Phase 16 — Settings: general app settings (currency, default risk %).
 *
 * NEW component providing a UI for the ALREADY-EXISTING useSettings()
 * hook (Phase 2A) — that hook was built with no UI ever consuming it
 * until now. This is the first phase to wire it in, following the
 * exact "build first, wire in a later phase" pattern already
 * established for useAdvancedAnalytics (Phase 8 -> 9) and the Phase 14
 * Advanced Filters / Phase 15 Trade Review capabilities.
 *
 * CENTRALIZATION: contains zero settings-persistence logic of its own
 * — every read/write goes through useSettings()'s existing
 * `settings`/`updateSettings`/`resetSettings`.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Card } from '@components/ui/Card.js';
import { FormField } from '@components/ui/FormField.js';
import { Input } from '@components/ui/Input.js';
import { Button } from '@components/ui/Button.js';
import type { AppSettings } from '@hooks/useSettings.js';

// ─── Types ───────────────────────────────────────────────────

export interface GeneralSettingsProps {
  settings:       AppSettings;
  onUpdate:       (patch: Partial<AppSettings>) => void; // = useSettings().updateSettings
  onReset:        () => void;                             // = useSettings().resetSettings
}

// ─── Component ───────────────────────────────────────────────

export function GeneralSettings({ settings, onUpdate, onReset }: GeneralSettingsProps) {
  return (
    <Card>
      <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>⚙ General Settings</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        <FormField label="Currency Symbol">
          <Input value={settings.currency} onChange={(v) => onUpdate({ currency: v || '$' })} placeholder="$" />
        </FormField>
        <FormField label="Default Risk % (Position Calculator)">
          <Input
            value={settings.riskPercent}
            onChange={(v) => {
              const n = Number(v);
              if (!isNaN(n) && n > 0) onUpdate({ riskPercent: n });
            }}
            type="number"
            placeholder="1"
          />
        </FormField>
      </div>

      <Button variant="secondary" size="sm" onClick={onReset}>Reset to Defaults</Button>

      {/* v1.1 — release/build identification. Lets a production report be
          tied to the exact running release without any runtime GitHub call. */}
      <div style={{ color: C.dim, fontSize: 9, marginTop: 12 }}>
        {`v${__APP_VERSION__} · build ${__APP_COMMIT__.slice(0, 7)}`}
      </div>
    </Card>
  );
}
