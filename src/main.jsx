import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { ErrorBoundary } from '@components/ErrorBoundary.js';
import { AuthProvider } from '@contexts/AuthContext.js';
import { AuthGate } from '@components/auth/AuthGate.js';
import { SyncConflictReview } from '@components/sync/SyncConflictReview.js';
import { LocalPersistenceNotice } from '@components/LocalPersistenceNotice.js';
import { runSyncMetadataStampingPass } from '@sync/stamp.js';
import './index.css';

// Sync architecture rewrite (SYNC_ARCHITECTURE_SPEC.md §13 Step 3): stamp
// every existing local record with the full sync metadata field set
// before any hook mounts. Synchronous and resumable/idempotent — safe to
// run on every load (see stamp.ts's header for why). Must run before the
// React tree renders so useLists/useSettings never observe an un-stamped
// singleton value.
runSyncMetadataStampingPass();

// Phase 20B — Production Readiness Fixes (item 3): the app root is now
// wrapped in a global ErrorBoundary. Previously, any render-time error
// anywhere in the component tree (e.g. the Dashboard crash also fixed
// in this phase) was unrecoverable — React would unmount the entire
// tree with no fallback. See components/ErrorBoundary.tsx for details.
//
// Phase 2 (Supabase Authentication): AuthProvider/AuthGate wrap <App/>
// unchanged. AuthGate renders the Login/Sign Up/Forgot Password screens
// when signed out, and <App/> (exactly as before, no props changed)
// once a session exists — see components/auth/AuthGate.tsx. Placed
// inside ErrorBoundary so an auth-layer error still gets the same
// fallback UI as any other render error.
//
// Sync architecture rewrite (SYNC_ARCHITECTURE_SPEC.md §13 Step 2 / Phase
// 5e): the Phase 4.1 SyncConflictReview mount (and its data source,
// hooks/useCloudMigration.ts) was removed along with the rest of the old
// migration-decision machinery — see components/sync/SyncConflictReview.tsx's
// own header for its rebuilt behavior. Reinstated here as a sibling of
// <App/> inside <AuthGate>, so it only mounts once a session exists
// (matching the Sync Engine's own "app start, after auth resolves" gate,
// AuthContext.tsx).
//
// Phase 6g-1 — SYNC_ARCHITECTURE_SPEC.md §3.4: LocalPersistenceNotice is
// mounted the same way, for the same reason — a session-wide condition
// (a failed local write, or a force-closed IndexedDB connection), not a
// per-page one. Every local read/write these conditions could arise
// from only ever happens inside <App/>'s hooks, so placing it alongside
// SyncConflictReview here has no earlier point it could otherwise fire.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <AuthGate>
          <App />
          <SyncConflictReview />
          <LocalPersistenceNotice />
        </AuthGate>
      </AuthProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
