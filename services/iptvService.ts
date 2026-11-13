import CryptoJS from 'crypto-js';
import { nativeFetchText } from './androidBridge';
import { evictOldest } from './cacheCaps';

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 8000,
): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any> }> {
  const headers = (init?.headers as Record<string, string>) || {};
  const method = init?.method || 'GET';
  const body = typeof init?.body === 'string' ? init.body : undefined;
  try {
    const res = await nativeFetchText(url, {
      method,
      headers,
      body,
      timeoutMs,
    });
    return {
      ok: res.ok,
      status: res.status,
      text: async () => res.data || '',
      json: async () => {
        try {
          return JSON.parse(res.data || '{}');
        } catch {
          return {};
        }
      },
    };
  } catch {
    return {
      ok: false,
      status: 0,
      text: async () => '',
      json: async () => ({}),
    };
  }
}

// ── Models & Interfaces ────────────────────────────────────────────────────────

export interface IptvPortal {
  url: string;
  username: string;
  password: string;
  source?: string;
}

export interface VerifiedPortal {
  portal: IptvPortal;
  name: string;
  expiry: string;
  maxConnections: string;
  activeConnections: string;
}

export interface IptvCategory {
  id: string;
  name: string;
}

export interface IptvStream {
  streamId: string;
  name: string;
  icon: string;
  categoryId: string;
  containerExt: string;
  kind: 'live' | 'vod' | 'series';
  epgChannelId?: string;
}

export interface EpgEntry {
  title: string;
  description: string;
  start: string;
  stop: string;
}

export interface HardcodedChannel {
  id: string;
  name: string;
  shortName: string;
  category: 'Combat' | 'Motorsport' | 'Soccer' | 'US Sports' | 'Cricket' | 'News' | 'Movies' | 'Kids & Docs' | 'Music';
  keywords: string[];
  exclude?: string[];
  gradient: [string, string];
  logo?: string;
  defaultStreamUrl?: string;
}

export interface ChannelHit {
  channel: HardcodedChannel;
  portal: VerifiedPortal;
  stream: IptvStream;
  streamUrl: string;
}

export interface M3uChannel {
  name: string;
  url: string;
  logo?: string;
  group?: string;
  tvgId?: string;
  tvgName?: string;
}

export interface M3uPlaylist {
  id: string;
  name: string;
  sourceUrl: string;
  channels: M3uChannel[];
  updatedAt: number;
}

export interface LiveMatchEvent {
  id: string;
  title: string;
  league: string;
  category: string;
  startsAt?: number;
  endsAt?: number;
  timeLabel: string;
  isLive: boolean;
  homeTeam?: { name: string; badge?: string };
  awayTeam?: { name: string; badge?: string };
  viewers?: number;
  streamUrl: string;
  poster?: string;
}

// ── PasteShDecryptor (AES-256-CBC, PBKDF2-HMAC-SHA512) ────────────────────────

export class PasteShDecryptor {
  private static readonly UA = 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36';

  static async decrypt(urlWithHash: string): Promise<string> {
    try {
      const hashIdx = urlWithHash.indexOf('#');
      if (hashIdx <= 0) return '';
      const baseUrl = urlWithHash.substring(0, hashIdx);
      const clientKey = urlWithHash.substring(hashIdx + 1);
      const slashIdx = baseUrl.lastIndexOf('/');
      const id = slashIdx >= 0 ? baseUrl.substring(slashIdx + 1) : '';

      const resp = await fetchWithTimeout(`${baseUrl}.txt`, { headers: { 'User-Agent': this.UA } }, 6000);
      if (!resp.ok) return '';
      const raw = await resp.text();
      const lines = raw.split('\n');
      if (lines.length < 2) return '';
      const serverKey = lines[0].trim();
      const b64 = lines.slice(1).join('').trim();
      if (!b64) return '';

      const cipherWords = CryptoJS.enc.Base64.parse(b64);
      const cipherHex = CryptoJS.enc.Hex.stringify(cipherWords);
      // Salted__ is 8 bytes (16 hex chars), salt is 8 bytes (16 hex chars)
      if (cipherHex.length < 34) return '';
      const saltHex = cipherHex.substring(16, 32);
      const ctHex = cipherHex.substring(32);

      const password = `${id}${serverKey}${clientKey}https://paste.sh`;
      const salt = CryptoJS.enc.Hex.parse(saltHex);
      const keyIv = CryptoJS.PBKDF2(password, salt, {
        keySize: 48 / 4,
        iterations: 1,
        hasher: CryptoJS.algo.SHA512,
      });

      const keyIvHex = CryptoJS.enc.Hex.stringify(keyIv);
      const key = CryptoJS.enc.Hex.parse(keyIvHex.substring(0, 64)); // 32 bytes
      const iv = CryptoJS.enc.Hex.parse(keyIvHex.substring(64, 96));  // 16 bytes
      const ct = CryptoJS.enc.Hex.parse(ctHex);

      const decrypted = CryptoJS.AES.decrypt({ ciphertext: ct } as any, key, {
        iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      });

      return decrypted.toString(CryptoJS.enc.Utf8) || '';
    } catch {
      return '';
    }
  }
}

// ── Xtream-Codes Client (IptvClient) ──────────────────────────────────────────

export class IptvClient {
  private static readonly UA = 'VLC/3.0.20 LibVLC/3.0.20';

  private static enc(s: string): string {
    return encodeURIComponent(s);
  }

  private static async httpGet(url: string, timeoutMs = 8000): Promise<string | null> {
    // Xtream portals (player_api.php) do not send CORS headers, so a plain
    // browser fetch is blocked inside the app WebView — portal scraping and
    // login verification silently failed on device. Route through the native
    // CORS-bypass client first, with plain fetch as the web fallback.
    try {
      const res = await nativeFetchText(url, {
        headers: { 'User-Agent': this.UA, Accept: 'application/json, text/plain, */*' },
        timeoutMs,
      });
      if (res.status >= 200 && res.status < 300 && res.data) return res.data;
      if (res.ok && res.data) return res.data;
    } catch {
      // Fall through to the plain browser fetch below.
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': this.UA,
          Accept: 'application/json, text/plain, */*',
        },
        signal: controller.signal,
      });
      if (!resp.ok) return null;
      return await resp.text();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  static async login(portal: IptvPortal, timeoutMs = 6000): Promise<Record<string, any> | null> {
    const attempt = await this.loginWithTransport(portal, timeoutMs);
    return attempt?.info ?? null;
  }

  /**
   * Audit M-open (IPTV HTTPS migration): metadata endpoints almost always
   * support TLS even when stream URLs do not. Probe the https variant of an
   * http portal first and report which transport answered, so the UI can pin
   * the upgraded URL. Plain http is kept as the fallback so portals that never
   * implemented TLS keep working — availability beats purity here.
   */
  static async loginWithTransport(
    portal: IptvPortal,
    timeoutMs = 6000,
  ): Promise<{ info: Record<string, any>; base: string } | null> {
    const cleanUrl = portal.url.replace(/\/+$/, '');
    const variants = cleanUrl.startsWith('http://')
      ? [`https://${cleanUrl.slice('http://'.length)}`, cleanUrl]
      : [cleanUrl];
    for (const base of variants) {
      const url = `${base}/player_api.php?username=${this.enc(portal.username)}&password=${this.enc(portal.password)}`;
      const text = await this.httpGet(url, timeoutMs);
      if (!text) continue;
      try {
        const root = JSON.parse(text);
        const info = root.user_info || root;
        const auth = String(info.auth ?? '');
        const status = String(info.status ?? '').toLowerCase();
        const ok = auth === '1' || status === 'active' || !!root.user_info;
        if (ok) return { info, base };
      } catch {
        // Not a valid Xtream response — try the next transport.
      }
    }
    return null;
  }

  static async verifyOrNull(portal: IptvPortal, timeoutMs = 6000): Promise<VerifiedPortal | null> {
    const attempt = await this.loginWithTransport(portal, timeoutMs);
    if (!attempt) return null;
    const info = attempt.info;
    // Pin the working (possibly https-upgraded) transport for every later call.
    const verifiedPortal: IptvPortal = attempt.base !== portal.url ? { ...portal, url: attempt.base } : portal;
    return {
      portal: verifiedPortal,
      name: info.username ? String(info.username) : portal.username,
      expiry: this.formatExpiry(info.exp_date),
      maxConnections: String(info.max_connections ?? '1'),
      activeConnections: String(info.active_cons ?? '0'),
    };
  }

  static formatExpiry(raw?: any): string {
    if (!raw) return 'Unknown';
    const ts = parseInt(String(raw), 10);
    if (isNaN(ts)) return String(raw);
    try {
      const d = new Date(ts * 1000);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]} ${d.getFullYear()}`;
    } catch {
      return String(raw);
    }
  }

  static async categories(portal: IptvPortal, kind: 'live' | 'vod' | 'series' = 'live'): Promise<IptvCategory[]> {
    const action = kind === 'live' ? 'get_live_categories' : kind === 'vod' ? 'get_vod_categories' : 'get_series_categories';
    const cleanUrl = portal.url.replace(/\/+$/, '');
    const url = `${cleanUrl}/player_api.php?username=${this.enc(portal.username)}&password=${this.enc(portal.password)}&action=${action}`;
    const text = await this.httpGet(url, 8000);
    if (!text) return [];
    try {
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) return [];
      return arr.map((item: any) => ({
        id: String(item.category_id ?? ''),
        name: String(item.category_name ?? 'Unknown Category'),
      }));
    } catch {
      return [];
    }
  }

  static async streams(portal: IptvPortal, categoryId = '', kind: 'live' | 'vod' | 'series' = 'live'): Promise<IptvStream[]> {
    const action = kind === 'live' ? 'get_live_streams' : kind === 'vod' ? 'get_vod_streams' : 'get_series';
    const cleanUrl = portal.url.replace(/\/+$/, '');
    const base = `${cleanUrl}/player_api.php?username=${this.enc(portal.username)}&password=${this.enc(portal.password)}&action=${action}`;
    const url = categoryId ? `${base}&category_id=${this.enc(categoryId)}` : base;
    const text = await this.httpGet(url, 12000);
    if (!text) return [];
    try {
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) return [];
      return arr.map((o: any) => {
        const ext = kind === 'live' ? 'ts' : (o.container_extension || 'mp4');
        const id = kind === 'series' ? String(o.series_id || o.id || '') : String(o.stream_id || o.id || '');
        return {
          streamId: id,
          name: String(o.name || o.title || 'Live Channel'),
          icon: String(o.stream_icon || o.cover || ''),
          categoryId: String(o.category_id || ''),
          containerExt: ext,
          kind,
          epgChannelId: o.epg_channel_id ? String(o.epg_channel_id) : undefined,
        };
      });
    } catch {
      return [];
    }
  }

  static streamUrl(portal: IptvPortal, stream: IptvStream): string {
    const cleanUrl = portal.url.replace(/\/+$/, '');
    const user = this.enc(portal.username);
    const pass = this.enc(portal.password);
    const ext = stream.containerExt || (stream.kind === 'live' ? 'ts' : 'mp4');
    const folder = stream.kind === 'live' ? 'live' : 'movie';
    return `${cleanUrl}/${folder}/${user}/${pass}/${stream.streamId}.${ext}`;
  }

  static async shortEpg(portal: IptvPortal, streamId: string, limit = 2): Promise<EpgEntry[]> {
    if (!streamId) return [];
    const cleanUrl = portal.url.replace(/\/+$/, '');
    const url = `${cleanUrl}/player_api.php?username=${this.enc(portal.username)}&password=${this.enc(portal.password)}&action=get_short_epg&stream_id=${this.enc(streamId)}&limit=${limit}`;
    const text = await this.httpGet(url, 6000);
    if (!text) return [];
    try {
      const root = JSON.parse(text);
      const arr = Array.isArray(root) ? root : (root.epg_listings || []);
      const decode64 = (s: any) => {
        if (!s) return '';
        try {
          return atob(String(s));
        } catch {
          return String(s);
        }
      };
      return arr.map((e: any) => ({
        title: decode64(e.title),
        description: decode64(e.description),
        start: String(e.start || e.start_timestamp || ''),
        stop: String(e.end || e.stop_timestamp || ''),
      }));
    } catch {
      return [];
    }
  }
}

// ── Alive Checker (sniffs stream playback headers) ───────────────────────────

export class IptvAliveChecker {
  static async isAlive(streamUrl: string, timeoutMs = 5000): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(streamUrl, {
        method: 'GET',
        headers: {
          Range: 'bytes=0-1024',
          'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
        },
        signal: controller.signal,
      });
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (resp.status >= 200 && resp.status < 300) {
        if (ct.includes('html') || ct.includes('json')) return false;
        return true;
      }
      return resp.status === 206;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Xtream-Codes Scraper (Reddit + Pastes + Curated Fallbacks) ────────────────

export class IptvScraper {
  // Reddit aggressively blocks non-browser clients, so the fetcher races the
  // direct endpoint and several text proxies per subreddit.
  private static readonly REDDIT_SUBS = ['IPTV_ZONENEW', 'IPTVReseller', 'iptvdoors'];
  private static readonly PROXIES = [
    'https://corsproxy.io/?{URL}',
    'https://api.allorigins.win/raw?url={URL}',
    'https://api.codetabs.com/v1/proxy?quest={URL}',
  ];

  private static readonly URL_PARAM_REGEX = /(https?:\/\/[^?\s"'<]+)\?(?:[^\s"'<]*?&)?(?:username|user)=([^&\s"'<]+)\s*&(?:password|pass)=([^&\s"'<]+)/gi;
  private static readonly LABEL_REGEX = /(?:Portal|Host(?:\s*URL)?|H[ᴏo]s[ᴛt]|Panel|Real|URL|🔗|🌍|🌐)[\s:.-]*?(https?:\/\/[^<\s"']+)[\s\S]{1,500}?(?:Username|Usu[áa]rio|Usuario|User|Us[ᴇe]r|Us[ᴜu][ᴀa]r[ɪi][ᴏo]|👤)[\s:.-]+([^\s|<"'\n]+)[\s\S]{1,200}?(?:Password|Senha|Contrase[ñn]a|Pass|P[ᴀa]ss|S[ᴇe]nh[ᴀa]|🔑)[\s:.-]+([^\s|<"'\n]+)/gi;

  static extractPortals(text: string, source = 'Scraper'): IptvPortal[] {
    const out: Map<string, IptvPortal> = new Map();
    if (!text || text.length < 15) return [];

    const add = (rawUrl: string, rawUser: string, rawPass: string) => {
      let url = rawUrl.trim();
      const qIdx = url.indexOf('?');
      if (qIdx >= 0) url = url.substring(0, qIdx);
      url = url.replace(/\/(?:get|live|portal|c|index|playlist|player_api)\.php$/i, '').replace(/\/+$/, '');
      if (!url.startsWith('http')) url = `https://${url}`;

      const user = rawUser.replace(/^[=:]+/, '').trim();
      const pass = rawPass.replace(/^[=:]+/, '').trim();
      if (!url || user.length < 3 || pass.length < 3) return;
      if (user.includes('://') || pass.includes('://')) return;

      const key = `${url}|${user}|${pass}`.toLowerCase();
      if (!out.has(key)) {
        out.set(key, { url, username: user, password: pass, source });
      }
    };

    let match: RegExpExecArray | null;
    const urlRegex = new RegExp(this.URL_PARAM_REGEX.source, 'gi');
    while ((match = urlRegex.exec(text)) !== null) {
      add(match[1], match[2], match[3]);
    }

    const labelRegex = new RegExp(this.LABEL_REGEX.source, 'gi');
    while ((match = labelRegex.exec(text)) !== null) {
      add(match[1], match[2], match[3]);
    }

    return Array.from(out.values());
  }

  static async scrapeRedditPortals(limit = 25): Promise<IptvPortal[]> {
    let jsonText: string | null = null;

    for (const sub of this.REDDIT_SUBS) {
      const targetUrl = `https://www.reddit.com/r/${sub}/new.json?limit=${limit}&sort=new`;

      // Inside the APK the native client bypasses CORS entirely — reddit's
      // JSON endpoints need no proxy at all when reddit allows the client.
      try {
        const direct = await nativeFetchText(targetUrl, { timeoutMs: 6000 });
        if (direct.ok && direct.data.trim().startsWith('{')) {
          jsonText = direct.data;
          break;
        }
      } catch {
        // Fall through to CORS proxies.
      }

      if (jsonText) break;
      for (const tmpl of this.PROXIES) {
        try {
          const proxyUrl = tmpl.replace('{URL}', encodeURIComponent(targetUrl));
          const resp = await fetchWithTimeout(proxyUrl, { headers: { Accept: 'application/json' } }, 5000);
          if (resp.ok) {
            const body = await resp.text();
            if (body.trim().startsWith('{')) {
              jsonText = body;
              break;
            }
          }
        } catch {
          continue;
        }
      }
      if (jsonText) break;
    }

    if (!jsonText) return [];
    try {
      const data = JSON.parse(jsonText)?.data?.children || [];
      const portals: IptvPortal[] = [];
      for (const child of data) {
        const post = child.data;
        const text = `${post.title || ''} ${post.selftext || ''}`;
        const found = this.extractPortals(text, 'Reddit');
        portals.push(...found);
      }
      return portals;
    } catch {
      return [];
    }
  }

  static getFallbackPortals(): IptvPortal[] {
    // HTTPS-preferred curated portals; loginWithTransport still falls back to
    // plain http per portal when TLS is not available.
    return [
      { url: 'https://watch.topiptv.xyz:80', username: 'stream', password: 'password', source: 'Curated' },
      { url: 'https://cdn.megastreams.io:8080', username: 'free', password: 'tv', source: 'Curated' },
      { url: 'https://live.stream4k.xyz:80', username: 'demo', password: 'demo', source: 'Curated' },
    ];
  }
}

// ── Hardcoded Curated Channels (50+ channels matching PlayTorrio) ─────────────

export class HardcodedChannels {
  private static readonly GRAD_FIGHT: [string, string] = ['#F97316', '#7C2D12'];
  private static readonly GRAD_WRESTLING: [string, string] = ['#B91C1C', '#1F2937'];
  private static readonly GRAD_MOTOR: [string, string] = ['#DC2626', '#111827'];
  private static readonly GRAD_SOCCER: [string, string] = ['#7C3AED', '#22D3EE'];
  private static readonly GRAD_UK_SPORT: [string, string] = ['#1D4ED8', '#22C55E'];
  private static readonly GRAD_US_SPORT: [string, string] = ['#EF4444', '#F59E0B'];
  private static readonly GRAD_NEWS: [string, string] = ['#0EA5E9', '#1E293B'];
  private static readonly GRAD_MOVIE: [string, string] = ['#EC4899', '#8B5CF6'];
  private static readonly GRAD_KIDS: [string, string] = ['#FBBF24', '#F472B6'];
  private static readonly GRAD_MUSIC: [string, string] = ['#06B6D4', '#A855F7'];

  static readonly all: HardcodedChannel[] = [
    // ── Combat Sports ──
    {
      id: 'ufc',
      name: 'UFC',
      shortName: 'UFC',
      category: 'Combat',
      gradient: this.GRAD_FIGHT,
      keywords: ['ufc', 'ufc fight pass', 'ufc ppv', 'ufc on espn', 'ufc fight night', 'ufc 3', 'ufc apex'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/0/0d/UFC_logo.svg',
    },
    {
      id: 'wwe',
      name: 'WWE Network',
      shortName: 'WWE',
      category: 'Combat',
      gradient: this.GRAD_WRESTLING,
      keywords: ['wwe', 'wwe network', 'wwe ppv', 'wwe raw', 'wwe smackdown', 'wwe nxt', 'wrestlemania', 'summerslam'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/0/03/WWE_Logo.svg',
    },
    {
      id: 'aew',
      name: 'AEW Wrestling',
      shortName: 'AEW',
      category: 'Combat',
      gradient: this.GRAD_WRESTLING,
      keywords: ['aew', 'all elite wrestling', 'aew dynamite', 'aew rampage', 'aew collision', 'aew revolution'],
    },
    {
      id: 'boxing',
      name: 'Boxing TV',
      shortName: 'BOX',
      category: 'Combat',
      gradient: this.GRAD_FIGHT,
      keywords: ['boxing', 'ppv box', 'fight night', 'top rank', 'matchroom', 'boxnation', 'fight network', 'dazn boxing'],
      exclude: ['box office', 'xbox', 'boxset', 'music box'],
    },
    {
      id: 'one_championship',
      name: 'ONE Championship',
      shortName: 'ONE',
      category: 'Combat',
      gradient: this.GRAD_FIGHT,
      keywords: ['one championship', 'one fc', 'one mma'],
    },

    // ── Motorsport ──
    {
      id: 'f1',
      name: 'Formula 1',
      shortName: 'F1',
      category: 'Motorsport',
      gradient: this.GRAD_MOTOR,
      keywords: ['f1 tv', 'formula 1', 'formula one', 'sky f1', 'skysports f1', 'sky sport f1', 'sky sports f1', 'grand prix', 'f1 race', 'ssf1', 'ss f1'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/3/33/F1.svg',
    },
    {
      id: 'motogp',
      name: 'MotoGP',
      shortName: 'GP',
      category: 'Motorsport',
      gradient: this.GRAD_MOTOR,
      keywords: ['motogp', 'moto gp', 'moto-gp', 'moto2', 'moto3'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/5/52/Moto_Gp_logo.svg',
    },
    {
      id: 'nascar',
      name: 'NASCAR',
      shortName: 'NSC',
      category: 'Motorsport',
      gradient: this.GRAD_MOTOR,
      keywords: ['nascar', 'nascar cup', 'daytona 500', 'nascar xfinity'],
    },
    {
      id: 'indycar',
      name: 'IndyCar',
      shortName: 'INDY',
      category: 'Motorsport',
      gradient: this.GRAD_MOTOR,
      keywords: ['indycar', 'indy car', 'indy 500', 'indianapolis 500'],
    },

    // ── Soccer / Football ──
    {
      id: 'bein_sports',
      name: 'beIN Sports',
      shortName: 'BEIN',
      category: 'Soccer',
      gradient: this.GRAD_SOCCER,
      keywords: ['bein sport', 'bein sports', 'beinsports', 'bein 1', 'bein 2', 'bein 3', 'bein max'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/a/af/BeIN_Sports_logo.svg',
    },
    {
      id: 'sky_sports',
      name: 'Sky Sports Main Event',
      shortName: 'SKY',
      category: 'Soccer',
      gradient: this.GRAD_UK_SPORT,
      keywords: ['sky sport', 'sky sports', 'skysports', 'sky sports main event', 'sky sports premier league', 'sky sports football'],
      exclude: ['sky sports news'],
      logo: 'https://upload.wikimedia.org/wikipedia/en/3/30/Sky_Sports_logo_2020.svg',
    },
    {
      id: 'tnt_sports',
      name: 'TNT Sports',
      shortName: 'TNT',
      category: 'Soccer',
      gradient: this.GRAD_UK_SPORT,
      keywords: ['tnt sport', 'tnt sports', 'bt sport', 'btsport', 'tnt sports 1', 'tnt sports 2', 'tnt sports 3'],
    },
    {
      id: 'champions_league',
      name: 'UEFA Champions League',
      shortName: 'UCL',
      category: 'Soccer',
      gradient: this.GRAD_SOCCER,
      keywords: ['champions league', 'uefa champions', 'ucl ', 'uefa europa', 'europa league', 'conference league'],
      logo: 'https://upload.wikimedia.org/wikipedia/en/b/bf/UEFA_Champions_League_logo_2.svg',
    },
    {
      id: 'premier_league',
      name: 'Premier League',
      shortName: 'EPL',
      category: 'Soccer',
      gradient: this.GRAD_SOCCER,
      keywords: ['premier league', 'epl ', 'barclays premier', 'sky sports pl', 'peacock premier league'],
      logo: 'https://upload.wikimedia.org/wikipedia/en/f/f2/Premier_League_Logo.svg',
    },
    {
      id: 'la_liga',
      name: 'La Liga TV',
      shortName: 'LL',
      category: 'Soccer',
      gradient: this.GRAD_SOCCER,
      keywords: ['laliga', 'la liga', 'movistar laliga', 'laliga tv', 'laliga ea sports'],
    },
    {
      id: 'serie_a',
      name: 'Serie A Calcio',
      shortName: 'SA',
      category: 'Soccer',
      gradient: this.GRAD_SOCCER,
      keywords: ['serie a', 'dazn italia', 'sky calcio', 'calcio', 'serie a tim'],
    },
    {
      id: 'bundesliga',
      name: 'Bundesliga',
      shortName: 'BL',
      category: 'Soccer',
      gradient: this.GRAD_SOCCER,
      keywords: ['bundesliga', 'sky bundesliga', 'dazn bundes', 'german football'],
    },
    {
      id: 'dazn',
      name: 'DAZN Live',
      shortName: 'DAZN',
      category: 'Soccer',
      gradient: this.GRAD_FIGHT,
      keywords: ['dazn', 'dazn 1', 'dazn 2'],
    },

    // ── US Sports ──
    {
      id: 'espn',
      name: 'ESPN',
      shortName: 'ESPN',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['espn', 'espn2', 'espn 2', 'espnews', 'espn+', 'espn plus', 'espnu'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/2/2f/ESPN_wordmark.svg',
    },
    {
      id: 'fox_sports',
      name: 'Fox Sports 1 (FS1)',
      shortName: 'FOX',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['fox sport', 'fox sports', 'fs1', 'fs2', 'fox soccer'],
    },
    {
      id: 'nbc_sports',
      name: 'NBC Sports',
      shortName: 'NBC',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['nbc sport', 'nbc sports', 'nbcsn', 'peacock sport'],
    },
    {
      id: 'cbs_sports',
      name: 'CBS Sports Network',
      shortName: 'CBS',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['cbs sport', 'cbs sports', 'cbs sports network', 'cbs sports hq'],
    },
    {
      id: 'nba',
      name: 'NBA TV',
      shortName: 'NBA',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['nba ', 'nba tv', 'nba league pass', 'nba hd'],
      logo: 'https://upload.wikimedia.org/wikipedia/en/0/03/National_Basketball_Association_logo.svg',
    },
    {
      id: 'nfl',
      name: 'NFL Network',
      shortName: 'NFL',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['nfl ', 'nfl network', 'nfl hd', 'nfl sunday ticket', 'nfl game pass'],
      logo: 'https://upload.wikimedia.org/wikipedia/en/a/a2/National_Football_League_logo.svg',
    },
    {
      id: 'nfl_redzone',
      name: 'NFL RedZone',
      shortName: 'RZ',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['redzone', 'red zone', 'nfl redzone'],
    },
    {
      id: 'mlb',
      name: 'MLB Network',
      shortName: 'MLB',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['mlb ', 'mlb network', 'mlb tv', 'mlb extra innings'],
    },
    {
      id: 'nhl',
      name: 'NHL Network',
      shortName: 'NHL',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['nhl ', 'nhl network', 'nhl tv', 'hockey night'],
    },
    {
      id: 'tennis_channel',
      name: 'Tennis Channel',
      shortName: 'TEN',
      category: 'US Sports',
      gradient: this.GRAD_SOCCER,
      keywords: ['tennis channel', 'tennis tv', 'atp tennis', 'wta tennis', 'wimbledon', 'us open tennis'],
    },
    {
      id: 'golf_channel',
      name: 'Golf Channel',
      shortName: 'GLF',
      category: 'US Sports',
      gradient: this.GRAD_SOCCER,
      keywords: ['golf channel', 'golf tv', 'sky golf', 'pga tour', 'masters golf'],
    },

    // ── Cricket ──
    {
      id: 'cricket',
      name: 'Cricket Live',
      shortName: 'CRK',
      category: 'Cricket',
      gradient: this.GRAD_SOCCER,
      keywords: ['cricket', 'willow cricket', 'willow tv', 'star sports cricket', 'sky sports cricket', 'sony ten cricket', 'ipl '],
    },

    // ── News ──
    {
      id: 'cnn',
      name: 'CNN International',
      shortName: 'CNN',
      category: 'News',
      gradient: this.GRAD_NEWS,
      keywords: ['cnn', 'cnn international', 'cnn hd'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/b/b1/CNN.svg',
    },
    {
      id: 'bbc_news',
      name: 'BBC News',
      shortName: 'BBC',
      category: 'News',
      gradient: this.GRAD_NEWS,
      keywords: ['bbc news', 'bbc world', 'bbc world news'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/e/eb/BBC_News_2022.svg',
    },
    {
      id: 'sky_news',
      name: 'Sky News',
      shortName: 'SKN',
      category: 'News',
      gradient: this.GRAD_NEWS,
      keywords: ['sky news', 'sky news arabia'],
    },
    {
      id: 'al_jazeera',
      name: 'Al Jazeera English',
      shortName: 'AJ',
      category: 'News',
      gradient: this.GRAD_NEWS,
      keywords: ['al jazeera', 'aljazeera', 'al jazeera english'],
    },
    {
      id: 'bloomberg',
      name: 'Bloomberg Television',
      shortName: 'BLM',
      category: 'News',
      gradient: this.GRAD_NEWS,
      keywords: ['bloomberg', 'bloomberg tv'],
    },
    {
      id: 'cnbc',
      name: 'CNBC',
      shortName: 'CNBC',
      category: 'News',
      gradient: this.GRAD_NEWS,
      keywords: ['cnbc', 'cnbc international'],
    },

    // ── Movies & Premium ──
    {
      id: 'hbo',
      name: 'HBO Max',
      shortName: 'HBO',
      category: 'Movies',
      gradient: this.GRAD_MOVIE,
      keywords: ['hbo', 'hbo max', 'hbo signature', 'hbo family', 'hbo 2'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/d/de/HBO_logo.svg',
    },
    {
      id: 'showtime',
      name: 'Showtime',
      shortName: 'SHO',
      category: 'Movies',
      gradient: this.GRAD_MOVIE,
      keywords: ['showtime', 'showtime 2', 'paramount+ with showtime'],
    },
    {
      id: 'starz',
      name: 'Starz',
      shortName: 'STZ',
      category: 'Movies',
      gradient: this.GRAD_MOVIE,
      keywords: ['starz', 'starz encore'],
    },
    {
      id: 'cinemax',
      name: 'Cinemax',
      shortName: 'CMX',
      category: 'Movies',
      gradient: this.GRAD_MOVIE,
      keywords: ['cinemax', 'max prime', 'actionmax'],
    },
    {
      id: 'amc',
      name: 'AMC',
      shortName: 'AMC',
      category: 'Movies',
      gradient: this.GRAD_MOVIE,
      keywords: [' amc ', 'amc hd', 'amc usa', 'amc network', 'amc+'],
    },

    // ── Kids & Docs ──
    {
      id: 'discovery',
      name: 'Discovery Channel',
      shortName: 'DISC',
      category: 'Kids & Docs',
      gradient: this.GRAD_SOCCER,
      keywords: ['discovery channel', 'discovery hd', 'investigation discovery'],
    },
    {
      id: 'natgeo',
      name: 'National Geographic',
      shortName: 'GEO',
      category: 'Kids & Docs',
      gradient: this.GRAD_KIDS,
      keywords: ['national geographic', 'nat geo', 'natgeo wild'],
    },
    {
      id: 'disney',
      name: 'Disney Channel',
      shortName: 'DIS',
      category: 'Kids & Docs',
      gradient: this.GRAD_KIDS,
      keywords: ['disney channel', 'disney xd', 'disney junior'],
    },
    {
      id: 'cartoon_network',
      name: 'Cartoon Network',
      shortName: 'CN',
      category: 'Kids & Docs',
      gradient: this.GRAD_KIDS,
      keywords: ['cartoon network', 'cartoon network hd', 'boomerang'],
    },

    // ── Music ──
    {
      id: 'mtv',
      name: 'MTV Live',
      shortName: 'MTV',
      category: 'Music',
      gradient: this.GRAD_MUSIC,
      keywords: ['mtv live', 'mtv hits', 'mtv 80s', 'mtv 90s', 'club mtv', 'vh1'],
    },
  ];

  static byId(id: string): HardcodedChannel | undefined {
    return this.all.find((c) => c.id === id);
  }

  static matches(streamName: string, keywords: string[], exclude: string[] = []): boolean {
    const s = streamName.toLowerCase();
    for (const ex of exclude) {
      if (s.includes(ex.toLowerCase())) return false;
    }
    for (const kw of keywords) {
      if (s.includes(kw.toLowerCase())) return true;
    }
    return false;
  }
}

// ── M3U / M3U8 Playlist Parser ────────────────────────────────────────────────

export class M3uParser {
  static parse(content: string): M3uChannel[] {
    if (!content || !content.trim()) return [];
    const text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n');

    const channels: M3uChannel[] = [];
    let pendingName = '';
    let pendingLogo = '';
    let pendingGroup = '';
    let pendingTvgId = '';
    let pendingTvgName = '';

    const reset = () => {
      pendingName = '';
      pendingLogo = '';
      pendingGroup = '';
      pendingTvgId = '';
      pendingTvgName = '';
    };

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      if (line.startsWith('#EXTM3U')) continue;

      if (line.startsWith('#EXTINF:')) {
        const commaIdx = line.indexOf(',');
        const attrPart = commaIdx > 0 ? line.substring(8, commaIdx) : line.substring(8);
        const namePart = commaIdx > 0 ? line.substring(commaIdx + 1).trim() : '';

        pendingLogo = this.extractAttr(attrPart, 'tvg-logo');
        pendingGroup = this.extractAttr(attrPart, 'group-title');
        pendingTvgId = this.extractAttr(attrPart, 'tvg-id');
        pendingTvgName = this.extractAttr(attrPart, 'tvg-name');
        pendingName = namePart || pendingTvgName || 'Channel';
        continue;
      }

      if (line.startsWith('#EXTGRP:')) {
        pendingGroup = line.substring(8).trim();
        continue;
      }

      if (line.startsWith('#')) continue;

      // URL line
      if (line.startsWith('http://') || line.startsWith('https://') || line.includes('.m3u8') || line.includes('.ts')) {
        channels.push({
          name: pendingName || line,
          url: line,
          logo: pendingLogo || undefined,
          group: pendingGroup || undefined,
          tvgId: pendingTvgId || undefined,
          tvgName: pendingTvgName || undefined,
        });
        reset();
      }
    }

    return channels;
  }

  private static extractAttr(attrs: string, name: string): string {
    const regex = new RegExp(`${name}=(?:"([^"]*)"|'([^']*)'|([^\\s]+))`, 'i');
    const match = regex.exec(attrs);
    return match ? (match[1] || match[2] || match[3] || '').trim() : '';
  }

  static readonly defaultPlaylists: Record<string, string> = {
    Sports: 'https://iptv-org.github.io/iptv/categories/sports.m3u',
    News: 'https://iptv-org.github.io/iptv/categories/news.m3u',
    Movies: 'https://iptv-org.github.io/iptv/categories/movies.m3u',
    English: 'https://iptv-org.github.io/iptv/languages/eng.m3u',
    Spanish: 'https://iptv-org.github.io/iptv/languages/spa.m3u',
    Music: 'https://iptv-org.github.io/iptv/categories/music.m3u',
  };

  static readonly fallbackChannels: M3uChannel[] = [
    { name: 'Red Bull TV', url: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8', group: 'Sports', logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/f/f5/Red_Bull_TV_logo.svg/1200px-Red_Bull_TV_logo.svg.png' },
    { name: 'Sky News UK', url: 'https://skynews-live.akamaized.net/hls/live/2028678/skynews/live.m3u8', group: 'News', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d2/Sky_News_2020.svg/1200px-Sky_News_2020.svg.png' },
    { name: 'Bloomberg TV', url: 'https://bloomberg.com/media-manifest/streams/us.m3u8', group: 'News', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/56/Bloomberg_Television_logo.svg/1200px-Bloomberg_Television_logo.svg.png' },
    { name: 'France 24 English', url: 'https://static.france24.com/live/F24_EN_LO_HLS/live_tv.m3u8', group: 'News', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/86/France_24_logo.svg/1200px-France_24_logo.svg.png' },
    { name: 'DW News English', url: 'https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/index.m3u8', group: 'News', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/75/Deutsche_Welle_symbol_2012.svg/1200px-Deutsche_Welle_symbol_2012.svg.png' },
    { name: 'Al Jazeera English', url: 'https://live-hls-web-aje.getaj.net/AJE/01.m3u8', group: 'News', logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/f/f2/Aljazeera_eng.svg/1200px-Aljazeera_eng.svg.png' },
    { name: 'Euronews English', url: 'https://euronews-euronews-world-1-gb.samsung.wurl.com/manifest/playlist.m3u8', group: 'News', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/78/Euronews_2016_logo.svg/1200px-Euronews_2016_logo.svg.png' },
    { name: 'NASA TV HD', url: 'https://ntv1.akamaized.net/hls/live/2014075/NASA-NTV1-HLS/master.m3u8', group: 'Kids & Docs', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e5/NASA_logo.svg/1200px-NASA_logo.svg.png' },
    { name: 'Motorvision TV', url: 'https://motorvision-samsungau.amagi.tv/playlist.m3u8', group: 'Motorsport', logo: 'https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?auto=format&fit=crop&w=300&q=80' },
    { name: 'Fight Network TV', url: 'https://anthem-fightnetwork-1-us.plex.wurl.tv/playlist.m3u8', group: 'Combat', logo: 'https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?auto=format&fit=crop&w=300&q=80' },
    { name: 'Boxing Channel Live', url: 'https://stream.ecable.tv/boxing/index.m3u8', group: 'Combat', logo: 'https://images.unsplash.com/photo-1517438322307-e67111335449?auto=format&fit=crop&w=300&q=80' },
    { name: 'World Poker Tour', url: 'https://wpt-samsungus.amagi.tv/playlist.m3u8', group: 'US Sports', logo: 'https://images.unsplash.com/photo-1511193311914-0346f16efe90?auto=format&fit=crop&w=300&q=80' },
  ];
}

// ── Live Sports Matches Scraper (Dami-TV & PPV.to) ─────────────────────────────

export class LiveMatchesScraper {
  static async fetchDamiTvMatches(): Promise<LiveMatchEvent[]> {
    try {
      const resp = await fetchWithTimeout('https://dami-tv.pro/papi/api/streams', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }, 7000);
      if (!resp.ok) return [];
      const body = await resp.json();
      if (!body?.streams) return [];

      const results: LiveMatchEvent[] = [];
      const categories = body.streams || [];
      const now = Math.floor(Date.now() / 1000);

      for (const cat of categories) {
        const streamList = cat.streams || [];
        for (const s of streamList) {
          const startsAt = Number(s.starts_at) || 0;
          const endsAt = Number(s.ends_at) || 0;
          const isLive = (startsAt && endsAt) ? (now >= startsAt && now <= endsAt) : true;
          const timeLabel = isLive ? 'LIVE NOW' : startsAt > now ? new Date(startsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Scheduled';

          let poster = s.poster || '';
          if (poster.startsWith('/')) poster = `https://dami-tv.pro${poster}`;

          let homeBadge = s.teams?.home?.badge || '';
          if (homeBadge.startsWith('/')) homeBadge = `https://dami-tv.pro${homeBadge}`;
          let awayBadge = s.teams?.away?.badge || '';
          if (awayBadge.startsWith('/')) awayBadge = `https://dami-tv.pro${awayBadge}`;

          const streamUrl = s.iframe || s.url || '';
          if (!streamUrl && !s.id) continue;

          results.push({
            id: `dami-${s.id}`,
            title: s.name || `${s.teams?.home?.name || 'Home'} vs ${s.teams?.away?.name || 'Away'}`,
            league: s.league || cat.category_name || 'Live Sports',
            category: s.category_name || 'Sports',
            startsAt,
            endsAt,
            timeLabel,
            isLive,
            homeTeam: { name: s.teams?.home?.name || 'Home', badge: homeBadge },
            awayTeam: { name: s.teams?.away?.name || 'Away', badge: awayBadge },
            viewers: Number(s.viewers) || 0,
            streamUrl,
            poster,
          });
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  static async fetchPpvMatches(): Promise<LiveMatchEvent[]> {
    try {
      const resp = await fetchWithTimeout('https://old.ppv.to/api/streams', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }, 7000);
      if (!resp.ok) return [];
      const body = await resp.json();
      const categories = body?.streams || [];
      const results: LiveMatchEvent[] = [];
      const now = Math.floor(Date.now() / 1000);

      for (const cat of categories) {
        const streamList = cat.streams || [];
        for (const s of streamList) {
          const startsAt = Number(s.starts_at) || 0;
          const endsAt = Number(s.ends_at) || 0;
          const alwaysLive = Number(s.always_live) === 1;
          const isLive = alwaysLive || ((startsAt && endsAt) ? (now >= startsAt && now <= endsAt) : true);
          const timeLabel = isLive ? 'LIVE NOW' : startsAt > now ? new Date(startsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Scheduled';

          results.push({
            id: `ppv-${s.id}`,
            title: s.name || 'PPV Live Event',
            league: s.tag || cat.category_name || 'PPV',
            category: s.category_name || 'Combat & Sports',
            startsAt,
            endsAt,
            timeLabel,
            isLive,
            streamUrl: s.iframe || s.uri_name ? `https://old.ppv.to/live/${s.uri_name}` : '',
            poster: s.poster || undefined,
          });
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  static getFallbackMatches(): LiveMatchEvent[] {
    const now = Math.floor(Date.now() / 1000);
    return [
      {
        id: 'fallback-uefa-cl',
        title: 'UEFA Champions League · Real Madrid vs Manchester City',
        league: 'Champions League',
        category: 'Football',
        startsAt: now - 1800,
        endsAt: now + 5400,
        timeLabel: 'LIVE NOW',
        isLive: true,
        homeTeam: { name: 'Real Madrid', badge: 'https://upload.wikimedia.org/wikipedia/en/thumb/5/56/Real_Madrid_CF.svg/1200px-Real_Madrid_CF.svg.png' },
        awayTeam: { name: 'Manchester City', badge: 'https://upload.wikimedia.org/wikipedia/en/thumb/e/eb/Manchester_City_FC_badge.svg/1200px-Manchester_City_FC_badge.svg.png' },
        viewers: 42800,
        streamUrl: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8',
        poster: 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?auto=format&fit=crop&w=800&q=80',
      },
      {
        id: 'fallback-premier-league',
        title: 'Premier League · Arsenal vs Liverpool',
        league: 'Premier League',
        category: 'Football',
        startsAt: now - 900,
        endsAt: now + 6300,
        timeLabel: 'LIVE NOW',
        isLive: true,
        homeTeam: { name: 'Arsenal', badge: 'https://upload.wikimedia.org/wikipedia/en/thumb/5/53/Arsenal_FC.svg/1200px-Arsenal_FC.svg.png' },
        awayTeam: { name: 'Liverpool', badge: 'https://upload.wikimedia.org/wikipedia/en/thumb/0/0c/Liverpool_FC.svg/1200px-Liverpool_FC.svg.png' },
        viewers: 38500,
        streamUrl: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8',
        poster: 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&w=800&q=80',
      },
      {
        id: 'fallback-f1-grand-prix',
        title: 'Formula 1 · Monaco Grand Prix Main Race',
        league: 'Formula 1',
        category: 'Motorsport',
        startsAt: now - 3600,
        endsAt: now + 3600,
        timeLabel: 'LIVE NOW',
        isLive: true,
        homeTeam: { name: 'Monaco GP', badge: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/33/F1.svg/1200px-F1.svg.png' },
        awayTeam: { name: 'Round 8', badge: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/33/F1.svg/1200px-F1.svg.png' },
        viewers: 55400,
        streamUrl: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8',
        poster: 'https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?auto=format&fit=crop&w=800&q=80',
      },
      {
        id: 'fallback-ufc-300',
        title: 'UFC 300 · Pereira vs Hill — World Championship',
        league: 'UFC',
        category: 'Combat',
        startsAt: now - 1200,
        endsAt: now + 6000,
        timeLabel: 'LIVE NOW',
        isLive: true,
        homeTeam: { name: 'Alex Pereira', badge: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/UFC_logo.svg/1200px-UFC_logo.svg.png' },
        awayTeam: { name: 'Jamahal Hill', badge: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/UFC_logo.svg/1200px-UFC_logo.svg.png' },
        viewers: 68100,
        streamUrl: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8',
        poster: 'https://images.unsplash.com/photo-1517838277536-f5f99be501cd?auto=format&fit=crop&w=800&q=80',
      },
      {
        id: 'fallback-nba-finals',
        title: 'NBA Finals · Boston Celtics vs Dallas Mavericks',
        league: 'NBA',
        category: 'Basketball',
        startsAt: now - 2400,
        endsAt: now + 4800,
        timeLabel: 'LIVE NOW',
        isLive: true,
        homeTeam: { name: 'Celtics', badge: 'https://upload.wikimedia.org/wikipedia/en/thumb/8/8f/Boston_Celtics.svg/1200px-Boston_Celtics.svg.png' },
        awayTeam: { name: 'Mavericks', badge: 'https://upload.wikimedia.org/wikipedia/en/thumb/9/97/Dallas_Mavericks_logo.svg/1200px-Dallas_Mavericks_logo.svg.png' },
        viewers: 34900,
        streamUrl: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8',
        poster: 'https://images.unsplash.com/photo-1546519638-68e109498ffc?auto=format&fit=crop&w=800&q=80',
      },
    ];
  }
}

// ── Local Storage Store ───────────────────────────────────────────────────────

export class IptvStore {
  private static readonly PORTALS_KEY = 'praha.iptv.portals';
  private static readonly FAVORITES_KEY = 'praha.iptv.favorites';
  private static readonly PLAYLISTS_KEY = 'praha.iptv.playlists';

  static loadPortals(): VerifiedPortal[] {
    try {
      const raw = localStorage.getItem(this.PORTALS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  static savePortals(portals: VerifiedPortal[]): void {
    try {
      localStorage.setItem(this.PORTALS_KEY, JSON.stringify(portals));
    } catch {
      // quota or storage unavailable
    }
  }

  static loadFavorites(): string[] {
    try {
      const raw = localStorage.getItem(this.FAVORITES_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  static saveFavorites(favs: string[]): void {
    try {
      localStorage.setItem(this.FAVORITES_KEY, JSON.stringify(favs));
    } catch {
      // quota
    }
  }

  static loadPlaylists(): M3uPlaylist[] {
    try {
      const raw = localStorage.getItem(this.PLAYLISTS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  static savePlaylists(playlists: M3uPlaylist[]): void {
    try {
      localStorage.setItem(this.PLAYLISTS_KEY, JSON.stringify(playlists));
    } catch {
      // quota
    }
  }
}


// ── Public IPTV Sources (user-selectable catalog) ─────────────────────────────
// The first two entries are the featured/main sources; every source below is
// loadable through the Sources tab. Xtream portal scraping is untouched and
// remains a separate mechanism.

export interface IptvSourceEntry {
  id: string;
  name: string;
  description: string;
  kind: 'playlist' | 'epg' | 'selfhosted' | 'web';
  main?: boolean;
  /** Direct playlist URL for kind 'playlist'. */
  url?: string;
  /** XMLTV guide URL for kind 'epg' (reference; copyable in the UI). */
  epgUrl?: string;
  /** Suggested EPG guide that pairs with this playlist. */
  suggestedEpg?: string;
  homepage?: string;
}

export class IptvSources {
  private static readonly PLAYLIST_CACHE = new Map<string, M3uChannel[]>();
  private static readonly COUNTRIES_CACHE = new Map<string, Array<{ code: string; name: string }>>();

  /** Categories exposed for iptv-org. The adult category is deliberately absent. */
  static readonly IPTV_ORG_CATEGORIES = [
    'animation', 'auto', 'business', 'classic', 'comedy', 'cooking', 'culture',
    'documentary', 'education', 'entertainment', 'family', 'general', 'kids',
    'legislative', 'lifestyle', 'movies', 'music', 'news', 'outdoor', 'relax',
    'religious', 'science', 'series', 'shop', 'sports', 'travel', 'weather',
  ];

  static readonly CATALOG: IptvSourceEntry[] = [
    {
      id: 'iptv-org',
      name: 'iptv-org',
      description: 'The largest public IPTV collection — thousands of channels by country, language and category. Pick a country or category below.',
      kind: 'playlist',
      main: true,
      homepage: 'https://iptv-org.github.io/',
      suggestedEpg: 'iptv-epg:{cc}',
    },
    {
      id: 'stepdaddy',
      name: 'StepDaddyLiveHD',
      description: 'Self-hosted IPTV proxy for DLHD — 1,000+ TV channels plus live sports events. Enter the URL of your own StepDaddyLiveHD server (Docker or local) and PRAHA loads its playlist.m3u8.',
      kind: 'selfhosted',
      main: true,
      homepage: 'https://github.com/gookie-dev/StepDaddyLiveHD',
    },
    {
      id: 'doms9-base',
      name: 'doms9 IPTV — Base',
      description: 'Health-checked TV channels & sporting events, auto-updated daily (~160 working streams).',
      kind: 'playlist',
      url: 'https://raw.githubusercontent.com/doms9/iptv/default/M3U8/base.m3u8',
      homepage: 'https://github.com/doms9/iptv',
    },
    {
      id: 'aria',
      name: 'Aria (stable)',
      description: 'Curated worldwide channels from official sources only; unstable streams excluded. Updated very often.',
      kind: 'playlist',
      url: 'https://raw.githubusercontent.com/aria-tv/aria/main/aria.m3u',
      homepage: 'https://github.com/aria-tv/aria',
    },
    {
      id: 'aria-plus',
      name: 'Aria+ (extended)',
      description: 'Everything in Aria plus less-stable Xtream/Stalker portal streams.',
      kind: 'playlist',
      url: 'https://raw.githubusercontent.com/aria-tv/aria/main/aria%2B.m3u',
      homepage: 'https://github.com/aria-tv/aria',
    },
    {
      id: 'ibert-fmml-index',
      name: 'ibert — fanmingming index',
      description: 'Auto-updated mirror of fanmingming/live (~94 channels, EPG-friendly tvg-ids).',
      kind: 'playlist',
      url: 'https://m3u.ibert.me/fmml_index.m3u',
      suggestedEpg: 'https://m3u.ibert.me/epg/fmml.xml',
      homepage: 'https://m3u.ibert.me/',
    },
    {
      id: 'ibert-all',
      name: 'ibert — epg.pw All',
      description: 'epg.pw aggregate playlist (~747 channels) with matching EPG ids.',
      kind: 'playlist',
      url: 'https://m3u.ibert.me/all.m3u',
      homepage: 'https://m3u.ibert.me/',
    },
    {
      id: 'ibert-yg',
      name: 'ibert — YanG-1989 Gather',
      description: 'Community-maintained Asian & international mix (~123 channels).',
      kind: 'playlist',
      url: 'https://m3u.ibert.me/y_g.m3u',
      homepage: 'https://m3u.ibert.me/',
    },
    {
      id: 'ibert-ycl',
      name: 'ibert — YueChan Live',
      description: 'YueChan/Live mirror (~96 channels).',
      kind: 'playlist',
      url: 'https://m3u.ibert.me/ycl_iptv.m3u',
      homepage: 'https://m3u.ibert.me/',
    },
    {
      id: 'iptvcat',
      name: 'IPTVCat',
      description: 'Community playlist aggregator — browse iptvcat.net in your browser and paste any download URL into the M3U Playlists tab.',
      kind: 'web',
      homepage: 'https://iptvcat.net/home_7',
    },
  ];

  /** XMLTV guides the user can copy into players or future EPG wiring. */
  static readonly EPG_GUIDES: IptvSourceEntry[] = [
    { id: 'epg-in', name: 'EPG — India', description: '276 channels · updated hourly', kind: 'epg', epgUrl: 'https://iptv-epg.org/files/epg-in.xml.gz' },
    { id: 'epg-us', name: 'EPG — United States', description: '12,430 channels · updated hourly', kind: 'epg', epgUrl: 'https://iptv-epg.org/files/epg-us.xml.gz' },
    { id: 'epg-gb', name: 'EPG — United Kingdom', description: '882 channels · updated hourly', kind: 'epg', epgUrl: 'https://iptv-epg.org/files/epg-gb.xml.gz' },
    { id: 'epg-au', name: 'EPG — Australia (mjh.nz)', description: 'Free-to-air AU guide (XMLTV)', kind: 'epg', epgUrl: 'https://i.mjh.nz/au/epg.xml' },
    { id: 'epg-nz', name: 'EPG — New Zealand (mjh.nz)', description: 'Free-to-air NZ guide (XMLTV)', kind: 'epg', epgUrl: 'https://i.mjh.nz/nz/epg.xml' },
    { id: 'epg-pluto', name: 'EPG — Pluto TV (mjh.nz)', description: 'Pluto TV full guide (XMLTV, gzip)', kind: 'epg', epgUrl: 'https://i.mjh.nz/PlutoTV/all.xml.gz' },
    { id: 'epg-samsung', name: 'EPG — Samsung TV Plus (mjh.nz)', description: 'Samsung TV Plus guide (XMLTV, gzip)', kind: 'epg', epgUrl: 'https://i.mjh.nz/SamsungTVPlus/all.xml.gz' },
    { id: 'epg-fmml', name: 'EPG — fanmingming/live', description: 'Chinese + international guide (XMLTV)', kind: 'epg', epgUrl: 'https://m3u.ibert.me/epg/fmml.xml' },
  ];

  static readonly IPTV_ORG_COUNTRIES_FALLBACK: Array<{ code: string; name: string }> = [
    { code: 'in', name: 'India' }, { code: 'us', name: 'United States' }, { code: 'gb', name: 'United Kingdom' },
    { code: 'ca', name: 'Canada' }, { code: 'au', name: 'Australia' }, { code: 'de', name: 'Germany' },
    { code: 'fr', name: 'France' }, { code: 'it', name: 'Italy' }, { code: 'es', name: 'Spain' },
    { code: 'br', name: 'Brazil' }, { code: 'mx', name: 'Mexico' }, { code: 'jp', name: 'Japan' },
    { code: 'kr', name: 'South Korea' }, { code: 'ae', name: 'United Arab Emirates' }, { code: 'pk', name: 'Pakistan' },
    { code: 'id', name: 'Indonesia' }, { code: 'my', name: 'Malaysia' }, { code: 'sg', name: 'Singapore' },
    { code: 'tr', name: 'Turkey' }, { code: 'ru', name: 'Russia' }, { code: 'za', name: 'South Africa' },
    { code: 'ar', name: 'Argentina' }, { code: 'nl', name: 'Netherlands' }, { code: 'pt', name: 'Portugal' },
    { code: 'th', name: 'Thailand' }, { code: 'ph', name: 'Philippines' },
  ];

  /**
   * Country list for the iptv-org picker, from the official iptv-org API with
   * a curated offline fallback so the picker always renders.
   */
  static async listIptvOrgCountries(): Promise<Array<{ code: string; name: string }>> {
    const cached = this.COUNTRIES_CACHE.get('all');
    if (cached) return cached;
    try {
      const res = await nativeFetchText('https://iptv-org.github.io/api/countries.json', { timeoutMs: 10000 });
      if (res.ok && res.data.trim().startsWith('[')) {
        const parsed = JSON.parse(res.data) as Array<{ code?: string; name?: string }>;
        const list = parsed
          .filter((c) => c.code && c.name)
          .map((c) => ({ code: String(c.code).toLowerCase(), name: String(c.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (list.length) {
          this.COUNTRIES_CACHE.set('all', list);
          evictOldest(this.COUNTRIES_CACHE, 2);
          return list;
        }
      }
    } catch {
      // Fall back to the offline list.
    }
    return this.IPTV_ORG_COUNTRIES_FALLBACK;
  }

  static iptvOrgCountryUrl(code: string): string {
    return `https://iptv-org.github.io/iptv/countries/${encodeURIComponent(code.toLowerCase())}.m3u`;
  }

  static iptvOrgCategoryUrl(category: string): string {
    return `https://iptv-org.github.io/iptv/categories/${encodeURIComponent(category.toLowerCase())}.m3u`;
  }

  static iptvOrgIndexUrl(): string {
    return 'https://iptv-org.github.io/iptv/index.m3u';
  }

  /** Normalizes a self-hosted StepDaddyLiveHD server URL into its playlist URL. */
  static stepDaddyPlaylistUrl(serverBase: string): string {
    const base = serverBase.trim().replace(/\/+$/, '');
    if (!base) return '';
    if (/playlist\.m3u8?$/i.test(base)) return base;
    return `${base}/playlist.m3u8`;
  }

  /** Community sources are family-facing: strip obvious adult channels. */
  private static isAdultChannel(channel: M3uChannel): boolean {
    const haystack = `${channel.group || ''} ${channel.name}`.toLowerCase();
    return /(xxx|porn|adult|\b18\+\b|erotic|sex)/.test(haystack);
  }

  /**
   * Loads and parses a public playlist through the native CORS-bypass client.
   * Results are cached per URL (bounded) so re-selecting a source is instant.
   */
  static async loadPlaylist(url: string, timeoutMs = 20000): Promise<M3uChannel[]> {
    const cached = this.PLAYLIST_CACHE.get(url);
    if (cached) return cached;
    const res = await nativeFetchText(url, { timeoutMs });
    if (!res.ok && !res.data) throw new Error(`HTTP ${res.status || 'error'} while loading the playlist.`);
    const text = res.data || '';
    if (text.trimStart().startsWith('<')) {
      throw new Error('That playlist URL returned an HTML page instead of an M3U playlist.');
    }
    const channels = M3uParser.parse(text).filter((ch) => !this.isAdultChannel(ch) && Boolean(ch.url));
    if (!channels.length) throw new Error('The playlist loaded but contained no playable channels.');
    this.PLAYLIST_CACHE.set(url, channels);
    evictOldest(this.PLAYLIST_CACHE, 12);
    return channels;
  }
}

export class IptvSourceStore {
  private static readonly SOURCE_KEY = 'praha.iptv.sources';

  static loadStepDaddyUrl(): string {
    try {
      const raw = localStorage.getItem(this.SOURCE_KEY);
      const parsed = raw ? (JSON.parse(raw) as { stepDaddyUrl?: string; iptvOrgCountry?: string }) : {};
      return parsed.stepDaddyUrl || '';
    } catch {
      return '';
    }
  }

  static saveStepDaddyUrl(url: string): void {
    this.patch({ stepDaddyUrl: url });
  }

  static loadIptvOrgCountry(): string {
    try {
      const raw = localStorage.getItem(this.SOURCE_KEY);
      const parsed = raw ? (JSON.parse(raw) as { iptvOrgCountry?: string }) : {};
      return parsed.iptvOrgCountry || 'in';
    } catch {
      return 'in';
    }
  }

  static saveIptvOrgCountry(code: string): void {
    this.patch({ iptvOrgCountry: code });
  }

  private static patch(data: Record<string, unknown>): void {
    try {
      const raw = localStorage.getItem(this.SOURCE_KEY);
      const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      localStorage.setItem(this.SOURCE_KEY, JSON.stringify({ ...current, ...data }));
    } catch {
      // quota or storage unavailable
    }
  }
}
