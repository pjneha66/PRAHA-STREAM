import { nativeFetchText } from './androidBridge';
import { comicsRelayUrl } from './comicsRelay';

const isVerificationPage = (html: string) =>
  /<title>[^<]*(?:just a moment|ddos.guard|verify you are human|human verification)/i.test(html);

export class ReadingVerificationRequired extends Error {
  constructor() {
    super('Complete the site’s browser verification to continue.');
  }
}

export async function fetchReadingPage(source: string, url: string, headers?: Record<string, string>): Promise<string> {
  const request = (target: string, requestHeaders?: Record<string, string>) =>
    nativeFetchText(target, { timeoutMs: 6500, headers: requestHeaders });
  const direct = await request(url, headers).catch(() => null);
  const needsVerification = Boolean(direct?.data && isVerificationPage(direct.data));
  if (source === 'annasarchive' && needsVerification) throw new ReadingVerificationRequired();
  if (direct?.ok && direct.data && !needsVerification) return direct.data;

  if (import.meta.env.MODE !== 'test') {
    try {
      const response = await request(comicsRelayUrl(`/reading-page/${source}?${new URLSearchParams({ url })}`, true));
      if (response.ok && response.data && !isVerificationPage(response.data)) return response.data;
    } catch { /* Surface one source error to the reader. */ }
  }
  throw new Error('Could not load this source.');
}
