import { fetchReadingIndex, readingIndexes, readingPageTarget } from '../readingSources.mjs';
import { fetchMoctaleMeter, moctaleLookup } from '../moctale.mjs';
import { hostedComicPage } from '../comickSources.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '3600',
  'X-Content-Type-Options': 'nosniff',
};
const mangaDexPath = /^\/(?:manga(?:\/[a-f0-9-]{36}(?:\/feed)?)?|at-home\/server\/[a-f0-9-]{36})$/i;
const comick = 'https://comick-source-api.notaspider.dev';
const genericAgent = 'PRAHA-STREAM';

function reply(status, message) {
  return Response.json({ error: message }, { status, headers: cors });
}

function stopWhenIdle(body) {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      let timer;
      try {
        const chunk = await Promise.race([
          reader.read(),
          new Promise((resolve) => { timer = setTimeout(() => resolve({ done: true }), 5000); }),
        ]);
        if (chunk.done) {
          controller.close();
          void reader.cancel().catch(() => {});
        } else {
          controller.enqueue(chunk.value);
        }
      } catch {
        controller.close();
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function relay(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const incoming = new URL(request.url);
  const route = incoming.searchParams.get('route') || '';
  incoming.searchParams.delete('route');
  if (!route && request.method === 'GET') return Response.json({
    status: 'ok', sources: ['mangadex', 'comick', 'moctale'], readingIndexes: Object.keys(readingIndexes),
  }, { headers: cors });
  if (route === '/moctale-meter' && request.method === 'GET') {
    const lookup = moctaleLookup(incoming.searchParams.get('title'), incoming.searchParams.get('year'), incoming.searchParams.get('type'));
    if (!lookup) return reply(400, 'Expected a title, year, and media type.');
    const data = await fetchMoctaleMeter(lookup);
    return Response.json(data, {
      headers: { ...cors, 'Cache-Control': data.state === 'unavailable' ? 'public, s-maxage=30' : 'public, s-maxage=900' },
    });
  }
  const [family, ...parts] = route.replace(/^\//, '').split('/');
  const path = '/' + parts.join('/');
  if (family === 'reading-index' && request.method === 'GET' && parts.length === 1 && Object.hasOwn(readingIndexes, parts[0])) {
    try {
      return Response.json({ repository: parts[0], entries: await fetchReadingIndex(parts[0]) }, {
        headers: { ...cors, 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=3600' },
      });
    } catch {
      return reply(502, 'Could not load the reading repository.');
    }
  }
  let target;
  let body;
  let stream = false;
  let contentType = 'application/json';
  const headers = { 'User-Agent': genericAgent, Accept: contentType };

  if (family === 'mangadex-api' && mangaDexPath.test(path) && request.method === 'GET') {
    target = new URL('https://api.mangadex.org' + path);
    target.search = incoming.search;
  } else if ((route === '/comick-stream' || family === 'comick-api') && request.method === 'POST'
    && (route === '/comick-stream' || path === '/api/search' || path === '/api/chapters')) {
    if (Number(request.headers.get('Content-Length')) > 4096) return reply(413, 'Request body too large.');
    const text = await request.text();
    if (text.length > 4096) return reply(413, 'Request body too large.');
    let data;
    try { data = JSON.parse(text); } catch { return reply(400, 'Expected JSON.'); }
    if (path === '/api/chapters') {
      if (typeof data?.url !== 'string' || !hostedComicPage(data.url)) return reply(400, 'Unsupported comic source.');
      body = JSON.stringify({ url: data.url });
      target = new URL(comick + path);
    } else {
      if (typeof data?.query !== 'string' || !data.query.trim() || data.query.length > 200
        || typeof data.source !== 'string' || !/^[a-z0-9 '\-]{1,64}$/i.test(data.source)) {
        return reply(400, 'Expected a search term and a source name.');
      }
      body = JSON.stringify({ query: data.query, source: data.source });
      target = new URL(comick + '/api/search');
      stream = true;
      contentType = 'application/x-ndjson';
    }
    headers['Content-Type'] = 'application/json';
  } else if (family === 'reading-page' && request.method === 'GET' && parts.length === 1) {
    target = readingPageTarget(parts[0], incoming.searchParams.get('url'));
    if (!target) return reply(400, 'Unsupported reading source URL.');
    headers.Accept = 'text/html';
    headers['User-Agent'] = 'Mozilla/5.0 (compatible; PRAHA-STREAM)';
    contentType = 'text/plain; charset=utf-8';
  } else if (route === '/comick-page' && request.method === 'GET') {
    target = hostedComicPage(incoming.searchParams.get('url'));
    if (!target) return reply(400, 'Unsupported comic source.');
    headers.Accept = 'text/html';
    // The client parses the HTML as text. It must not execute as a relay page.
    contentType = 'text/plain; charset=utf-8';
  } else {
    return reply(404, 'Unsupported relay endpoint.');
  }

  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(stream ? 25_000 : 10_000),
    });
    if (!response.ok) return reply(response.status, 'The upstream source could not serve this request.');
    if (family === 'mangadex-api' && !response.headers.get('Content-Type')?.includes('application/json')) {
      return reply(502, 'MangaDex did not return JSON.');
    }
    return new Response(stream && response.body ? stopWhenIdle(response.body) : response.body, {
      status: response.status,
      headers: {
        ...cors,
        'Content-Type': contentType,
        'Cache-Control': family === 'mangadex-api' && !path.startsWith('/at-home') ? 'public, s-maxage=30' : 'no-store',
      },
    });
  } catch {
    return reply(502, 'Could not reach the upstream source.');
  }
}

export default { fetch: relay };
