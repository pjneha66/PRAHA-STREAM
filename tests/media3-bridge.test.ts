// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { media3Available, PrahaMedia3 } from '../services/media3Bridge';

/** The bridge must degrade gracefully in the browser/PWA where no native plugin exists. */
describe('media3Bridge availability', () => {
  afterEach(() => {
    delete (window as any).Capacitor;
  });

  it('is false when the Capacitor native plugin is absent', () => {
    (window as any).Capacitor = undefined;
    expect(media3Available()).toBe(false);
  });

  it('is true only when PrahaMedia3 is registered', () => {
    (window as any).Capacitor = { Plugins: {} };
    expect(media3Available()).toBe(false);
    (window as any).Capacitor = { Plugins: { PrahaMedia3: {} } };
    expect(media3Available()).toBe(true);
  });

  it('still exposes a callable plugin proxy before native is present', () => {
    expect(typeof PrahaMedia3.initialize).toBe('function');
    expect(typeof PrahaMedia3.load).toBe('function');
  });
});
