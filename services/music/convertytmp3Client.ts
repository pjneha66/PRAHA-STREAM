// Convertytmp3: the mp3 mirror VyseTV falls back to when YouTube refuses to
// hand over a direct audio URL.
//
// Ported from VyseTV `lib/services/music/convertytmp3_client.dart`
// (GPL-3.0-or-later). The handshake is short and strictly sequential:
//
//   auth → init → convertURL (following up to 5 redirects) → downloadURL,
//   or poll progressURL until status 3 (up to 10 times, 1.2 s apart).
//
// Every failure path returns `null`; a partial URL is never handed back.

import { nativeFetchText } from '../androidBridge';

const REQUEST_TIMEOUT_MS = 6000;
const PROGRESS_TIMEOUT_MS = 5000;
const PROGRESS_POLL_MS = 1200;
const MAX_PROGRESS_POLLS = 10;
const MAX_CONVERT_REDIRECTS = 5;

/** The UA this mirror expects, also used to play what it returns. */
export const CONVERTYTMP3_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';

const BASE_HEADERS: Record<string, string> = {
  'User-Agent': CONVERTYTMP3_USER_AGENT,
  Accept: 'application/json, text/javascript, */*; q=0.01',
  Origin: 'https://convertytmp3.org',
  Referer: 'https://convertytmp3.org/',
};

function now(): number {
  return Date.now();
}

/** GETs and parses JSON. Returns `null` on any non-200 or unparseable body. */
async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await nativeFetchText(url, { method: 'GET', headers, timeoutMs });
    if (response.status !== 200 || !response.data) return null;
    const parsed = JSON.parse(response.data) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Resolves a playable mp3 URL for a YouTube video id, or `null`.
 * Port of `Convertytmp3Client.getStreamUrl`.
 */
export async function getStreamUrl(videoId: string): Promise<string | null> {
  if (!videoId) return null;

  try {
    // 1. Anonymous bearer key.
    const auth = await getJson(
      `https://epsilon.epsiloncloud.org/api/v1/auth?_=${now()}`,
      BASE_HEADERS,
      REQUEST_TIMEOUT_MS,
    );
    const key = auth?.key;
    if (typeof key !== 'string' || !key) return null;

    const authHeaders: Record<string, string> = { ...BASE_HEADERS, Authorization: `Bearer ${key}` };

    // 2. Init hands back the converter endpoint to call.
    const init = await getJson(
      `https://epsilon.epsiloncloud.org/api/v1/init?_=${now()}`,
      authHeaders,
      REQUEST_TIMEOUT_MS,
    );
    const convertUrl = init?.convertURL;
    if (typeof convertUrl !== 'string' || !convertUrl) return null;

    // 3. Convert, following the mirror's own redirect chain.
    let currentConvertUrl = `${convertUrl}&v=${videoId}&f=mp3&_=${now()}`;
    let convertJson: Record<string, unknown> | null = null;

    for (let attempt = 0; attempt < MAX_CONVERT_REDIRECTS; attempt += 1) {
      const response = await getJson(currentConvertUrl, authHeaders, REQUEST_TIMEOUT_MS);
      if (!response) return null;
      convertJson = response;

      const redirectUrl = response.redirectURL;
      if (response.redirect === 1 && typeof redirectUrl === 'string' && redirectUrl) {
        currentConvertUrl = redirectUrl;
      } else {
        break;
      }
    }
    if (!convertJson) return null;

    // 4. Either a download URL came straight back, or we poll progress.
    let downloadUrl = typeof convertJson.downloadURL === 'string' ? convertJson.downloadURL : '';
    const progressUrl = typeof convertJson.progressURL === 'string' ? convertJson.progressURL : '';

    if (!downloadUrl && progressUrl) {
      let status = 0;
      let polls = 0;
      while (status !== 3) {
        polls += 1;
        if (polls > MAX_PROGRESS_POLLS) return null;
        await sleep(PROGRESS_POLL_MS);

        const progress = await getJson(progressUrl, authHeaders, PROGRESS_TIMEOUT_MS);
        if (!progress) return null;

        status = typeof progress.status === 'number' ? progress.status : 0;
        if (status === 3) {
          downloadUrl = typeof progress.downloadURL === 'string' ? progress.downloadURL : '';
          break;
        }
        if (status < 0) return null;
      }
    }

    return downloadUrl || null;
  } catch {
    return null;
  }
}
