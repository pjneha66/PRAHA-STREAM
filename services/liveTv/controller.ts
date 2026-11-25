// Central Live TV controller.
//
// Ported from VyseTV `lib/services/iptv/iptv_controller.dart`
// (GPL-3.0-or-later). ChangeNotifier becomes a tiny subscribe/notify store;
// the portal search, verification, health checks, M3U management, channel
// discovery and EPG caches keep the same responsibilities and ordering.

import type {
  ChannelHit,
  EpgEntry,
  HardcodedChannel,
  IptvCategory,
  IptvEpisode,
  IptvPortal,
  IptvSection,
  IptvStream,
  M3uPlaylist,
  VerifiedPortal,
} from './models';
import { credentialKey } from './models';
import { portalKey } from './portal';
import { HardcodedChannels } from './hardcodedChannels';
import {
  CatalogSource,
  IptvAliveChecker,
  IptvClient,
  IptvScraper,
  IptvVerifier,
  type AliveProgress,
} from './network';
import { fetchAndParsePlaylist, M3uParser, newPlaylistId } from './m3u';
import {
  IptvAliveStore,
  IptvChannelFavoritesStore,
  IptvChannelResultsStore,
  IptvQuickChannelStore,
  IptvStore,
  M3uStore,
  type StoredHit,
} from './storage';
import { importPortalsFromJson, parsePortalImportJson } from './multiPlaylist';
import { buildGroupTree, buildM3uGroupTree, buildXtreamGroupTree, type GroupTreeNode } from './groups';

export type IptvView =
  | 'home'
  | 'channelsHub'
  | 'channelResults'
  | 'portalList'
  | 'sectionPick'
  | 'browser'
  | 'episodeList'
  | 'm3uPlaylists';

export interface PortalChannelGroup {
  portal: VerifiedPortal;
  hits: ChannelHit[];
}

export interface M3uChannelGroup {
  playlist: M3uPlaylist;
  channels: M3uPlaylist['channels'];
}

interface ScanCandidate {
  portal: VerifiedPortal;
  stream: IptvStream;
  url: string;
}

function normalizeUrl(raw: string): string {
  let text = String(raw || '').trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  return text.replace(/\/+$/, '');
}

function storedToHit(hit: StoredHit): ChannelHit {
  return {
    portal: {
      portal: {
        url: hit.portalUrl,
        username: hit.portalUser,
        password: hit.portalPass,
        source: 'Saved',
      },
      name: hit.portalName,
      expiry: '',
      maxConnections: '1',
      activeConnections: '0',
    },
    stream: {
      streamId: hit.streamId,
      name: hit.streamName,
      icon: hit.streamIcon,
      categoryId: hit.streamCategoryId,
      containerExt: hit.streamContainerExt,
      kind: (hit.streamKind as IptvSection) || 'live',
    },
    streamUrl: hit.streamUrl,
  };
}

function hitToStored(hit: ChannelHit): StoredHit {
  return {
    portalUrl: hit.portal.portal.url,
    portalUser: hit.portal.portal.username,
    portalPass: hit.portal.portal.password,
    portalName: hit.portal.name,
    streamId: hit.stream.streamId,
    streamName: hit.stream.name,
    streamIcon: hit.stream.icon,
    streamCategoryId: hit.stream.categoryId,
    streamContainerExt: hit.stream.containerExt,
    streamKind: hit.stream.kind,
    streamUrl: hit.streamUrl,
  };
}

export class IptvController {
  static readonly instance = new IptvController();

  view: IptvView = 'home';
  isScraping = false;
  statusText = '';
  verified: VerifiedPortal[] = [];
  scrapeSource: typeof CatalogSource.cloudVault | typeof CatalogSource.reddit = CatalogSource.cloudVault;
  canGetMore = false;
  favoritePortalKeys = new Set<string>();
  editMode = false;
  selected = new Set<string>();
  isAdding = false;
  addError: string | null = null;
  isImporting = false;

  activePortal: VerifiedPortal | null = null;
  activeSection: IptvSection | null = null;
  activeSeries: IptvStream | null = null;
  isLoading = false;
  categories: IptvCategory[] = [];
  browserAllStreams: IptvStream[] = [];
  episodes: IptvEpisode[] = [];
  error: string | null = null;
  browserSelectedCategoryId: string | null = null;
  browserSearch = '';

  liveOnly = false;
  aliveStreamIds = new Set<string>();
  isVerifyingAlive = false;
  aliveChecked = 0;
  aliveTotal = 0;
  aliveCount = 0;
  aliveCheckedAt: number | null = null;

  activeHardcoded: HardcodedChannel | null = null;
  channelStatus = '';
  channelIsRunning = false;
  channelResults: ChannelHit[] = [];
  favoriteHitUrls = new Map<string, Set<string>>();

  m3uPlaylists: M3uPlaylist[] = [];
  activeM3uPlaylist: M3uPlaylist | null = null;
  isM3uLoading = false;
  quickChannels = IptvQuickChannelStore.load();

  private listeners = new Set<() => void>();
  private initialized = false;
  private verifiedKeys = new Set<string>();
  private attemptedPortalKeys = new Set<string>();
  private pendingPortals: IptvPortal[] = [];
  private scrapeAfter: string | null = null;
  private epgCache = new Map<string, Promise<EpgEntry[]>>();
  private hitEpgCache = new Map<string, Promise<EpgEntry[]>>();
  private channelCancel = false;
  private channelScanToken = 0;
  private channelAttempted = new Map<string, Set<string>>();
  private channelCatalogAfter = new Map<string, string | null>();
  private channelPool = new Map<string, IptvPortal[]>();
  private channelPending = new Map<string, IptvPortal[]>();
  private sectionRequest = 0;
  private aliveCheck = 0;
  private xtremeGroupsCache: PortalChannelGroup[] | null = null;
  private m3uGroupsCache: M3uChannelGroup[] | null = null;
  private xtremeFuture: Promise<PortalChannelGroup[]> | null = null;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  isFavoritePortal(key: string): boolean {
    return this.favoritePortalKeys.has(key);
  }

  isFavoriteHit(channelId: string, hit: ChannelHit): boolean {
    return this.favoriteHitUrls.get(channelId)?.has(hit.streamUrl) ?? false;
  }

  private sortFavoritesFirst(list: readonly VerifiedPortal[]): VerifiedPortal[] {
    const favorites: VerifiedPortal[] = [];
    const rest: VerifiedPortal[] = [];
    for (const portal of list) {
      (this.favoritePortalKeys.has(portalKey(portal.portal)) ? favorites : rest).push(portal);
    }
    return [...favorites, ...rest];
  }

  private sortHitsFavoritesFirst(channelId: string, list: readonly ChannelHit[]): ChannelHit[] {
    const favorites = this.favoriteHitUrls.get(channelId);
    if (!favorites?.size) return [...list];
    const first: ChannelHit[] = [];
    const rest: ChannelHit[] = [];
    for (const hit of list) (favorites.has(hit.streamUrl) ? first : rest).push(hit);
    return [...first, ...rest];
  }

  private invalidateChannelCaches(): void {
    this.xtremeGroupsCache = null;
    this.xtremeFuture = null;
    this.m3uGroupsCache = null;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const stored = IptvStore.loadPortals();
    this.favoritePortalKeys = IptvStore.loadFavoritePortalKeys();
    this.verified = this.sortFavoritesFirst(stored);
    this.verifiedKeys = new Set(stored.map((portal) => credentialKey(portal.portal)));
    this.m3uPlaylists = M3uStore.loadAll();
    this.quickChannels = IptvQuickChannelStore.load();
    for (const channel of this.quickChannels) {
      this.favoriteHitUrls.set(channel.id, IptvChannelFavoritesStore.load(channel.id));
    }
    if (!this.verified.length) void this.scrape();
    this.notify();
  }

  setScrapeSource(source: typeof CatalogSource.cloudVault | typeof CatalogSource.reddit): void {
    if (source.id === this.scrapeSource.id) return;
    this.scrapeSource = source;
    this.scrapeAfter = null;
    this.pendingPortals = [];
    this.canGetMore = false;
    this.statusText = '';
    this.notify();
  }

  async toggleFavoritePortal(key: string): Promise<void> {
    if (this.favoritePortalKeys.has(key)) this.favoritePortalKeys.delete(key);
    else this.favoritePortalKeys.add(key);
    this.verified = this.sortFavoritesFirst(this.verified);
    IptvStore.saveFavoritePortalKeys(this.favoritePortalKeys);
    this.notify();
  }

  async toggleFavoriteHit(channelId: string, hit: ChannelHit): Promise<void> {
    const favorites = this.favoriteHitUrls.get(channelId) ?? new Set<string>();
    if (favorites.has(hit.streamUrl)) favorites.delete(hit.streamUrl);
    else favorites.add(hit.streamUrl);
    this.favoriteHitUrls.set(channelId, favorites);
    this.channelResults = this.sortHitsFavoritesFirst(channelId, this.channelResults);
    IptvChannelFavoritesStore.save(channelId, favorites);
    this.notify();
  }

  async scrape(): Promise<void> {
    if (this.isScraping) return;
    this.isScraping = true;
    this.statusText = 'Finding live portals…';
    this.canGetMore = false;
    this.notify();
    await this.scrapeAndVerify();
  }

  async getMore(): Promise<void> {
    if (this.isScraping) return;
    this.isScraping = true;
    this.statusText = 'Searching for more…';
    this.notify();
    await this.scrapeAndVerify();
  }

  private async scrapeAndVerify(): Promise<void> {
    try {
      let queued = this.pendingPortals;
      if (!queued.length) {
        const page = await IptvScraper.scrapeCatalogPage({ maxResults: 50, after: this.scrapeAfter, source: this.scrapeSource });
        this.scrapeAfter = page.nextAfter;
        this.canGetMore = page.hasMore;
        queued = page.portals.filter((portal) =>
          !this.verifiedKeys.has(credentialKey(portal)) && !this.attemptedPortalKeys.has(portalKey(portal)),
        );
        this.pendingPortals = [...queued];
      }
      const alive = await IptvVerifier.verifyUntil({
        portals: queued,
        target: 5,
        onAttempted: (portal) => {
          this.attemptedPortalKeys.add(portalKey(portal));
          this.pendingPortals = this.pendingPortals.filter((entry) => portalKey(entry) !== portalKey(portal));
        },
        onAlive: (portal) => {
          const key = credentialKey(portal.portal);
          if (this.verifiedKeys.has(key)) return;
          this.verifiedKeys.add(key);
          this.verified = this.sortFavoritesFirst([portal, ...this.verified]);
          IptvStore.savePortals(this.verified);
          this.invalidateChannelCaches();
          this.notify();
        },
        onProgress: ({ checked, total, alive: count }) => {
          this.statusText = `Verifying portals ${checked}/${total} · ${count} active`;
          this.notify();
        },
      });
      this.pendingPortals = this.pendingPortals.filter((portal) =>
        !this.verifiedKeys.has(credentialKey(portal)) && !this.attemptedPortalKeys.has(portalKey(portal)),
      );
      this.statusText = `Found ${alive.length} active portal${alive.length === 1 ? '' : 's'}.`;
    } catch (error) {
      this.statusText = error instanceof Error ? error.message : String(error);
    } finally {
      this.isScraping = false;
      this.notify();
    }
  }

  async runVerification(): Promise<void> {
    const portals = this.verified.map((entry) => entry.portal);
    const alive = await IptvVerifier.verifyUntil({ portals, target: portals.length });
    this.verified = this.sortFavoritesFirst(alive);
    this.verifiedKeys = new Set(alive.map((entry) => credentialKey(entry.portal)));
    IptvStore.savePortals(this.verified);
    this.invalidateChannelCaches();
    this.notify();
  }

  toggleEditMode(): void {
    this.editMode = !this.editMode;
    if (!this.editMode) this.selected.clear();
    this.notify();
  }

  toggleSelect(key: string): void {
    if (this.selected.has(key)) this.selected.delete(key);
    else this.selected.add(key);
    this.notify();
  }

  selectAllPortals(): void {
    this.selected = new Set(this.verified.map((entry) => portalKey(entry.portal)));
    this.notify();
  }

  deselectAllPortals(): void {
    this.selected.clear();
    this.notify();
  }

  deleteAllPortals(): void {
    this.verified = [];
    this.verifiedKeys.clear();
    this.selected.clear();
    IptvStore.savePortals([]);
    this.invalidateChannelCaches();
    this.notify();
  }

  deletePortalsByKeys(keys: ReadonlySet<string>): void {
    this.verified = this.verified.filter((entry) => !keys.has(portalKey(entry.portal)));
    for (const key of keys) {
      this.verifiedKeys.delete(key);
      this.favoritePortalKeys.delete(key);
    }
    this.selected.clear();
    IptvStore.savePortals(this.verified);
    IptvStore.saveFavoritePortalKeys(this.favoritePortalKeys);
    this.invalidateChannelCaches();
    this.notify();
  }

  removeChannelHits(channelId: string, streamUrls: ReadonlySet<string>): void {
    const hits = IptvChannelResultsStore.load(channelId).filter((hit) => !streamUrls.has(hit.streamUrl));
    IptvChannelResultsStore.save(channelId, hits);
    if (this.activeHardcoded?.id === channelId) this.channelResults = this.channelResults.filter((hit) => !streamUrls.has(hit.streamUrl));
    this.notify();
  }

  removeAllChannelHits(channelId: string): void {
    IptvChannelResultsStore.clear(channelId);
    if (this.activeHardcoded?.id === channelId) this.channelResults = [];
    this.notify();
  }

  deleteAllM3uPlaylists(): void {
    this.m3uPlaylists = [];
    this.activeM3uPlaylist = null;
    this.invalidateChannelCaches();
    M3uStore.saveAll([]);
    this.notify();
  }

  async addManual(url: string, username: string, password: string): Promise<boolean> {
    const cleanUrl = normalizeUrl(url);
    if (!cleanUrl || !username.trim() || !password.trim()) {
      this.addError = 'All fields required';
      this.notify();
      return false;
    }
    this.isAdding = true;
    this.addError = null;
    this.notify();
    const portal: IptvPortal = { url: cleanUrl, username: username.trim(), password: password.trim(), source: 'Manual' };
    if (this.verifiedKeys.has(credentialKey(portal))) {
      this.isAdding = false;
      this.addError = 'Portal already added (same credentials)';
      this.notify();
      return false;
    }
    const verified = await IptvClient.verifyOrNull(portal);
    this.isAdding = false;
    if (!verified) {
      this.addError = 'Login failed — wrong credentials or dead portal.';
      this.notify();
      return false;
    }
    this.verifiedKeys.add(credentialKey(portal));
    this.verified = this.sortFavoritesFirst([verified, ...this.verified]);
    this.invalidateChannelCaches();
    IptvStore.savePortals(this.verified);
    this.notify();
    return true;
  }

  async importFromJsonString(contents: string): Promise<{ added: number; skipped: number; failed: number; error?: string }> {
    if (this.isImporting) return { added: 0, skipped: 0, failed: 0, error: 'Already importing.' };
    const parsed = parsePortalImportJson(contents);
    if (parsed.error || !parsed.candidates.length) {
      return { added: 0, skipped: 0, failed: 0, error: parsed.error || 'No portal entries found.' };
    }
    this.isImporting = true;
    this.statusText = 'Importing portals…';
    this.notify();
    const result = await importPortalsFromJson(contents, {
      existing: this.verified.map((entry) => entry.portal),
      verify: async (portal) => Boolean(await IptvClient.verifyOrNull({ ...portal, source: 'Manual' })),
    });
    if (result.added) {
      for (const portal of result.portals) {
        const verified = await IptvClient.verifyOrNull({ ...portal, source: 'Manual' });
        if (!verified) continue;
        this.verifiedKeys.add(credentialKey(portal));
        this.verified = this.sortFavoritesFirst([verified, ...this.verified]);
      }
      IptvStore.savePortals(this.verified);
      this.invalidateChannelCaches();
    }
    this.isImporting = false;
    this.statusText = `Imported ${result.added} · skipped ${result.skipped} · failed ${result.failed}`;
    this.notify();
    return { added: result.added, skipped: result.skipped, failed: result.failed, error: result.error };
  }

  async addM3uFromUrl(name: string, url: string): Promise<void> {
    this.isM3uLoading = true;
    this.notify();
    try {
      const channels = await fetchAndParsePlaylist(url);
      const now = Date.now();
      const playlist: M3uPlaylist = {
        id: newPlaylistId(),
        name: name.trim() || 'Playlist',
        sourceUrl: url,
        addedAt: now,
        updatedAt: now,
        channels,
      };
      this.m3uPlaylists = [...this.m3uPlaylists, playlist];
      this.invalidateChannelCaches();
      M3uStore.saveAll(this.m3uPlaylists);
    } finally {
      this.isM3uLoading = false;
      this.notify();
    }
  }

  async addM3uFromContent(name: string, content: string): Promise<void> {
    this.isM3uLoading = true;
    this.notify();
    try {
      const now = Date.now();
      const playlist: M3uPlaylist = {
        id: newPlaylistId(),
        name: name.trim() || 'Uploaded Playlist',
        sourceUrl: '',
        addedAt: now,
        updatedAt: now,
        channels: M3uParser.parse(content),
      };
      this.m3uPlaylists = [...this.m3uPlaylists, playlist];
      this.invalidateChannelCaches();
      M3uStore.saveAll(this.m3uPlaylists);
    } finally {
      this.isM3uLoading = false;
      this.notify();
    }
  }

  deleteM3uPlaylist(id: string): void {
    this.m3uPlaylists = this.m3uPlaylists.filter((playlist) => playlist.id !== id);
    if (this.activeM3uPlaylist?.id === id) this.activeM3uPlaylist = null;
    this.invalidateChannelCaches();
    M3uStore.saveAll(this.m3uPlaylists);
    this.notify();
  }

  stopChannelSearch(): void {
    this.channelCancel = true;
    this.channelScanToken++;
    this.channelIsRunning = false;
    this.channelStatus = 'Stopped.';
    this.notify();
  }

  async openHardcodedChannel(channel: HardcodedChannel): Promise<void> {
    this.channelCancel = true;
    const token = ++this.channelScanToken;
    this.channelIsRunning = false;
    this.activeHardcoded = channel;
    this.view = 'channelResults';
    this.channelResults = [];
    this.channelStatus = '';
    this.notify();

    const stored = IptvChannelResultsStore.load(channel.id);
    if (this.channelScanToken !== token || this.activeHardcoded?.id !== channel.id) return;
    this.favoriteHitUrls.set(channel.id, IptvChannelFavoritesStore.load(channel.id));
    const valid = stored.filter((hit) => HardcodedChannels.matches(hit.streamName, channel.keywords, channel.exclude));
    if (valid.length !== stored.length) IptvChannelResultsStore.save(channel.id, valid);
    this.channelResults = this.sortHitsFavoritesFirst(channel.id, valid.map(storedToHit));
    this.notify();
    if (!this.channelResults.length) await this.runChannelScan(channel);
  }

  async getMoreChannels(): Promise<void> {
    if (this.activeHardcoded) await this.runChannelScan(this.activeHardcoded, true);
  }

  async runChannelScan(channel: HardcodedChannel, scrapeMore = false): Promise<void> {
    this.channelCancel = false;
    const token = ++this.channelScanToken;
    this.channelIsRunning = true;
    this.notify();

    const attempted = this.channelAttempted.get(channel.id) ?? new Set<string>();
    this.channelAttempted.set(channel.id, attempted);
    const pool = this.channelPool.get(channel.id) ?? [];
    this.channelPool.set(channel.id, pool);
    const poolKeys = new Set(pool.map((portal) => portalKey(portal)));
    for (const verified of this.verified) {
      const key = portalKey(verified.portal);
      if (!attempted.has(key) && !poolKeys.has(key)) pool.push(verified.portal);
    }

    const needsBootstrap = !this.verified.length && pool.every((portal) => attempted.has(portalKey(portal)));
    if (scrapeMore || needsBootstrap) {
      const pending = this.channelPending.get(channel.id) ?? [];
      this.channelPending.set(channel.id, pending);
      const pendingKeys = new Set(pending.map((portal) => credentialKey(portal)));
      for (const verified of this.verified) {
        const key = portalKey(verified.portal);
        if (!attempted.has(key) && !pool.some((portal) => portalKey(portal) === key)) pool.push(verified.portal);
      }
      if (!pending.length) {
        this.channelStatus = 'Discovering fresh portals…';
        this.notify();
        try {
          const page = await IptvScraper.scrapeCatalogPage({
            maxResults: 60,
            after: this.channelCatalogAfter.get(channel.id) ?? null,
            source: this.scrapeSource,
          });
          if (this.channelScanToken !== token || this.activeHardcoded?.id !== channel.id) return;
          this.channelCatalogAfter.set(channel.id, page.nextAfter);
          const known = new Set([...pool.map((portal) => portalKey(portal)), ...attempted]);
          for (const portal of page.portals) {
            if (this.verifiedKeys.has(credentialKey(portal)) || known.has(portalKey(portal))) continue;
            if (pendingKeys.has(credentialKey(portal))) continue;
            pendingKeys.add(credentialKey(portal));
            pending.push(portal);
          }
        } catch { /* keep scanning the known pool */ }
      }
      if (pending.length) {
        this.channelStatus = `Verifying ${pending.length} portals…`;
        this.notify();
        await IptvVerifier.verifyUntil({
          portals: [...pending],
          target: 5,
          onAlive: (verified) => {
            const key = credentialKey(verified.portal);
            if (this.verifiedKeys.has(key)) return;
            this.verifiedKeys.add(key);
            this.verified = this.sortFavoritesFirst([verified, ...this.verified]);
            IptvStore.savePortals(this.verified);
            pool.push(verified.portal);
          },
          onProgress: ({ checked, total, alive }) => {
            if (this.channelScanToken !== token) return;
            this.channelStatus = `Verifying portals ${checked}/${total} · ${alive} active`;
            this.notify();
          },
        });
      }
    }

    if (this.channelCancel || this.channelScanToken !== token || this.activeHardcoded?.id !== channel.id) return;
    const toScan = pool.filter((portal) => !attempted.has(portalKey(portal))).slice(0, 8);
    if (!toScan.length) {
      this.channelIsRunning = false;
      this.channelStatus = this.channelResults.length ? `${this.channelResults.length} streams alive.` : 'No working portals available. Tap Scan More.';
      this.notify();
      return;
    }
    for (const portal of toScan) attempted.add(portalKey(portal));

    this.channelStatus = `Scanning ${toScan.length} portals in parallel…`;
    this.notify();
    const verifiedByKey = new Map(this.verified.map((entry) => [portalKey(entry.portal), entry]));
    const lists = await Promise.all(toScan.map(async (portal) => {
      const verified = verifiedByKey.get(portalKey(portal)) ?? {
        portal,
        name: portal.url,
        expiry: '',
        maxConnections: '1',
        activeConnections: '0',
      };
      try {
        const streams = await IptvClient.streams(portal, 'live', '');
        return streams
          .filter((stream) => HardcodedChannels.matches(stream.name, channel.keywords, channel.exclude))
          .map((stream): ScanCandidate => ({ portal: verified, stream, url: IptvClient.streamUrl(portal, stream) }));
      } catch {
        return [];
      }
    }));

    if (this.channelCancel || this.channelScanToken !== token || this.activeHardcoded?.id !== channel.id) return;
    const already = new Set(this.channelResults.map((hit) => hit.streamUrl));
    const seen = new Set<string>();
    const candidates: ScanCandidate[] = [];
    for (const list of lists) {
      for (const candidate of list) {
        if (!candidate.url || already.has(candidate.url) || seen.has(candidate.url)) continue;
        seen.add(candidate.url);
        candidates.push(candidate);
      }
    }
    if (!candidates.length) {
      this.channelIsRunning = false;
      this.channelStatus = this.channelResults.length
        ? `${this.channelResults.length} alive · no new matches.`
        : 'No matching channels found. Try Scan More.';
      this.notify();
      return;
    }

    const byUrl = new Map(candidates.map((candidate) => [candidate.url, candidate]));
    this.channelStatus = `Found ${candidates.length} streams · verifying health…`;
    this.notify();
    await IptvAliveChecker.launchCheck({
      streams: candidates.map((candidate) => [candidate.url, candidate.url] as const),
      isCancelled: () => this.channelCancel || this.channelScanToken !== token || this.activeHardcoded?.id !== channel.id,
      onResult: (url, alive) => {
        if (!alive || this.channelCancel || this.channelScanToken !== token) return;
        const candidate = byUrl.get(url);
        if (!candidate || this.channelResults.some((hit) => hit.streamUrl === url)) return;
        const hit: ChannelHit = { portal: candidate.portal, stream: candidate.stream, streamUrl: url };
        this.channelResults = this.sortHitsFavoritesFirst(channel.id, [...this.channelResults, hit]);
        IptvChannelResultsStore.save(channel.id, this.channelResults.map(hitToStored));
        this.notify();
      },
      onProgress: ({ checked, total }: AliveProgress) => {
        if (this.channelScanToken !== token) return;
        this.channelStatus = `Sniffing ${checked}/${total} · ${this.channelResults.length} verified live`;
        this.notify();
      },
      onDone: () => {
        if (this.channelCancel || this.channelScanToken !== token || this.activeHardcoded?.id !== channel.id) return;
        this.channelIsRunning = false;
        this.channelStatus = this.channelResults.length
          ? `${this.channelResults.length} live stream${this.channelResults.length === 1 ? '' : 's'} ready.`
          : `No alive streams found for ${channel.name}.`;
        this.notify();
      },
    });
  }

  private async saveChannelHits(channelId: string, hits: readonly ChannelHit[]): Promise<void> {
    IptvChannelResultsStore.save(channelId, hits.map(hitToStored));
  }

  epgFor(stream: IptvStream): Promise<EpgEntry[]> {
    const portal = this.activePortal;
    if (!portal || stream.kind !== 'live' || !stream.streamId) return Promise.resolve([]);
    const key = `${portalKey(portal.portal)}|${stream.streamId}`;
    let pending = this.epgCache.get(key);
    if (!pending) {
      pending = IptvClient.shortEpg(portal.portal, stream.streamId, 2);
      this.epgCache.set(key, pending);
    }
    return pending;
  }

  epgForHit(hit: ChannelHit): Promise<EpgEntry[]> {
    if (hit.stream.kind !== 'live' || !hit.stream.streamId) return Promise.resolve([]);
    const key = `${portalKey(hit.portal.portal)}|${hit.stream.streamId}`;
    let pending = this.hitEpgCache.get(key);
    if (!pending) {
      pending = IptvClient.shortEpg(hit.portal.portal, hit.stream.streamId, 2);
      this.hitEpgCache.set(key, pending);
    }
    return pending;
  }

  async openSection(portal: VerifiedPortal, section: IptvSection): Promise<void> {
    const request = ++this.sectionRequest;
    ++this.aliveCheck;
    this.activePortal = portal;
    this.activeSection = section;
    this.view = 'browser';
    this.isLoading = true;
    this.error = null;
    this.categories = [];
    this.browserAllStreams = [];
    this.browserSelectedCategoryId = null;
    this.browserSearch = '';
    this.aliveStreamIds = new Set();
    this.aliveCheckedAt = null;
    this.isVerifyingAlive = false;
    this.aliveChecked = this.aliveTotal = this.aliveCount = 0;
    this.epgCache.clear();
    this.notify();
    try {
      const categories = await IptvClient.categories(portal.portal, section);
      if (request !== this.sectionRequest) return;
      const streams = await IptvClient.streams(portal.portal, section, '', { strict: true });
      if (request !== this.sectionRequest) return;
      this.categories = [{ id: '', name: 'All' }, ...categories];
      this.browserAllStreams = streams;
      this.browserSelectedCategoryId = categories[0]?.id ?? '';
      if (section === 'live') {
        const key = portalKey(portal.portal);
        this.liveOnly = IptvAliveStore.loadLiveOnly(key);
        const snapshot = IptvAliveStore.load(key);
        if (snapshot) {
          this.aliveStreamIds = snapshot.aliveIds;
          this.aliveCheckedAt = snapshot.checkedAt;
        }
      } else {
        this.liveOnly = false;
      }
    } catch (error) {
      if (request === this.sectionRequest) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (request === this.sectionRequest) {
        this.isLoading = false;
        this.notify();
        if (section === 'live' && !this.error && this.liveOnly) void this.startAliveCheck();
      }
    }
  }

  selectBrowserCategory(id: string): void {
    this.browserSelectedCategoryId = id;
    this.notify();
  }

  setBrowserSearch(query: string): void {
    this.browserSearch = query;
    this.notify();
  }

  async startAliveCheck(force = false): Promise<void> {
    const portal = this.activePortal;
    if (!portal || this.activeSection !== 'live' || this.isVerifyingAlive) return;
    if (!force && this.aliveCheckedAt !== null) return;
    const entries = this.browserAllStreams.map((stream): readonly [string, string] => [stream.streamId, IptvClient.streamUrl(portal.portal, stream)]);
    if (!entries.length) return;
    this.isVerifyingAlive = true;
    this.aliveChecked = 0;
    this.aliveTotal = entries.length;
    this.aliveCount = 0;
    const aliveIds = new Set<string>();
    const check = ++this.aliveCheck;
    this.notify();
    await IptvAliveChecker.launchCheck({
      streams: entries,
      onResult: (id, alive) => { if (alive) aliveIds.add(id); },
      onProgress: (progress) => {
        if (check !== this.aliveCheck) return;
        this.aliveChecked = progress.checked;
        this.aliveTotal = progress.total;
        this.aliveCount = progress.alive;
        this.notify();
      },
      onDone: () => {
        this.aliveStreamIds = aliveIds;
        this.aliveCheckedAt = Date.now();
        IptvAliveStore.save(portalKey(portal.portal), { checkedAt: this.aliveCheckedAt, aliveIds });
        this.isVerifyingAlive = false;
        this.notify();
      },
      isCancelled: () => check !== this.aliveCheck,
    });
  }

  stopAliveCheck(): void {
    ++this.aliveCheck;
    this.isVerifyingAlive = false;
    this.notify();
  }

  back(): void {
    switch (this.view) {
      case 'home': break;
      case 'channelsHub':
      case 'portalList':
      case 'm3uPlaylists':
        this.view = 'home';
        break;
      case 'channelResults':
        this.stopChannelSearch();
        this.view = 'home';
        this.activeHardcoded = null;
        this.channelResults = [];
        this.channelStatus = '';
        break;
      case 'sectionPick':
        this.view = 'portalList';
        this.activePortal = null;
        break;
      case 'browser':
        ++this.sectionRequest;
        this.isLoading = false;
        this.view = 'sectionPick';
        this.activeSection = null;
        this.stopAliveCheck();
        break;
      case 'episodeList':
        this.view = 'browser';
        this.activeSeries = null;
        this.episodes = [];
        break;
    }
    this.notify();
  }

  async getAllXtremeChannels(): Promise<PortalChannelGroup[]> {
    if (this.xtremeGroupsCache) return this.xtremeGroupsCache;
    if (!this.xtremeFuture) {
      this.xtremeFuture = (async () => {
        const groups: PortalChannelGroup[] = [];
        for (const portal of this.verified) {
          try {
            const categories = await IptvClient.categories(portal.portal, 'live');
            const streams: IptvStream[] = [];
            for (const category of categories) {
              streams.push(...await IptvClient.streams(portal.portal, 'live', category.id));
            }
            if (!streams.length) continue;
            groups.push({
              portal,
              hits: streams.map((stream) => ({
                portal,
                stream,
                streamUrl: IptvClient.streamUrl(portal.portal, stream),
              })),
            });
          } catch { /* skip dead portals */ }
        }
        this.xtremeGroupsCache = groups;
        this.xtremeFuture = null;
        this.notify();
        return groups;
      })();
    }
    return this.xtremeFuture;
  }

  getAllM3uChannels(): M3uChannelGroup[] {
    if (this.m3uGroupsCache) return this.m3uGroupsCache;
    this.m3uGroupsCache = this.m3uPlaylists
      .filter((playlist) => playlist.channels.length)
      .map((playlist) => ({ playlist, channels: playlist.channels }));
    return this.m3uGroupsCache;
  }

  /** Grouped channel picker used by the hub's search / group chips. */
  async channelGroups(): Promise<{
    xtream: GroupTreeNode<ChannelHit>;
    m3u: GroupTreeNode<{ name: string; url: string; group?: string }>;
  }> {
    const xtream = await this.getAllXtremeChannels();
    const xtreamHits = xtream.flatMap((group) => group.hits);
    const m3u = this.getAllM3uChannels().flatMap((group) => group.channels.map((channel) => ({
      name: channel.name,
      url: channel.url,
      group: channel.group,
    })));
    return {
      xtream: buildXtreamGroupTree(
        xtreamHits.map((hit) => ({ id: hit.stream.streamId, name: hit.stream.name, categoryId: hit.stream.categoryId })),
        [],
      ) as unknown as GroupTreeNode<ChannelHit>,
      m3u: buildM3uGroupTree(this.m3uPlaylists.map((playlist) => ({ name: playlist.name, channels: playlist.channels }))),
    };
  }

  channelHitGroups(hits: readonly ChannelHit[]): GroupTreeNode<ChannelHit> {
    return buildGroupTree(hits, (hit) => hit.stream.categoryId || hit.portal.name);
  }
}
