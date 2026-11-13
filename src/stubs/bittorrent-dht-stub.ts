/**
 * Browser stub for node-only modules that webtorrent's dependency graph pulls
 * in via bare imports (bittorrent-dht exposes nothing in the browser; DHT
 * discovery is impossible over WebRTC anyway). Vite externalizes these for
 * the browser but the generated empty module has no named exports, so the
 * named import `{ Client as DHT }` in torrent-discovery fails the build.
 */
export const Client = class ClientStub {
  constructor() {
    throw new Error('bittorrent-dht is unavailable in the browser.');
  }
};
export default { Client };
