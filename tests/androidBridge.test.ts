// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nativeFetchText, getCachedProxyPort, hasNativeHeaderProxy } from '../services/androidBridge';

describe('AndroidBridge nativeFetchText', () => {
  const originalPrahaNative = (window as any).PrahaNative;
  const originalCallback = (window as any).__prahaNativeHttpCallback;

  beforeEach(() => {
    delete (window as any).PrahaNative;
    delete (window as any).__prahaNativeHttpCallback;
  });

  afterEach(() => {
    (window as any).PrahaNative = originalPrahaNative;
    (window as any).__prahaNativeHttpCallback = originalCallback;
  });

  it('uses async bridge httpRequestAsync when available and delivers response via callback', async () => {
    let capturedReqId = '';
    let capturedUrl = '';
    let capturedMethod = '';

    (window as any).PrahaNative = {
      isAndroid: () => true,
      httpRequestAsync: vi.fn((reqId: string, url: string, method: string) => {
        capturedReqId = reqId;
        capturedUrl = url;
        capturedMethod = method;

        // Simulate native thread callback
        setTimeout(() => {
          if ((window as any).__prahaNativeHttpCallback) {
            (window as any).__prahaNativeHttpCallback(
              reqId,
              JSON.stringify({ ok: true, status: 200, body: '{"success":true}' }),
            );
          }
        }, 10);
      }),
    };

    const result = await nativeFetchText('https://example.com/api', {
      headers: { 'User-Agent': 'Custom-UA' },
      timeoutMs: 5000,
    });

    expect(capturedUrl).toBe('https://example.com/api');
    expect(capturedMethod).toBe('GET');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data).toBe('{"success":true}');
  });

  it('falls back to synchronous httpRequest when httpRequestAsync is not available', async () => {
    (window as any).PrahaNative = {
      isAndroid: () => true,
      httpRequest: vi.fn(() => JSON.stringify({ ok: true, status: 200, body: 'sync-data' })),
    };

    const result = await nativeFetchText('https://example.com/api', {
      headers: { 'User-Agent': 'Custom-UA' },
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data).toBe('sync-data');
  });

  it('caches native proxy port', () => {
    (window as any).PrahaNative = {
      isAndroid: () => true,
      getProxyPort: vi.fn().mockReturnValueOnce(9999).mockReturnValueOnce(8888),
    };

    expect(getCachedProxyPort()).toBe(9999);
    // Cached check
    expect(getCachedProxyPort()).toBe(9999);
    expect(hasNativeHeaderProxy()).toBe(true);
  });
});
