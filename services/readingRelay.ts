import { nativeFetchText } from './androidBridge';
import { comicsRelayUrl } from './comicsRelay';

export async function fetchReadingPage(source: string, url: string, headers?: Record<string, string>): Promise<string> {
  const request = (target: string, requestHeaders?: Record<string, string>) =>
    nativeFetchText(target, { timeoutMs: 6500, headers: requestHeaders });
  try {
    const response = await request(url, headers);
    if (response.ok && response.data && !/<title>[^<]*(?:just a moment|ddos.guard|verify you are human)/i.test(response.data)) {
      return response.data;
    }
  } catch { /* The standalone relay can reach some sources the phone cannot. */ }

  if (import.meta.env.MODE !== 'test') {
    try {
      const response = await request(comicsRelayUrl(`/reading-page/${source}?${new URLSearchParams({ url })}`, true));
      if (response.ok && response.data) return response.data;
    } catch { /* Surface one source error to the reader. */ }
  }
  throw new Error('Could not load this source.');
}
