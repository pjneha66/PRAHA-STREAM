import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PLAYER_ENGINE,
  PLAYER_ENGINE_ORDER,
  fallbackNotice,
  nextEngineInChain,
  normalizePlayerEngine,
  playerEngineLabel,
  resolveEngineChain,
} from '../services/playerSelection';
import { DEFAULT_PLAYER_SETTINGS, normalizeSettings } from '../data/defaults';

/**
 * The player contract: mpv first on Android, then Media3, then the web player,
 * and the web build never loses its own player.
 *
 * These are the rules the hook relies on when it builds a chain and advances
 * through it, so they are asserted in isolation instead of through a rendered
 * video element (which jsdom cannot decode anyway).
 */
describe('player engine order', () => {
  it('is mpv → Media3 → web, and mpv is the default', () => {
    expect(PLAYER_ENGINE_ORDER).toEqual(['mpv', 'media3', 'web']);
    expect(DEFAULT_PLAYER_ENGINE).toBe('mpv');
    expect(DEFAULT_PLAYER_SETTINGS.playerEngine).toBe('mpv');
  });

  it('coerces anything unrecognised to mpv, so existing installs get it', () => {
    expect(normalizePlayerEngine(undefined)).toBe('mpv');
    expect(normalizePlayerEngine(null)).toBe('mpv');
    expect(normalizePlayerEngine('')).toBe('mpv');
    expect(normalizePlayerEngine('vlc')).toBe('mpv');
    expect(normalizePlayerEngine(42)).toBe('mpv');
  });

  it('keeps an explicit choice instead of overwriting it', () => {
    expect(normalizePlayerEngine('media3')).toBe('media3');
    expect(normalizePlayerEngine('web')).toBe('web');
  });
});

describe('resolveEngineChain', () => {
  const both = { mpv: true, media3: true };

  it('starts at mpv and ends at web when both plugins are installed', () => {
    expect(resolveEngineChain({ preferred: 'mpv', availability: both })).toEqual(['mpv', 'media3', 'web']);
  });

  it('starts at the explicit preference, in fixed order', () => {
    expect(resolveEngineChain({ preferred: 'media3', availability: both })).toEqual(['media3', 'web']);
    expect(resolveEngineChain({ preferred: 'web', availability: both })).toEqual(['web']);
  });

  it('skips an engine the build cannot run but keeps the ones after it', () => {
    expect(resolveEngineChain({ preferred: 'mpv', availability: { mpv: false, media3: true } }))
      .toEqual(['media3', 'web']);
    expect(resolveEngineChain({ preferred: 'mpv', availability: { mpv: true, media3: false } }))
      .toEqual(['mpv', 'web']);
  });

  it('collapses to the web player when no native plugin is present', () => {
    expect(resolveEngineChain({ preferred: 'mpv', availability: { mpv: false, media3: false } }))
      .toEqual(['web']);
  });

  it('never returns an empty chain', () => {
    for (const preferred of ['mpv', 'media3', 'web', 'nonsense'] as const) {
      expect(resolveEngineChain({ preferred, availability: { mpv: false, media3: false } })).toEqual(['web']);
    }
  });

  it('skips native entirely for blob/P2P streams and for the web host', () => {
    expect(resolveEngineChain({ preferred: 'mpv', forceWeb: true, availability: both })).toEqual(['web']);
    expect(resolveEngineChain({ preferred: 'mpv', host: 'web', availability: both })).toEqual(['web']);
  });

  it('treats a stale stored preference as mpv', () => {
    expect(resolveEngineChain({ preferred: 'libvlc', availability: both })).toEqual(['mpv', 'media3', 'web']);
  });
});

describe('nextEngineInChain — the fallback step', () => {
  const chain = ['mpv', 'media3', 'web'] as const;

  it('advances one engine at a time, in order', () => {
    expect(nextEngineInChain(chain, 'mpv')).toBe('media3');
    expect(nextEngineInChain(chain, 'media3')).toBe('web');
  });

  it('reports null once the chain is spent instead of looping', () => {
    expect(nextEngineInChain(chain, 'web')).toBeNull();
    expect(nextEngineInChain(['web'], 'web')).toBeNull();
  });

  it('does not resurrect an engine that was skipped', () => {
    expect(nextEngineInChain(['mpv', 'web'], 'mpv')).toBe('web');
    expect(nextEngineInChain(['media3', 'web'], 'media3')).toBe('web');
  });

  it('returns null for an engine that is not in this chain', () => {
    expect(nextEngineInChain(['media3', 'web'], 'mpv')).toBeNull();
  });
});

describe('fallback messaging', () => {
  it('names both engines and says playback continued', () => {
    expect(fallbackNotice('mpv', 'media3'))
      .toBe('mpv could not play this stream — switched to Media3 (ExoPlayer).');
    expect(fallbackNotice('media3', 'web'))
      .toBe('Media3 (ExoPlayer) could not play this stream — switched to Web player.');
  });

  it('labels every engine for the settings dropdown', () => {
    expect(playerEngineLabel('mpv')).toBe('mpv');
    expect(playerEngineLabel('media3')).toBe('Media3 (ExoPlayer)');
    expect(playerEngineLabel('web')).toBe('Web player');
  });
});

describe('settings normalisation', () => {
  it('gives an install with no player block the mpv default', () => {
    const settings = normalizeSettings({});
    expect(settings.player.playerEngine).toBe('mpv');
  });

  it('leaves an explicit engine alone while filling the rest of the block', () => {
    const settings = normalizeSettings({ player: { playerEngine: 'web' } as never });
    expect(settings.player.playerEngine).toBe('web');
    // The merge still supplies the other player fields from the defaults.
    expect(settings.player.seekStep).toBe(DEFAULT_PLAYER_SETTINGS.seekStep);
  });

  it('repairs a corrupt stored engine', () => {
    const settings = normalizeSettings({ player: { playerEngine: 'vlc' } as never });
    expect(settings.player.playerEngine).toBe('mpv');
  });
});
