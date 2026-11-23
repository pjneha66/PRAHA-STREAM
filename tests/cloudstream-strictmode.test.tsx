// @vitest-environment jsdom
import React, { StrictMode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

/**
 * StrictMode runs every effect twice — mount, cleanup, mount again. The Browse
 * tab loads its rows from the native host the moment it appears, so without a
 * guard that double mount issued two `getHome` calls per visit, and the slower
 * of the two won. The guard is a ref (`homeAutoLoadedRef`) precisely because a
 * ref survives the unmount/remount pair; this test proves the remount does not
 * fetch a second time, and proves the test setup really did remount.
 */
const counts = vi.hoisted(() => ({ home: 0, effectRuns: 0 }));

const plugin = {
  internalName: 'ext.a', name: 'Ext A', version: 1, isOnline: true, loaded: true,
  providerCount: 1, extractorCount: 0,
};

vi.mock('../services/cloudstreamService', () => ({
  cloudStreamAvailable: () => true,
  getHome: async () => {
    counts.home += 1;
    return [{ apiName: 'ext.a', section: 'movies', name: 'Movies', horizontal: true, items: [] }];
  },
  getInstalledPlugins: async () => [plugin],
  getProviders: async () => [],
  getRepositories: async () => [],
  getRepositoryPlugins: async () => [],
  addRepository: async () => undefined,
  removeRepository: async () => undefined,
  installPlugin: async () => undefined,
  installMissing: async () => undefined,
  uninstallPlugin: async () => undefined,
  updatePlugins: async () => undefined,
  pickPluginFile: async () => undefined,
  setCatalogEnabled: async () => undefined,
  onInstallFinished: () => () => undefined,
  search: async () => [],
}));

vi.mock('../components/SettingsView', () => ({
  Toggle: ({ checked, onChange }: { checked: boolean; onChange: () => void }) => (
    <button type="button" aria-pressed={checked} onClick={onChange} />
  ),
}));

import CloudStreamView from '../components/CloudStreamView';

/** Records how many times an effect body ran, so we can assert StrictMode remounted. */
function Probe() {
  useEffect(() => {
    counts.effectRuns += 1;
    return () => undefined;
  }, []);
  return null;
}

beforeEach(() => {
  counts.home = 0;
  counts.effectRuns = 0;
});

afterEach(() => {
  cleanup();
});

describe('CloudStreamView under StrictMode', () => {
  it('fetches the home rows once even though effects run twice', async () => {
    render(
      <StrictMode>
        <CloudStreamView onOpenItem={vi.fn()} notify={vi.fn()} />
        <Probe />
      </StrictMode>,
    );

    await waitFor(() => expect(counts.home).toBeGreaterThan(0));
    // The double mount is real, not assumed: the probe saw two effect runs.
    expect(counts.effectRuns).toBe(2);
    // Give the second effect pass a chance to fire a duplicate fetch.
    await waitFor(() => expect(counts.home).toBe(1));
    expect(counts.home).toBe(1);
  });
});
