/**
 * Profile PIN crypto (port of Nuvio's ProfilePinCrypto): only a SHA-256 hex
 * digest of the PIN is ever stored — never the PIN itself.
 */
export async function hashPin(pin: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`praha-pin:${pin}`));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
