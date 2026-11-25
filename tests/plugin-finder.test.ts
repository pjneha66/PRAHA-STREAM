// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The finder decides *which* plugins are asked, in what order, and what is kept.
 * All three are behaviour a user feels: a comic plugin asked for a film's links
 * wastes a request, a dead plugin asked first delays every title, and a cached
 * run is what keeps the source list from re-running on every episode.
 *
 * The engine itself is stood in for, so these are about the finder's own
 * decisions rather than about running third-party code.
 */

/** What each plugin id answers. A function means "this plugin". */
const answers = new Map<string, () => Promise<unknown>>();
/** Every plugin id asked, in the order it was asked. */
let asked: string[] = [];

vi.mock('../services/pluginRuntime', () => ({
  runPlugin: async (plugin: { id: string }) => {
    asked.push(plugin.id);
    const answer = answers.get(plugin.id);
    if (!answer) return { raw: [], error: '' };
    return answer();
  },
}));

vi.mock('../services/pluginScripts', () => ({
  composePlugin: async (plugin: unknown) => plugin,
}));

const { clearPluginCache, findPluginStreams, findPluginStreamsEverywhere } = await import('../services/pluginFinder');
type Finder = typeof findPluginStreams;

const URL_A = 'https://raw.example/a/repo.json';
const URL_B = 'https://raw.example/b/repo.json';

function plugin(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    url: `https://raw.example/a/${id}.js`,
    version: '',
    note: '',
    types: ['movie', 'tv'],
    scraper: false,
    vega: false,
    catalogs: [],
    details: false,
    comic: false,
    ...over,
  };
}

function repo(plugins: ReturnType<typeof plugin>[], url = URL_A) {
  return { url, name: 'R', kind: 'repo' as const, plugins };
}

/**
 * A plugin that answers with one link.
 *
 * The stream is in `parsePluginStreams`' shape rather than a bare url: the finder
 * turns each one into a `StreamResult` as it lands, and a stream with no
 * `headers` would throw there — which the finder would rightly read as a plugin
 * that failed.
 */
function streaming(id: string, url = `https://cdn.example/${id}.mp4`) {
  return () => Promise.resolve({
    raw: [{ url, server: id, quality: 'Auto', type: 'file' as const, headers: {} }],
    error: '',
  });
}

const film = { tmdbId: 550, imdbId: 'tt0137523', type: 'movie' as const, isTv: false, title: 'Fight Club' };
const show = { ...film, type: 'tv' as const, isTv: true, season: 1, episode: 1 };

beforeEach(() => {
  answers.clear();
  asked = [];
  clearPluginCache();
});

describe('which plugins are asked', () => {
  it('asks only the plugins that declare this kind', async () => {
    answers.set('film', streaming('film'));
    answers.set('show', streaming('show'));
    await findPluginStreams(repo([
      plugin('film', { types: ['movie'] }),
      plugin('show', { types: ['tv'] }),
    ]), film);
    expect(asked).toEqual(['film']);
  });

  it('never asks a comic plugin, whose "streams" are a chapter\'s pages', async () => {
    answers.set('manga', streaming('manga'));
    await findPluginStreams(repo([plugin('manga', { comic: true })]), film);
    expect(asked).toEqual([]);
  });

  it('asks an ordinary plugin for a film and for a show, since it declared both', async () => {
    answers.set('both', streaming('both'));
    await findPluginStreams(repo([plugin('both')]), film);
    await findPluginStreams(repo([plugin('both')]), show);
    expect(asked).toEqual(['both', 'both']);
  });

  it('asks every non-comic plugin when the title came from one of them', async () => {
    answers.set('a', streaming('a'));
    answers.set('b', streaming('b'));
    answers.set('manga', streaming('manga'));
    await findPluginStreams(repo([
      plugin('a', { types: ['movie'] }),
      plugin('b', { types: ['movie'] }),
      plugin('manga', { comic: true }),
    ]), { ...film, ownId: 'site-id' });
    expect(asked).toEqual(['a', 'b']);
  });

  it('asks only the one plugin for its own title', async () => {
    answers.set('a', streaming('a'));
    answers.set('b', streaming('b'));
    await findPluginStreams(repo([plugin('a'), plugin('b')]), film, { only: 'b' });
    expect(asked).toEqual(['b']);
  });

  it('honours the caller\'s own enablement list', async () => {
    answers.set('on', streaming('on'));
    answers.set('off', streaming('off'));
    await findPluginStreams(repo([plugin('on'), plugin('off')]), film, { enabledIds: ['on'] });
    expect(asked).toEqual(['on']);
  });
});

describe('a plugin that fails', () => {
  it('is asked last next time, and first again once it answers', async () => {
    // `dead` throws; `good` answers. The first run asks them in repository order.
    answers.set('dead', () => Promise.reject(new Error('site gone')));
    answers.set('good', streaming('good'));
    await findPluginStreams(repo([plugin('dead'), plugin('good')]), film);
    expect(asked).toEqual(['dead', 'good']);

    // A different title, so the cached run is not reused: the failure count
    // pushes the dead plugin behind the one that answered.
    asked = [];
    await findPluginStreams(repo([plugin('dead'), plugin('good')]), { ...film, tmdbId: 551 });
    expect(asked).toEqual(['good', 'dead']);
  });

  it('forgets the failure once it answers, rather than punishing it for ever', async () => {
    answers.set('flaky', () => Promise.reject(new Error('down')));
    answers.set('good', streaming('good'));
    await findPluginStreams(repo([plugin('flaky'), plugin('good')]), film);
    await findPluginStreams(repo([plugin('flaky'), plugin('good')]), { ...film, tmdbId: 2 });

    // It works now. The order is sorted before the plugins are asked, so this run
    // still uses the old count; the run after it is the one that shows the reset.
    answers.set('flaky', streaming('flaky'));
    await findPluginStreams(repo([plugin('flaky'), plugin('good')]), { ...film, tmdbId: 3 });

    asked = [];
    await findPluginStreams(repo([plugin('flaky'), plugin('good')]), { ...film, tmdbId: 4 });
    expect(asked[0]).toBe('flaky');
  });

  it('does not count an empty answer as a failure', async () => {
    // A plugin with no link for this title answered — that is not the same as down.
    answers.set('empty', () => Promise.resolve({ raw: [], error: '' }));
    answers.set('good', streaming('good'));
    await findPluginStreams(repo([plugin('empty'), plugin('good')]), film);
    asked = [];
    await findPluginStreams(repo([plugin('empty'), plugin('good')]), { ...film, tmdbId: 2 });
    expect(asked[0]).toBe('empty');
  });

  it('answers with what the others found rather than failing the whole list', async () => {
    answers.set('dead', () => Promise.reject(new Error('down')));
    answers.set('good', streaming('good'));
    const hits = await findPluginStreams(repo([plugin('dead'), plugin('good')]), film);
    expect(hits.map((hit) => hit.plugin.id)).toEqual(['good']);
  });
});

describe('what a run is kept as', () => {
  it('keeps a run that found something, so reopening the list asks nothing again', async () => {
    answers.set('a', streaming('a'));
    await findPluginStreams(repo([plugin('a')]), film);
    expect(asked).toHaveLength(1);
    await findPluginStreams(repo([plugin('a')]), film);
    expect(asked).toHaveLength(1);
  });

  it('does not keep an empty run, so a title asked again really is asked again', async () => {
    answers.set('a', () => Promise.resolve({ raw: [], error: '' }));
    await findPluginStreams(repo([plugin('a')]), film);
    await findPluginStreams(repo([plugin('a')]), film);
    expect(asked).toHaveLength(2);
  });

  it('keeps a film and a show apart, and each episode apart', async () => {
    answers.set('a', streaming('a'));
    await findPluginStreams(repo([plugin('a')]), film);
    await findPluginStreams(repo([plugin('a')]), show);
    await findPluginStreams(repo([plugin('a')]), { ...show, episode: 2 });
    expect(asked).toHaveLength(3);
  });

  it('keeps two repositories apart', async () => {
    answers.set('a', streaming('a'));
    await findPluginStreams(repo([plugin('a')], URL_A), film);
    await findPluginStreams(repo([plugin('a')], URL_B), film);
    expect(asked).toHaveLength(2);
  });

  it('hands a cached run to a late listener as well as to the caller', async () => {
    answers.set('a', streaming('a'));
    const first = await findPluginStreams(repo([plugin('a')]), film);
    const heard: number[] = [];
    const second = await findPluginStreams(repo([plugin('a')]), film, { onSome: (hits) => heard.push(hits.length) });
    expect(second).toHaveLength(first.length);
    expect(heard).toEqual([first.length]);
  });
});

describe('a run as it happens', () => {
  it('publishes each plugin\'s links as they land, in the repository\'s order', async () => {
    answers.set('slow', streaming('slow'));
    answers.set('fast', streaming('fast'));
    const seen: string[][] = [];
    await findPluginStreams(repo([plugin('slow'), plugin('fast')]), film, {
      onSome: (hits) => seen.push(hits.map((hit) => hit.plugin.id)),
    });
    // Every publisher sees the repository's order, never the arrival order.
    for (const order of seen) expect(order === undefined || order[0] === 'slow' || order.length === 1).toBe(true);
    expect(seen[seen.length - 1]).toEqual(['slow', 'fast']);
  });

  it('publishes nothing when nothing was found', async () => {
    answers.set('a', () => Promise.resolve({ raw: [], error: '' }));
    const onSome = vi.fn();
    await findPluginStreams(repo([plugin('a')]), film, { onSome });
    expect(onSome).not.toHaveBeenCalled();
  });

  it('carries the plugin that found each link, and a stable id', async () => {
    answers.set('a', () => Promise.resolve({
      raw: [
        { url: 'https://cdn.example/1.mp4', server: 'A', quality: 'Auto', type: 'file' as const, headers: {} },
        { url: 'https://cdn.example/2.mp4', server: 'A', quality: 'Auto', type: 'file' as const, headers: {} },
      ],
      error: '',
    }));
    const hits = await findPluginStreams(repo([plugin('a')]), film);
    expect(hits.map((hit) => hit.index)).toEqual([0, 1]);
    expect(hits.map((hit) => hit.plugin.id)).toEqual(['a', 'a']);
    expect(hits[0].result.id).toBe('plugin:a:0');
  });
});

describe('findPluginStreamsEverywhere', () => {
  it('asks every repository and answers them all as one list', async () => {
    answers.set('a', streaming('a'));
    answers.set('b', streaming('b'));
    const hits = await findPluginStreamsEverywhere(
      [repo([plugin('a')], URL_A), repo([plugin('b')], URL_B)],
      film,
    );
    expect(hits.map((hit) => hit.plugin.id).sort()).toEqual(['a', 'b']);
  });

  it('answers the ones that worked when one repository fails', async () => {
    answers.set('a', streaming('a'));
    const hits = await findPluginStreamsEverywhere(
      [repo([plugin('a')], URL_A), repo([plugin('dead')], URL_B)],
      film,
    );
    expect(hits.map((hit) => hit.plugin.id)).toEqual(['a']);
  });

  it('publishes a merged list, never only the first repository\'s', async () => {
    answers.set('a', streaming('a'));
    answers.set('b', streaming('b'));
    const seen: string[][] = [];
    await findPluginStreamsEverywhere(
      [repo([plugin('a')], URL_A), repo([plugin('b')], URL_B)],
      film,
      { onSome: (hits) => seen.push(hits.map((hit) => hit.plugin.id).sort()) },
    );
    expect(seen[seen.length - 1]).toEqual(['a', 'b']);
  });

  it('passes the one-plugin and enablement filters through to every repository', async () => {
    answers.set('a', streaming('a'));
    answers.set('b', streaming('b'));
    await findPluginStreamsEverywhere(
      [repo([plugin('a'), plugin('b')], URL_A)],
      film,
      { only: 'a' },
    );
    expect(asked).toEqual(['a']);
  });
});

export type { Finder };
