import { nativeFetchText } from './androidBridge';

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseTitle: string;
  releaseNotes: string;
  publishedAt: string;
  apkUrl: string;
  apkSize: number;
  apkName: string;
  htmlUrl: string;
}

const GITHUB_REPO = 'pjneha66/PRAHA-STREAM';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases`;

/** Update channel (port of Nuvio's UpdateChannel): stable = final releases only, beta = includes prereleases. */
export type UpdateChannel = 'stable' | 'beta';
const CHANNEL_KEY = 'praha.updates.channel';
const DISMISSED_KEY = 'praha.updates.dismissedVersion';

export function getUpdateChannel(): UpdateChannel {
  try {
    return localStorage.getItem(CHANNEL_KEY) === 'beta' ? 'beta' : 'stable';
  } catch {
    return 'stable';
  }
}

export function setUpdateChannel(channel: UpdateChannel): void {
  try {
    localStorage.setItem(CHANNEL_KEY, channel);
  } catch {
    // Ignore
  }
}

export function dismissUpdateVersion(version: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // Ignore
  }
}

export function getDismissedUpdateVersion(): string {
  try {
    return localStorage.getItem(DISMISSED_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * Parses semver string (e.g. "v2.4.0", "2.5.0", "2.6.0-beta.1") into
 * numerical components with prerelease awareness.
 */
function parseVersion(v: string): [number, number, number, number] {
  const clean = v.replace(/^v/i, '').trim();
  const [core, pre] = clean.split('-');
  const parts = core.split('.').map((p) => parseInt(p, 10) || 0);
  // A prerelease of the same core version ranks below it (Nuvio's VersionUtils rule).
  const preRank = pre ? -1 : 0;
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0, preRank];
}

/**
 * Returns true if latest version is strictly greater than current version.
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const [cMajor, cMinor, cPatch, cPre] = parseVersion(current);
  const [lMajor, lMinor, lPatch, lPre] = parseVersion(latest);

  if (lMajor !== cMajor) return lMajor > cMajor;
  if (lMinor !== cMinor) return lMinor > cMinor;
  if (lPatch !== cPatch) return lPatch > cPatch;
  return lPre > cPre;
}

/**
 * Queries GitHub Releases API for the newest release on the selected channel
 * (stable = published non-prereleases, beta = everything including drafts of
 * the next build).
 */
export async function checkForUpdates(currentVersion: string): Promise<UpdateInfo | null> {
  try {
    const res = await nativeFetchText(`${RELEASES_API}?per_page=15`, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'PRAHA-STREAM-App',
      },
      timeoutMs: 6000,
    });

    if (!res.ok || !res.data) return null;

    const releases = JSON.parse(res.data) as Array<Record<string, unknown>>;
    if (!Array.isArray(releases) || !releases.length) return null;
    const channel = getUpdateChannel();
    const data = releases.find((release) => channel === 'beta' || !release.prerelease);
    if (!data) return null;

    const tagName = String(data.tag_name || '').trim();
    if (!tagName) return null;

    const hasUpdate = isNewerVersion(currentVersion, tagName) && tagName !== getDismissedUpdateVersion();

    // Pick best APK asset (prefer non-debug release apk, fallback to any apk)
    const assets = Array.isArray(data.assets) ? data.assets : [];
    let chosenAsset = assets.find((a: any) =>
      typeof a.name === 'string' && a.name.endsWith('.apk') && !a.name.includes('debug')
    );

    if (!chosenAsset) {
      chosenAsset = assets.find((a: any) =>
        typeof a.name === 'string' && a.name.endsWith('.apk')
      );
    }

    const apkUrl = chosenAsset?.browser_download_url || data.html_url || '';
    const apkSize = Number(chosenAsset?.size || 0);
    const apkName = chosenAsset?.name || `praha-stream-${tagName}.apk`;

    return {
      hasUpdate,
      currentVersion,
      latestVersion: tagName,
      releaseTitle: String(data.name || `PRAHA STREAM ${tagName}`),
      releaseNotes: String(data.body || 'New features and bug fixes in this release.'),
      publishedAt: String(data.published_at || data.created_at || new Date().toISOString()),
      apkUrl,
      apkSize,
      apkName,
      htmlUrl: String(data.html_url || `https://github.com/${GITHUB_REPO}/releases`),
    };
  } catch {
    return null;
  }
}

