/**
 * TorrServer BTSets configuration, tuned for sequential media streaming.
 *
 * Verbatim port of VyseTV's measured `_fast` profile in
 * `lib/data/sources/torrents.dart`. The important one is EnableIPv6 = false:
 * on networks without working IPv6 the engine burns its connection slots on
 * unreachable peers and stalls. VyseTV measured 1.3–2.4 MB/s with a 10–16 s
 * cold start and a later stall with IPv6 on, versus 4.1–4.8 MB/s with data
 * inside ~8 s every time with it off.
 */

export type TorrServerSettings = Record<string, unknown>;

export const TORRSERVER_DEFAULTS: TorrServerSettings = {
  CacheSize: 64 * 1024 * 1024,
  ReaderReadAHead: 95,
  PreloadCache: 50,
  UseDisk: false,
  TorrentsSavePath: '',
  RemoveCacheOnDrop: false,
  ForceEncrypt: false,
  RetrackersMode: 1,
  TorrentDisconnectTimeout: 30,
  EnableDebug: false,
  EnableDLNA: false,
  EnableBonjour: true,
  FriendlyName: '',
  EnableRutorSearch: false,
  EnableTorznabSearch: false,
  TorznabUrls: [],
  TMDBSettings: {
    APIKey: '',
    APIURL: 'https://api.themoviedb.org',
    ImageURL: 'https://image.tmdb.org',
    ImageURLRu: 'https://imagetmdb.com',
  },
  EnableIPv6: false,
  DisableTCP: false,
  DisableUTP: false,
  DisableUPNP: false,
  DisableDHT: false,
  DisablePEX: false,
  DisableUpload: false,
  DownloadRateLimit: 0,
  UploadRateLimit: 0,
  ConnectionsLimit: 25,
  PeersListenPort: 0,
  EnableLPD: true,
  LPDIPv6: false,
  SslPort: 0,
  SslCert: '',
  SslKey: '',
  ResponsiveMode: true,
  ShowFSActiveTorr: true,
  StoreSettingsInJson: true,
  StoreViewedInJson: false,
  TrackTimecode: false,
};

/** Best-performing public trackers, added to every torrent (RetrackersMode 1). */
export const FALLBACK_TRACKERS: string[] = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.qu.ax:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://opentracker.io:6969/announce',
  'udp://tracker-udp.gbitt.info:80/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
];

export function isPhone(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Android/i.test(ua) && !/TV|Android TV|SMART-TV/i.test(ua);
}

/** The tuned streaming profile. Phone gets a smaller cache and fewer peers. */
export function tunedTorrServerSettings(): TorrServerSettings {
  const phone = isPhone();
  return {
    ...TORRSERVER_DEFAULTS,
    UseDisk: false,
    RemoveCacheOnDrop: true,
    CacheSize: (phone ? 256 : 1024) << 20,
    ReaderReadAHead: 95,
    PreloadCache: 2,
    ConnectionsLimit: phone ? 150 : 300,
    EnableIPv6: false,
    RetrackersMode: 1,
    ResponsiveMode: true,
    ForceEncrypt: false,
    DisableTCP: false,
    DisableUTP: false,
    DisableUPNP: false,
    DisableDHT: false,
    DisablePEX: false,
    DisableUpload: false,
    DownloadRateLimit: 0,
    UploadRateLimit: 0,
    EnableLPD: true,
    TorrentDisconnectTimeout: 120,
    EnableDLNA: false,
    EnableBonjour: false,
  };
}

/**
 * Preserve server-provided fields (TMDB key, Torznab URLs, listen port) while
 * force-applying every streaming-critical knob.
 */
export function applyTunedSettings(current: TorrServerSettings): TorrServerSettings {
  const tuned = tunedTorrServerSettings();
  const preserved: TorrServerSettings = {};
  for (const key of ['TMDBSettings', 'TorznabUrls', 'PeersListenPort', 'FriendlyName']) {
    if (current[key] !== undefined) preserved[key] = current[key];
  }
  return { ...current, ...tuned, ...preserved };
}

/** Trackers are refreshed from ngosang/trackerslist at start, with this fixed fallback. */
export function trackersUrl(): string {
  return 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt';
}
