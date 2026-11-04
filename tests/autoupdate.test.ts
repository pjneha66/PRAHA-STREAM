// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isNewerVersion } from '../services/autoUpdateService';

describe('AutoUpdateService', () => {
  it('correctly compares semantic versions', () => {
    // Greater major
    expect(isNewerVersion('2.4.0', '3.0.0')).toBe(true);
    expect(isNewerVersion('v2.4.0', 'v3.0.0')).toBe(true);

    // Greater minor
    expect(isNewerVersion('2.4.0', '2.5.0')).toBe(true);
    expect(isNewerVersion('v2.4.0', 'v2.5.0')).toBe(true);
    expect(isNewerVersion('2.4.2', '2.5.0')).toBe(true);

    // Greater patch
    expect(isNewerVersion('2.4.0', '2.4.1')).toBe(true);
    expect(isNewerVersion('v2.4.0', 'v2.4.2')).toBe(true);

    // Equal versions
    expect(isNewerVersion('2.4.0', '2.4.0')).toBe(false);
    expect(isNewerVersion('v2.4.0', '2.4.0')).toBe(false);
    expect(isNewerVersion('2.5.0', 'v2.5.0')).toBe(false);

    // Older versions
    expect(isNewerVersion('2.5.0', '2.4.0')).toBe(false);
    expect(isNewerVersion('v2.5.0', 'v2.4.9')).toBe(false);
    expect(isNewerVersion('3.0.0', '2.9.9')).toBe(false);
  });
});
