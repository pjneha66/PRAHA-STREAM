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
const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/**
 * Parses semver string (e.g. "v2.4.0", "2.5.0") into numerical components.
 */
function parseVersion(v: string): [number, number, number] {
  const clean = v.replace(/^v/i, '').trim();
  const parts = clean.split('.').map((p) => parseInt(p, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/**
 * Returns true if latest version is strictly greater than current version.
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const [cMajor, cMinor, cPatch] = parseVersion(current);
  const [lMajor, lMinor, lPatch] = parseVersion(latest);

  if (lMajor > cMajor) return true;
  if (lMajor < cMajor) return false;
  if (lMinor > cMinor) return true;
  if (lMinor < cMinor) return false;
  return lPatch > cPatch;
}

/**
 * Queries GitHub Releases API for the latest published PRAHA STREAM release.
 */
export async function checkForUpdates(currentVersion: string): Promise<UpdateInfo | null> {
  try {
    const res = await nativeFetchText(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'PRAHA-STREAM-App',
      },
      timeoutMs: 6000,
    });

    if (!res.ok || !res.data) return null;

    const data = JSON.parse(res.data);
    const tagName = String(data.tag_name || '').trim();
    if (!tagName) return null;

    const hasUpdate = isNewerVersion(currentVersion, tagName);

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
      releaseTitle: data.name || `PRAHA STREAM ${tagName}`,
      releaseNotes: data.body || 'New features and bug fixes in this release.',
      publishedAt: data.published_at || data.created_at || new Date().toISOString(),
      apkUrl,
      apkSize,
      apkName,
      htmlUrl: data.html_url || `https://github.com/${GITHUB_REPO}/releases`,
    };
  } catch {
    return null;
  }
}
