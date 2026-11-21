import { describe, expect, it } from 'vitest';
import {
  adultOnly,
  allowsAdult,
  anilistAdultFilter,
  currentAllowsAdult,
  currentNsfwMode,
  currentWeebCentralAdultParam,
  effectiveNsfwMode,
  filterChannelsForNsfw,
  isAdultChannelName,
  setNsfwContext,
  tmdbIncludeAdult,
  weebCentralAdultParam,
} from '../services/nsfwGate';
import { normalizeSettings } from '../data/defaults';

const kids = { isKids: true };
const grownUp = { isKids: false };

describe('nsfw gate — modes', () => {
  it('defaults to off', () => {
    expect(normalizeSettings({}).nsfw).toBe('off');
    expect(normalizeSettings(null).nsfw).toBe('off');
  });

  it('rejects an unknown saved mode and falls back to off', () => {
    expect(normalizeSettings({ nsfw: 'yes' as never }).nsfw).toBe('off');
    expect(normalizeSettings({ nsfw: 'bogus' as never }).nsfw).toBe('off');
  });

  it('keeps a valid saved mode', () => {
    expect(normalizeSettings({ nsfw: 'on' }).nsfw).toBe('on');
    expect(normalizeSettings({ nsfw: 'only' }).nsfw).toBe('only');
  });

  it('turns adult off for every mode except off itself', () => {
    expect(allowsAdult({ nsfw: 'off' }, grownUp)).toBe(false);
    expect(allowsAdult({ nsfw: 'on' }, grownUp)).toBe(true);
    expect(allowsAdult({ nsfw: 'only' }, grownUp)).toBe(true);
  });

  it('flags only-mode on its own', () => {
    expect(adultOnly({ nsfw: 'only' }, grownUp)).toBe(true);
    expect(adultOnly({ nsfw: 'on' }, grownUp)).toBe(false);
    expect(adultOnly({ nsfw: 'off' }, grownUp)).toBe(false);
  });

  it('treats a missing mode as off', () => {
    expect(effectiveNsfwMode({} as never, grownUp)).toBe('off');
  });
});

describe('nsfw gate — Kids profiles', () => {
  it('forces off no matter what is saved', () => {
    for (const mode of ['off', 'on', 'only'] as const) {
      expect(effectiveNsfwMode({ nsfw: mode }, kids)).toBe('off');
      expect(allowsAdult({ nsfw: mode }, kids)).toBe(false);
      expect(adultOnly({ nsfw: mode }, kids)).toBe(false);
      expect(tmdbIncludeAdult({ nsfw: mode }, kids)).toBe(false);
      expect(anilistAdultFilter({ nsfw: mode }, kids)).toBe('hide');
    }
  });

  it('forces off when no profile is given but the flag is explicitly kids', () => {
    expect(effectiveNsfwMode({ nsfw: 'only' }, { isKids: true })).toBe('off');
  });
});

describe('nsfw gate — provider parameter mapping', () => {
  it('capitalises WeebCentral values, because lowercase returns 307', () => {
    expect(weebCentralAdultParam('off')).toBe('False');
    expect(weebCentralAdultParam('on')).toBe('Any');
    expect(weebCentralAdultParam('only')).toBe('Only');
  });

  it('maps AniList to its own enum names', () => {
    expect(anilistAdultFilter({ nsfw: 'off' }, grownUp)).toBe('hide');
    expect(anilistAdultFilter({ nsfw: 'on' }, grownUp)).toBe('include');
    expect(anilistAdultFilter({ nsfw: 'only' }, grownUp)).toBe('only');
  });

  it('collapses Only into a plain boolean for TMDB', () => {
    expect(tmdbIncludeAdult({ nsfw: 'only' }, grownUp)).toBe(true);
  });
});

describe('nsfw gate — Live TV channel filtering', () => {
  const channels = [
    { group: 'News', name: 'BBC World' },
    { group: 'Movies', name: 'Action Max' },
    { group: 'Adult', name: 'XXX Premium' },
    { group: 'Late', name: '18+ Nights' },
    { group: 'Sport', name: 'Eurosport' },
  ];

  it('recognises obvious adult names', () => {
    expect(isAdultChannelName('Adult', 'XXX Premium')).toBe(true);
    expect(isAdultChannelName('Late', '18+ Nights')).toBe(true);
    expect(isAdultChannelName('News', 'BBC World')).toBe(false);
    expect(isAdultChannelName(undefined, 'Porn TV')).toBe(true);
  });

  it('strips adult channels when off', () => {
    const kept = filterChannelsForNsfw(channels, { nsfw: 'off' });
    expect(kept.map((c) => c.name)).toEqual(['BBC World', 'Action Max', 'Eurosport']);
  });

  it('keeps everything when on', () => {
    expect(filterChannelsForNsfw(channels, { nsfw: 'on' })).toHaveLength(channels.length);
  });

  it('keeps only adult channels when only', () => {
    const kept = filterChannelsForNsfw(channels, { nsfw: 'only' });
    expect(kept.map((c) => c.name)).toEqual(['XXX Premium', '18+ Nights']);
  });

  it('ignores the saved mode on a kids profile', () => {
    const kept = filterChannelsForNsfw(channels, { nsfw: 'only' }, kids);
    expect(kept.map((c) => c.name)).toEqual(['BBC World', 'Action Max', 'Eurosport']);
  });
});

describe('nsfw gate — runtime context', () => {
  it('defaults to off before anything is pushed in', () => {
    expect(currentNsfwMode()).toBe('off');
    expect(currentAllowsAdult()).toBe(false);
    expect(currentWeebCentralAdultParam()).toBe('False');
  });

  it('follows the pushed setting', () => {
    setNsfwContext({ nsfw: 'only' }, grownUp);
    expect(currentNsfwMode()).toBe('only');
    expect(currentAllowsAdult()).toBe(true);
    expect(currentWeebCentralAdultParam()).toBe('Only');
  });

  it('is overridden back to off by a kids profile', () => {
    setNsfwContext({ nsfw: 'on' }, kids);
    expect(currentNsfwMode()).toBe('off');
    expect(currentWeebCentralAdultParam()).toBe('False');
    setNsfwContext({ nsfw: 'off' }, grownUp); // leave the shared state clean
  });
});
