/**
 * Clipboard writes that never throw.
 *
 * `navigator.clipboard` is undefined outside a secure context and `writeText`
 * rejects when the document is not focused or the permission is denied — both
 * are ordinary inside a Capacitor WebView. Call sites used to `await` the write
 * straight from an onClick, so the rejected promise was never handled and the
 * button simply did nothing. This returns a boolean instead of rejecting.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path: permission denied or no secure context.
  }
  const area = document.createElement('textarea');
  try {
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    // `execCommand` can throw (some WebViews refuse it outright), so the node is
    // removed here rather than after the call. An appended textarea left behind
    // would leak one invisible element per failed copy.
    area.remove();
  }
}
