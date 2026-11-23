// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The "Bundled TorrServer engine" badge in Settings → Network.
 *
 * The badge used to be driven entirely by a `null` initial value: only its own
 * Refresh and Start/Stop buttons ever called `torrServerController.status()`.
 * The engine is a long-lived process that playback (and now "Save & test") can
 * start, so opening Settings showed "Stopped" for an engine that was running,
 * and a successful test left "Stopped" sitting next to "Torrent engine
 * reachable." — the contradiction in the bug report.
 *
 * These tests pin both halves: the status is read on mount, and re-read after a
 * successful test.
 */
const state = vi.hoisted(() => ({
  running: false,
  port: 8090,
  statusCalls: 0,
  checkResult: true,
  checkedHosts: [] as (string | undefined)[],
}));

vi.mock('../services/androidBridge', () => ({
  isAndroidApp: () => true,
  isAndroidTv: () => false,
  openPrivateDnsSettings: async () => undefined,
  setVpnEnabled: async () => undefined,
  getVpnStatus: async () => false,
}));

vi.mock('../services/p2p/torrServerController', () => ({
  torrServerController: {
    isSupported: () => true,
    async status() {
      state.statusCalls += 1;
      // Mirrors the real shape closely enough for the badge.
      return { supported: true, running: state.running, host: state.running ? 'http://127.0.0.1:8090' : '', port: state.port, pid: state.running ? 1234 : 0, logs: [] };
    },
    async ensureStarted() { state.running = true; return true; },
    async stop() { state.running = false; },
  },
}));

vi.mock('../services/torrentStreamingService', () => ({
  TorrentStreamingEngine: {
    getHost: () => 'http://127.0.0.1:8090',
    setHost: () => undefined,
    async checkEngineAvailable(host?: string) {
      state.checkedHosts.push(host);
      // The real check starts the bundled engine on a loopback host.
      if (state.checkResult) state.running = true;
      return state.checkResult;
    },
  },
}));

vi.mock('../services/networkCondition', () => ({
  NETWORK_CONDITION_COPY: { online: { title: 'Online', message: 'ok' }, offline: { title: 'Offline', message: 'no' } },
  probeNetworkCondition: async () => 'online',
}));

vi.mock('../services/badgeRules', () => ({ readBadgeRules: () => [], saveBadgeRules: () => undefined }));
vi.mock('../services/profilePin', () => ({ hashPin: async () => 'x' }));
vi.mock('../services/tmdbService', () => ({ tmdbService: {} }));
vi.mock('../services/imdxService', () => ({
  IMDX_DOCS_URL: '',
  imdxService: {},
  normalizeImdxBaseUrl: (value: string) => value,
}));
vi.mock('../services/jellyfinService', () => ({}));
vi.mock('../components/JellyfinSettings', () => ({ default: () => null }));
vi.mock('../components/ProfilePicker', () => ({
  PROFILE_PALETTE: ['#fff'],
  ProfileAvatar: () => null,
}));

import SettingsView from '../components/SettingsView';
import { DEFAULT_SETTINGS } from '../data/defaults';

const profile = {
  id: 'p1', name: 'Owner', avatarColor: '#f5c518', createdAt: 0,
};

function renderSettings() {
  return render(
    <SettingsView
      settings={DEFAULT_SETTINGS}
      onChange={() => undefined}
      onReset={() => undefined}
      addons={[]}
      repositories={[]}
      profiles={[profile]}
      activeProfile={profile}
      onSelectProfile={() => undefined}
      onCreateProfile={() => undefined}
      onUpdateProfile={() => undefined}
      onDeleteProfile={() => undefined}
      onExportBackup={() => undefined}
      onImportBackup={() => undefined}
      jellyfinSnapshot={null}
      onJellyfinSnapshotChange={() => undefined}
    />,
  );
}

beforeEach(() => {
  state.running = false;
  state.port = 8090;
  state.statusCalls = 0;
  state.checkResult = true;
  state.checkedHosts = [];
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the bundled TorrServer badge', () => {
  it('reads the live status instead of assuming the engine is stopped', async () => {
    // An engine started by playback earlier in the session.
    state.running = true;
    state.port = 8091;

    renderSettings();

    await waitFor(() => expect(state.statusCalls).toBeGreaterThan(0));
    expect(await screen.findByText(/Running on 127\.0\.0\.1:8091/)).toBeTruthy();
  });

  it('refreshes the badge after a successful "Save & test"', async () => {
    renderSettings();
    await waitFor(() => expect(state.statusCalls).toBeGreaterThan(0));
    expect(screen.getByText(/Stopped\./)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Save & test/i }));

    // The test started the bundled engine, so the badge must follow it rather
    // than staying on "Stopped" beside a green result.
    await waitFor(() => expect(screen.getByText(/Running on 127\.0\.0\.1:8090/)).toBeTruthy());
    expect(state.checkedHosts.length).toBeGreaterThan(0);
  });
});
