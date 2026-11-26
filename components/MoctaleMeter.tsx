import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { cancelAndroidMoctaleMeter, isAndroidApp, loadAndroidMoctaleMeter, openProtectedEmbed, openSafeExternalUrl } from '../services/androidBridge';
import { comicsRelayUrl } from '../services/comicsRelay';

const labels = ['Perfection', 'Go for it', 'Timepass', 'Skip'] as const;
type Bucket = { label: typeof labels[number]; percent: number; lessThan?: boolean };
type Result = { state: 'ready'; url: string; buckets: Bucket[]; noReviews: boolean; score?: number; votes?: number }
  | { state: 'unavailable'; url: string };

function readResult(value: unknown): Result | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Partial<Result>;
  if (typeof data.url !== 'string') return null;
  try {
    const url = new URL(data.url);
    if (url.origin !== 'https://www.moctale.in' || url.username || url.password || !url.pathname.startsWith('/content/')) return null;
  } catch { return null; }
  if (data.state === 'unavailable') return { state: data.state, url: data.url };
  if (data.state !== 'ready' || !Array.isArray(data.buckets) || data.buckets.length !== labels.length ||
    !data.buckets.every((entry, index) => entry?.label === labels[index] && Number.isFinite(entry.percent) && entry.percent >= 0 && entry.percent <= 100)) {
    return null;
  }
  const score = typeof data.score === 'number' && Number.isInteger(data.score) && data.score >= 0 && data.score <= 100 ? data.score : undefined;
  const votes = typeof data.votes === 'number' && Number.isSafeInteger(data.votes) && data.votes > 0 ? data.votes : undefined;
  return { state: data.state, url: data.url, buckets: data.buckets, noReviews: Boolean(data.noReviews), score, votes };
}

export default function MoctaleMeter({ title, year, type }: { title: string; year?: string; type: 'movie' | 'series' | 'anime' }) {
  const [loadingPage, setLoadingPage] = useState(false);
  const [loaded, setLoaded] = useState<{ key: string; result: Result } | null>(null);
  const key = new URLSearchParams({ title: title.trim(), year: year || '', type }).toString();

  useEffect(() => {
    if (!title.trim() || !/^\d{4}$/.test(year || '')) return;
    const controller = new AbortController();
    fetch(comicsRelayUrl(`/moctale-meter?${key}`, true), { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((body: unknown) => {
        if (controller.signal.aborted) return;
        const result = readResult(body);
        if (result) setLoaded({ key, result });
      })
      .catch(() => { /* Other title details remain available. */ });
    return () => controller.abort();
  }, [key, title, year]);

  const result = loaded?.key === key ? loaded.result : null;
  const expectedUrl = result?.url;
  const onAndroid = isAndroidApp();

  useEffect(() => {
    const receive = (event: Event) => {
      const meter = readResult((event as CustomEvent<unknown>).detail);
      if (meter?.state === 'ready' && meter.url === expectedUrl) setLoaded({ key, result: meter });
    };
    window.addEventListener('praha:moctale-meter', receive);
    return () => window.removeEventListener('praha:moctale-meter', receive);
  }, [expectedUrl, key]);

  useEffect(() => {
    if (!onAndroid || !expectedUrl || result?.state !== 'unavailable') {
      setLoadingPage(false);
      return;
    }
    let active = true;
    setLoadingPage(true);
    const timeout = window.setTimeout(() => setLoadingPage(false), 11_000);
    void loadAndroidMoctaleMeter(expectedUrl).then((started) => {
      if (active && !started) setLoadingPage(false);
    });
    return () => {
      active = false;
      window.clearTimeout(timeout);
      cancelAndroidMoctaleMeter(expectedUrl);
    };
  }, [expectedUrl, onAndroid, result?.state]);

  if (!result) return null;

  return (
    <section className="moctale-meter" aria-label="Moctale Meter">
      <header>
        <h3>Moctale Meter</h3>
        <button type="button" className="text-button" onClick={() => void (onAndroid ? openProtectedEmbed(result.url) : openSafeExternalUrl(result.url))}>
          {result.state === 'ready' ? 'Moctale' : 'Open Moctale'} <ExternalLink size={12} aria-hidden="true" />
        </button>
      </header>
      {result.state === 'ready' ? (
        <>
          {result.score !== undefined && <p><strong>{result.score}%</strong>{result.votes && ` · ${result.votes.toLocaleString()} votes`}</p>}
          <dl>
            {result.buckets.map(({ label, percent, lessThan }) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{lessThan ? '<' : ''}{percent}%</dd>
              </div>
            ))}
          </dl>
          {result.noReviews && <p>No reviews yet on Moctale.</p>}
        </>
      ) : <p>{loadingPage ? 'Loading live Meter…' : onAndroid ? 'Open Moctale if the site asks you to sign in.' : 'Live Meter unavailable.'}</p>}
    </section>
  );
}
