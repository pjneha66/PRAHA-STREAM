// The network a plugin may reach — a port of VyseTV's `_checkHost`, `_plainlyLocal`
// and `isPrivateAddress` in `lib/data/sources/plugins/js_plugins.dart`
// (GPL-3.0-or-later).
//
// Plugins are third-party JavaScript from repositories the user adds. Each one
// gets `http()` and nothing else, but an unguarded `http()` is enough to make the
// device fetch `http://192.168.1.1/` (a router admin page), `http://localhost:8090`
// (PRAHA's own TorrServer) or a cloud metadata endpoint, and hand the body back to
// the plugin author. VyseTV blocks that by checking every hop: only http/https,
// and never localhost, loopback, private, link-local, multicast or reserved.
//
// PRAHA had no equivalent guard — `nuvioWorker` runs `new Function` on scrapers
// with a plain `fetch`. This module is the one place that decides whether an
// address is reachable, and both the plugin runtime and the Nuvio worker use it.

/** Thrown when a plugin asks for an address it is not allowed to reach. */
export class BlockedAddressError extends Error {
  constructor(message = "This address is on your own network, which plugins may not reach.") {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

const parseIpv4 = (host: string): number[] | null => {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
};

/**
 * IPv6 in any of the shapes a URL may carry: full, compressed, or with an
 * embedded IPv4 tail (`::ffff:192.168.1.1`). Returns the 16 bytes, or null.
 */
const parseIpv6 = (rawHost: string): number[] | null => {
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host.includes(':')) return null;

  // A trailing dotted quad counts as the last two groups.
  let tail: number[] = [];
  const lastColon = host.lastIndexOf(':');
  const maybeV4 = host.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const quad = parseIpv4(maybeV4);
    if (!quad) return null;
    tail = [(quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]];
    host = `${host.slice(0, lastColon + 1)}0:0`;
  }

  const halves = host.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (!part) return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !rest) return null;

  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  if (tail.length) groups = [...groups.slice(0, 6), ...tail];

  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
};

const isPrivateV4 = (octets: number[]): boolean => {
  const [a, b] = octets;
  // This host, its own network, and the ranges that only exist inside one:
  // 0/8, 10/8, 127/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16.
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  // Multicast and the reserved 240/4 block, plus broadcast.
  if (a >= 224) return true;
  return false;
};

const isPrivateV6 = (bytes: number[]): boolean => {
  // fc00::/7 unique-local
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  // fe80::/10 link-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  // ff00::/8 multicast
  if (bytes[0] === 0xff) return true;
  // ::1 loopback and :: unspecified
  const first15Zero = bytes.slice(0, 15).every((byte) => byte === 0);
  if (first15Zero && (bytes[15] === 0 || bytes[15] === 1)) return true;
  // ::ffff:a.b.c.d — judge the IPv4 tail.
  const v4Mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (v4Mapped) return isPrivateV4(bytes.slice(12));
  return false;
};

/**
 * Whether a hostname or IP literal is this device or its local network —
 * decided from the name alone, with no DNS lookup.
 */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  const v4 = parseIpv4(host);
  if (v4) return isPrivateV4(v4);
  const v6 = parseIpv6(host);
  if (v6) return isPrivateV6(v6);
  return false;
}

/**
 * Throws unless `rawUrl` is an ordinary public http/https address.
 *
 * Redirects are followed by the caller one hop at a time, and each hop is
 * re-checked — a public URL that 302s to `http://192.168.1.1/` has to be
 * refused at the second hop, not waved through on the first.
 */
export function assertPublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedAddressError('That is not a valid address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedAddressError('Plugins may only fetch http and https addresses.');
  }
  if (isLocalHostname(url.hostname)) {
    throw new BlockedAddressError();
  }
  return url;
}

/** True when `rawUrl` passes the checks above, for filtering without throwing. */
export function isPublicHttpUrl(rawUrl: string): boolean {
  try {
    assertPublicHttpUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}
