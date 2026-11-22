import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from '../data/defaults';

/**
 * The VPN toggle persists a flag *and* drives the native tunnel. A flag that
 * nothing reads is the state `dnsProvider` is in today, so pin the defaults
 * here: a missing resolver or a defaulted-on tunnel would silently change what
 * every user's DNS does on upgrade.
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
