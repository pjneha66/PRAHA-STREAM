// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The provider dropdown on the CloudStream Browse tab.
 *
 * The host has always accepted a provider list for both home rows and search
 * (`getHome(apiNames)` / `search(query, apiNames)`), but Browse exposed no way
 * to supply one, so the only filter available was "all of them". These tests
 * pin the wiring: the dropdown lists what the host reports, and its value is
 * what gets passed through as the filter.
 */
const calls = vi.hoisted(() => ({
  home: [] as (string[] | undefined)[],
  search: [] as (string[] | undefined)[],
}));

const plugin = {
  internalName: 'ext.a', name: 'Ext A', version: 1, isOnline: true, loaded: true,
  providerCount: 2, extractorCount: 0,
};

const providers = [
  { name: 'Zeta', lang: 'en', hasMainPage: true, supportedTypes: ['Movie'], sourcePlugin: 'ext.a' },
  { name: 'Anikage', lang: 'ja', hasMainPage: true, supportedTypes: ['Anime'], sourcePlugin: 'ext.a' },
  // Duplicate + blank names are the shapes a hostile extension can send.
  { name: 'Anikage', lang: 'ja', hasMainPage: false, supportedTypes: [], sourcePlugin: null },
  { name: '', lang: '', hasMainPage: false, supportedTypes: [], sourcePlugin: null },
];

vi.mock('../services/cloudstreamService', () => ({
  cloudStreamAvailable: () => true,
  getHome: async (apiNames?: string[]) => {
    calls.home.push(apiNames);
    return [{ apiName: apiNames?.[0] ?? 'ext.a', section: 'movies', name: 'Movies', horizontal: true, items: [] }];
  },
  getInstalledPlugins: async () => [plugin],
  getProviders: async () => providers,
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
  search: async (_query: string, apiNames?: string[]) => {
    calls.search.push(apiNames);
    return [];
  },
}));

vi.mock('../components/SettingsView', () => ({
  Toggle: ({ checked, onChange }: { checked: boolean; onChange: () => void }) => (
    <button type="button" aria-pressed={checked} onClick={onChange} />
  ),
}));

import CloudStreamView from '../components/CloudStreamView';

beforeEach(() => {
  calls.home = [];
  calls.search = [];
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('CloudStream Browse provider filter', () => {
  it('lists each provider once, sorted, and skips nameless ones', async () => {
    render(<CloudStreamView onOpenItem={vi.fn()} notify={vi.fn()} />);

    const select = await screen.findByLabelText('Filter by provider');
    const options = Array.from(select.querySelectorAll('option')).map((option) => option.textContent);

    // All-providers entry first, then the two real providers in A→Z order.
    expect(options[0]).toContain('All providers');
    expect(options).toHaveLength(3);
    expect(options[1]).toContain('Anikage');
    expect(options[2]).toContain('Zeta');
    expect(options.some((text) => text?.trim() === '')).toBe(false);
  });

  it('loads every provider by default', async () => {
    render(<CloudStreamView onOpenItem={vi.fn()} notify={vi.fn()} />);

    await waitFor(() => expect(calls.home.length).toBeGreaterThan(0));
    expect(calls.home[0]).toBeUndefined();
  });

  it('refetches home rows for the selected provider only', async () => {
    render(<CloudStreamView onOpenItem={vi.fn()} notify={vi.fn()} />);
    const select = await screen.findByLabelText('Filter by provider');
    await waitFor(() => expect(calls.home.length).toBe(1));

    fireEvent.change(select, { target: { value: 'Zeta' } });

    await waitFor(() => expect(calls.home.length).toBe(2));
    expect(calls.home[1]).toEqual(['Zeta']);
  });

  it('scopes the search to the selected provider', async () => {
    render(<CloudStreamView onOpenItem={vi.fn()} notify={vi.fn()} />);
    const select = await screen.findByLabelText('Filter by provider');
    fireEvent.change(select, { target: { value: 'Anikage' } });

    const input = screen.getByLabelText('Search CloudStream providers');
    fireEvent.change(input, { target: { value: 'dune' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(calls.search.length).toBe(1));
    expect(calls.search[0]).toEqual(['Anikage']);
  });

  it('goes back to every provider when the filter is cleared', async () => {
    render(<CloudStreamView onOpenItem={vi.fn()} notify={vi.fn()} />);
    const select = await screen.findByLabelText('Filter by provider');

    fireEvent.change(select, { target: { value: 'Zeta' } });
    await waitFor(() => expect(calls.home.length).toBe(2));

    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(calls.home.length).toBe(3));
    expect(calls.home[2]).toBeUndefined();
  });
});
