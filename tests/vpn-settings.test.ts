import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from '../data/defaults';

/**
 * Persist the app resolver and the device DNS tunnel independently.
 */
describe('VPN settings', () => {
  it('starts off with a concrete resolver', () => {
    expect(DEFAULT_SETTINGS.vpnEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.vpnDnsServer).toBe('1.1.1.1');
  });

  it('keeps a saved resolver and toggle choice on upgrade', () => {
    const restored = normalizeSettings({ vpnEnabled: true, vpnDnsServer: '9.9.9.9' });
    expect(restored.vpnEnabled).toBe(true);
    expect(restored.vpnDnsServer).toBe('9.9.9.9');
  });

  it('fills the resolver for saves that predate the toggle', () => {
    const restored = normalizeSettings({ nsfw: 'off' });
    expect(restored.vpnEnabled).toBe(false);
    expect(restored.vpnDnsServer).toBe('1.1.1.1');
  });
});

describe('App DNS settings', () => {
  it('defaults to system DNS and preserves a supported encrypted resolver', () => {
    expect(DEFAULT_SETTINGS.dnsProvider).toBe('system');
    expect(normalizeSettings({ dnsProvider: 'cloudflare', dnsFallback: false }))
      .toMatchObject({ dnsProvider: 'cloudflare', dnsFallback: false });
  });

  it('restores the system resolver for settings written before the provider was wired', () => {
    expect(normalizeSettings({ dnsProvider: 'dnswatch' }).dnsProvider).toBe('system');
  });
});
