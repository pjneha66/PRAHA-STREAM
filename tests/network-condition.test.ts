import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeFetchText } from '../services/androidBridge';
import { probeNetworkCondition } from '../services/networkCondition';

vi.mock('../services/androidBridge', () => ({ nativeFetchText: vi.fn() }));
const fetchText = vi.mocked(nativeFetchText);
const response = (status: number, data = '') => ({ status, data, ok: status >= 200 && status < 300 });

afterEach(() => fetchText.mockReset());

describe('Check network', () => {
  it('recognizes a real catalog response and refreshes stale results on request', async () => {
    fetchText.mockResolvedValue(response(401, '{"status_code":7}'));
    expect(await probeNetworkCondition({ fresh: true })).toBe('online');

    fetchText.mockResolvedValue(response(403, '<html>Blocked</html>'));
    expect(await probeNetworkCondition()).toBe('online');
    expect(await probeNetworkCondition({ fresh: true })).toBe('network-unverified');
  });

  it('distinguishes a working internet connection from blocked catalogs', async () => {
    fetchText.mockImplementation(async (url) =>
      url.includes('gstatic.com') ? response(204) : response(200, '<html>Captive portal</html>'));
    expect(await probeNetworkCondition({ fresh: true })).toBe('servers-unreachable');
  });
});
