// The extension ecosystems PRAHA runs beyond its own plugin engine: Sora
// modules, SkyStream plugins, Zangetsu providers and AnymeX extensions. A port
// of the install/store halves of Hikari's SoraPluginManager, SkyStreamPluginManager,
// ZangetsuPluginManager and AnymexPluginManager (GPL-3.0-or-later,
// Copyright (C) 2026 Codegeasse), reshaped for a browser build: the "files on
// disk" of upstream become scripts fetched through the guarded transport and
// cached in memory, and the store itself is localStorage, like the rest of
// PRAHA's source lists.
//
// Purely additive by design — nothing here touches the existing Stremio /
// CloudStream / Vega / Nuvio / Kotatsu sources; each ecosystem's entries join
// the app beside them, in the tab that owns their content kind.

export type EcosystemId = 'sora' | 'skystream' | 'zangetsu' | 'anymex';

/** What a tab asks an ecosystem entry for, in PRAHA's own words. */
export type EcosystemKind = 'movie' | 'series' | 'anime' | 'manga' | 'novel';

export interface EcosystemExtension {
  /** Unique: `<ecosystem>:<id>`. */
  key: string;
  ecosystem: EcosystemId;
  /** The extension's own id (package name, source id, manifest URL). */
  id: string;
  name: string;
  /** Where the script comes from: a module/provider URL, or a .sky archive. */
  url: string;
  version: string;
  lang: string;
  /** What it serves — decides the tab it appears in. */
  kind: EcosystemKind;
  logo?: string;
  baseUrl?: string;
  apiUrl?: string;
  /** The repo manifest it was installed from. */
  sourceUrl?: string;
  nsfw?: boolean;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
}

const STORE_KEY = 'praha.ecosystems.v1';

/** Reads the store, tolerating a hand-edited or older file. */
export function listEcosystemExtensions(): EcosystemExtension[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is EcosystemExtension =>
        Boolean(entry) && typeof entry === 'object' &&
        typeof (entry as EcosystemExtension).key === 'string' &&
        typeof (entry as EcosystemExtension).url === 'string',
    );
  } catch {
    return [];
  }
}

function save(list: EcosystemExtension[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent('praha:ecosystems-changed'));
  } catch {
    // Storage full or unavailable: the app still works, the installs just do
    // not survive a reload.
  }
}

/** The installed entries of one ecosystem, installed order preserved. */
export function ecosystemExtensions(ecosystem: EcosystemId): EcosystemExtension[] {
  return listEcosystemExtensions().filter((entry) => entry.ecosystem === ecosystem);
}

/** The enabled entries of one ecosystem. */
export function enabledEcosystemExtensions(ecosystem: EcosystemId): EcosystemExtension[] {
  return ecosystemExtensions(ecosystem).filter((entry) => entry.enabled);
}

/** Upserts by key; the display list keeps the first-seen order. */
export function installEcosystemExtensions(entries: EcosystemExtension[]): EcosystemExtension[] {
  const current = listEcosystemExtensions();
  const byKey = new Map(current.map((entry) => [entry.key, entry]));
  for (const entry of entries) byKey.set(entry.key, { ...byKey.get(entry.key), ...entry });
  const next = [...byKey.values()];
  save(next);
  return entries.map((entry) => byKey.get(entry.key)!);
}

export function setEcosystemEnabled(key: string, enabled: boolean): EcosystemExtension[] {
  const next = listEcosystemExtensions().map((entry) =>
    entry.key === key ? { ...entry, enabled, updatedAt: Date.now() } : entry,
  );
  save(next);
  return next;
}

export function removeEcosystemExtension(key: string): EcosystemExtension[] {
  const next = listEcosystemExtensions().filter((entry) => entry.key !== key);
  save(next);
  return next;
}

/** The extension for an item id like `zc:<key>:<ownId>` / `so:…` / `ss:…` / `ax:…`. */
export function ecosystemForItemKey(prefix: string, key: string): EcosystemExtension | undefined {
  return listEcosystemExtensions().find((entry) => entry.key === key && itemPrefix(entry) === prefix);
}

/** The short prefix an ecosystem's item ids carry (`zc:`, `so:`, `ss:`, `ax:`). */
export function itemPrefix(entry: Pick<EcosystemExtension, 'ecosystem'>): string {
  switch (entry.ecosystem) {
    case 'sora': return 'so';
    case 'skystream': return 'ss';
    case 'zangetsu': return 'zc';
    case 'anymex': return 'ax';
  }
}

/** One default repository an ecosystem seeds, as Hikari's managers seed them. */
export interface EcosystemRepo {
  url: string;
  name: string;
  description: string;
}

/** Hikari's DEFAULT_REPOS per ecosystem, kept so the lists land populated. */
export const DEFAULT_ECOSYSTEM_REPOS: Record<EcosystemId, EcosystemRepo[]> = {
  sora: [
    { url: 'https://raw.githubusercontent.com/xdfkenny/Sora-Modules/main/modules.json', name: 'Sora Modules', description: 'The official Sora module repo' },
    { url: 'https://raw.githubusercontent.com/justbbcr/streamex/main/streamex.json', name: 'StreameX', description: 'StreameX Sora modules' },
    { url: 'https://github.com/CPRmichel/sora-movie2k-module', name: 'Movie2K modules', description: 'Movie2K Sora modules' },
  ],
  skystream: [
    { url: 'https://raw.githubusercontent.com/akashdh11/skystream-plugins/main/repo.json', name: 'SkyStream official', description: "The official SkyStream plugin repo (Akash's providers)" },
  ],
  zangetsu: [
    { url: 'https://raw.githubusercontent.com/Spyou/zangetsu-providers/main/index.json', name: 'Zangetsu official', description: 'The official Zangetsu repo (HiAnime, HDHub4u, VegaMovies, …)' },
  ],
  anymex: [
    { url: 'https://raw.githubusercontent.com/gato404/kegareta-sauces/main/anime_index.json', name: 'Kegareta Anime', description: 'Kegareta AnymeX anime extensions' },
    { url: 'https://raw.githubusercontent.com/gato404/kegareta-sauces/main/index.json', name: 'Kegareta Manga', description: 'Kegareta AnymeX manga extensions' },
  ],
};
