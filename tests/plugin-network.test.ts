// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertPublicHttpUrl,
  BlockedAddressError,
  isLocalHostname,
  isPublicHttpUrl,
} from '../services/pluginNetwork';
import { pluginCanFetch, pluginFetch } from '../services/pluginTransport';

/**
 * A plugin is third-party JavaScript from a repository the user pasted. It gets
 * `http()` and nothing else, and this is the wall around `http()`: only public
 * http(s), checked on the address actually opened, on every redirect hop.
 *
 * These tests are the acceptance condition for that wall, so they cover the
 * addresses that matter — the router, the app's own TorrServer, and the cloud
 * metadata endpoint — rather than a happy path.
 */

describe('the host guard — what is allowed', () => {
  it('allows ordinary public http and https addresses', () => {
    expect(assertPublicHttpUrl('https://example.com/a/b?c=d').hostname).toBe('example.com');
    expect(assertPublicHttpUrl('http://example.com').protocol).toBe('http:');
    expect(assertPublicHttpUrl('https://sub.example.co.uk:8443/x').port).toBe('8443');
  });

  it('allows public IP literals just outside the reserved ranges', () => {
    // 172.32 is one past 172.16/12's end; 100.128 one past 100.64/10's.
    for (const host of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '192.169.0.1', '11.0.0.1']) {
      expect(isPublicHttpUrl(`http://${host}/`), host).toBe(true);
    }
  });

  it('allows a public IPv6 literal', () => {
    expect(isPublicHttpUrl('http://[2001:4860:4860::8888]/')).toBe(true);
  });
});

describe('the host guard — what is refused', () => {
  it('refuses every protocol but http and https', () => {
    for (const url of ['ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,hi', 'ws://example.com/']) {
      expect(isPublicHttpUrl(url), url).toBe(false);
    }
    expect(() => assertPublicHttpUrl('file:///etc/passwd')).toThrow(BlockedAddressError);
  });

  it('refuses this device and its own names', () => {
    for (const url of [
      'http://localhost/',
      'http://localhost:8090/',
      'http://api.localhost/',
      'http://127.0.0.1/',
      'http://127.1.2.3/',
      'http://0.0.0.0/',
      'http://[::1]/',
      'http://[::]/',
    ]) {
      expect(isPublicHttpUrl(url), url).toBe(false);
    }
  });

  it('refuses the private IPv4 ranges', () => {
    for (const url of [
      'http://10.0.0.1/',
      'http://192.168.1.1/',        // the router's admin page
      'http://172.16.0.1/',
      'http://172.31.255.254/',
      'http://100.64.0.1/',         // CGNAT
      'http://169.254.169.254/',    // cloud metadata
      'http://224.0.0.1/',          // multicast
      'http://255.255.255.255/',    // broadcast
    ]) {
      expect(isPublicHttpUrl(url), url).toBe(false);
    }
  });

  it('refuses an IPv4 address wrapped in IPv6, in either spelling', () => {
    for (const url of [
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:192.168.1.1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://[0:0:0:0:0:ffff:c0a8:0101]/',
    ]) {
      expect(isPublicHttpUrl(url), url).toBe(false);
    }
  });

  it('refuses the private IPv6 ranges', () => {
    for (const url of [
      'http://[fc00::1]/',   // unique-local
      'http://[fd12:3456::1]/',
      'http://[fe80::1]/',   // link-local
      'http://[ff02::1]/',   // multicast
    ]) {
      expect(isPublicHttpUrl(url), url).toBe(false);
    }
  });

  it('refuses the names that resolve inside a network', () => {
    for (const host of ['printer.local', 'torrserver.internal', 'nas.home.arpa', 'LOCALHOST', 'localhost.']) {
      expect(isLocalHostname(host), host).toBe(true);
    }
  });

  it('refuses text that is not an address at all', () => {
    expect(isPublicHttpUrl('not a url')).toBe(false);
    expect(isPublicHttpUrl('')).toBe(false);
    expect(isLocalHostname('')).toBe(true);
  });

  it('answers a refusal with a message the plugin can be shown', () => {
    try {
      assertPublicHttpUrl('http://192.168.1.1/');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BlockedAddressError);
      expect((error as Error).message).toMatch(/your own network/i);
    }
  });

  it('`pluginCanFetch` answers without opening anything', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(pluginCanFetch('https://example.com/')).toBe(true);
    expect(pluginCanFetch('http://127.0.0.1:8090/')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── the transport: one hop at a time, the guard on each ──

interface Hop {
  status: number;
  location?: string;
  body?: string;
}

/** A `fetch` that answers the scripted hops and records what it was asked for. */
function scriptFetch(hops: Record<string, Hop>): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    asked.push(url);
    const hop = hops[url];
    if (!hop) return new Response('not found', { status: 404 });
    const headers = new Headers();
    if (hop.location) headers.set('location', hop.location);
    return new Response(hop.body ?? '', { status: hop.status, headers });
  }));
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pluginFetch — redirects', () => {
  it('follows a public redirect and reports the final address', async () => {
    const asked = scriptFetch({
      'https://public.example/start': { status: 302, location: 'https://public.example/end' },
      'https://public.example/end': { status: 200, body: 'hello' },
    });
    const answer = await pluginFetch('https://public.example/start');
    expect(answer.status).toBe(200);
    expect(answer.text).toBe('hello');
    expect(answer.url).toBe('https://public.example/end');
    expect(asked).toEqual(['https://public.example/start', 'https://public.example/end']);
  });

  it('refuses a redirect into the local network, before opening it', async () => {
    const asked = scriptFetch({
      'https://public.example/start': { status: 302, location: 'http://192.168.1.1/admin' },
    });
    const answer = await pluginFetch('https://public.example/start');
    expect(answer.status).toBe(0);
    expect(answer.error).toMatch(/your own network/i);
    // The whole point: the private address was never opened.
    expect(asked).toEqual(['https://public.example/start']);
  });

  it('refuses a redirect to the app\'s own TorrServer on loopback', async () => {
    const asked = scriptFetch({
      'https://public.example/start': { status: 307, location: 'http://127.0.0.1:8090/api' },
    });
    const answer = await pluginFetch('https://public.example/start');
    expect(answer.status).toBe(0);
    expect(asked).toHaveLength(1);
  });

  it('refuses a chain that only turns private on the second hop', async () => {
    const asked = scriptFetch({
      'https://public.example/a': { status: 302, location: 'https://public.example/b' },
      'https://public.example/b': { status: 302, location: 'http://[::ffff:169.254.169.254]/' },
    });
    const answer = await pluginFetch('https://public.example/a');
    expect(answer.status).toBe(0);
    expect(asked).toEqual(['https://public.example/a', 'https://public.example/b']);
  });

  it('resolves a relative Location against the address it came from', async () => {
    const asked = scriptFetch({
      'https://public.example/dir/start': { status: 301, location: '/elsewhere' },
      'https://public.example/elsewhere': { status: 200, body: 'moved' },
    });
    const answer = await pluginFetch('https://public.example/dir/start');
    expect(answer.status).toBe(200);
    expect(answer.url).toBe('https://public.example/elsewhere');
    expect(asked[1]).toBe('https://public.example/elsewhere');
  });

  it('gives up rather than looping for ever', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      asked.push(String(input));
      const headers = new Headers({ location: 'https://public.example/again' });
      return new Response('', { status: 302, headers });
    }));
    const answer = await pluginFetch('https://public.example/again');
    expect(answer.status).toBe(0);
    expect(answer.error).toMatch(/too many redirects/i);
    expect(asked.length).toBeLessThanOrEqual(7);
  });

  it('turns a 303 into a GET with no body, and keeps the verb on a 307', async () => {
    const seen: Array<{ url: string; method?: string; body?: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, method: init?.method, body: (init?.body as string | undefined) ?? null });
      if (url.endsWith('-start')) {
        return new Response('', { status: url.includes('307') ? 307 : 303, headers: new Headers({ location: 'https://public.example/end' }) });
      }
      return new Response('ok', { status: 200 });
    }));

    await pluginFetch('https://public.example/303-start', { method: 'POST', body: 'payload' });
    expect(seen[1]).toMatchObject({ method: 'GET', body: null });

    seen.length = 0;
    await pluginFetch('https://public.example/307-start', { method: 'POST', body: 'payload' });
    expect(seen[1]).toMatchObject({ method: 'POST', body: 'payload' });
  });

  it('reports an unseen redirect rather than guessing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      type: 'opaqueredirect',
      status: 0,
      headers: new Headers(),
      text: async () => '',
    } as unknown as Response)));
    const answer = await pluginFetch('https://public.example/');
    expect(answer.status).toBe(0);
    expect(answer.error).toMatch(/redirect/i);
  });

  it('never throws — a plugin gets an answer, not an exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network down');
    }));
    const answer = await pluginFetch('https://public.example/');
    expect(answer.status).toBe(0);
    expect(answer.error).toMatch(/network down/);
  });

  it('refuses a non-http scheme before any request', async () => {
    const asked = scriptFetch({});
    const answer = await pluginFetch('ftp://example.com/file');
    expect(answer.status).toBe(0);
    expect(asked).toEqual([]);
  });
});
