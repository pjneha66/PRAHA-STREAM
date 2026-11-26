import { describe, expect, it } from 'vitest';
import { fetchMoctaleMeter, moctaleLookup, parseMoctaleMeter } from '../relay/moctale.mjs';

const sample = `<title>Title (2025) | Moctale</title><h1>Title</h1><span>Show • 2025 • 2 seasons</span>
  <section><header><h2>Moctale Meter</h2><p>No Reviews Yet</p></header><div>
  <div><span>Perfection</span><b>51%</b></div><div><span>Go for it</span><b>42%</b></div>
  <div><span>Timepass</span><b>7%</b></div><div><span>Skip</span><b>0%</b></div>
  </div></section>`;
const lookup = moctaleLookup('Title', '2025', 'series');

describe('Moctale Meter relay', () => {
  it('validates the title, year and media type before returning the four published buckets', () => {
    expect(parseMoctaleMeter(sample, lookup)).toEqual({
      buckets: [{ label: 'Perfection', percent: 51 }, { label: 'Go for it', percent: 42 },
        { label: 'Timepass', percent: 7 }, { label: 'Skip', percent: 0 }],
      noReviews: true,
    });
    expect(parseMoctaleMeter(sample, moctaleLookup('Title', '2024', 'series'))).toBeNull();
    expect(parseMoctaleMeter(sample, moctaleLookup('Title', '2025', 'movie'))).toBeNull();
    expect(parseMoctaleMeter(sample, moctaleLookup('Other Title', '2025', 'series'))).toBeNull();
  });

  it('reports a blocked upstream without inventing a Meter', async () => {
    const result = await fetchMoctaleMeter(lookup, async () => new Response('<title>Just a moment...</title>', {
      status: 403, headers: { 'Content-Type': 'text/html' },
    }));
    expect(result).toEqual({ state: 'unavailable', url: lookup.url });
  });

});
