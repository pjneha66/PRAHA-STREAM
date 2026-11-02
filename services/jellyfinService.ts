import { nativeFetchText } from './androidBridge';

/** Preserve an optional reverse-proxy base path; never accept embedded credentials. */
export function normalizeJellyfinUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an http(s) server URL without credentials, query or fragment.');
  }
  return url.toString().replace(/\/+$/, '');
}

const deviceId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `praha-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clientHeader = `MediaBrowser Client="PRAHA STREAM", Device="PRAHA", DeviceId="${deviceId}", Version="2.2.0"`;
async function request<T>(url: string, options: { method?: string; body?: string; token?: string } = {}): Promise<T> {
  const response = await nativeFetchText(url, {
    method: options.method || 'GET',
    body: options.body,
    timeoutMs: 12000,
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Emby-Authorization': clientHeader, ...(options.token ? { 'X-Emby-Token': options.token } : {}) },
  });
  if (!response.ok) throw new Error(`Jellyfin request failed (HTTP ${response.status}). Check the server and login.`);
  try { return JSON.parse(response.data) as T; } catch { throw new Error('The server returned an invalid Jellyfin response.'); }
}

export async function signInJellyfin(base: string, username: string, password: string) {
  const result = await request<{ AccessToken?: string; User?: { Id?: string; Name?: string } }>(`${base}/Users/AuthenticateByName`, {
    method: 'POST', body: JSON.stringify({ Username: username, Pw: password }),
  });
  if (!result.AccessToken || !result.User?.Id) throw new Error('Jellyfin did not return a valid session.');
  return { token: result.AccessToken, userId: result.User.Id, name: result.User.Name || username };
}

export interface JellyfinItem { Id: string; Name: string; Type: string; ProductionYear?: number }
export async function listJellyfinItems(base: string, token: string, userId: string): Promise<JellyfinItem[]> {
  const query = new URLSearchParams({ Recursive: 'true', IncludeItemTypes: 'Movie,Series', SortBy: 'SortName', SortOrder: 'Ascending', Limit: '50' });
  const response = await request<{ Items?: JellyfinItem[] }>(`${base}/Users/${encodeURIComponent(userId)}/Items?${query}`, { token });
  if (!Array.isArray(response.Items)) throw new Error('Jellyfin returned an invalid library.');
  return response.Items.filter((item) => typeof item.Id === 'string' && typeof item.Name === 'string');
}

/** Invalidate the short-lived browsing session after the list is fetched. */
export async function signOutJellyfin(base: string, token: string): Promise<void> {
  const response = await nativeFetchText(`${base}/Sessions/Logout`, { method: 'POST', headers: { 'X-Emby-Authorization': clientHeader, 'X-Emby-Token': token }, timeoutMs: 12000 });
  if (!response.ok) throw new Error('Jellyfin could not close the browsing session.');
}
