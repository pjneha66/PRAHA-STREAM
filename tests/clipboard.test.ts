// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../services/clipboard';

/**
 * Clipboard writes must resolve to a boolean and never reject.
 *
 * Both call sites await this straight from an onClick, so a throw here is an
 * unhandled rejection and a button that visibly does nothing — which is exactly
 * the bug this helper exists to remove.
 */
describe('copyText', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('uses the async clipboard API when it is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    await expect(copyText('magnet:?xt=urn:btih:abc')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('magnet:?xt=urn:btih:abc');
  });

  it('falls back to execCommand when the clipboard API rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('not focused'));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });

    await expect(copyText('https://example.com/stream')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    // The temporary textarea must not be left in the document.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back when there is no clipboard API at all (insecure context)', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });

    await expect(copyText('text')).resolves.toBe(true);
    expect(exec).toHaveBeenCalled();
  });

  it('reports false instead of rejecting when every path fails', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => { throw new Error('blocked'); },
    });

    await expect(copyText('text')).resolves.toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('reports false when the legacy copy command returns false', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });

    await expect(copyText('text')).resolves.toBe(false);
  });
});
