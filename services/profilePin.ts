/**
 * Profile PIN crypto (port of Nuvio's ProfilePinCrypto, hardened).
 *
 * Only a derived value is ever stored — never the PIN itself.
 *
 * The original scheme was a single SHA-256 of `praha-pin:<pin>`. A profile PIN
 * is 4–8 digits, so that digest space is at most ten million values: an attacker
 * who reads the stored hash off the device can recover the PIN by brute force in
 * seconds on a laptop, and a rainbow table makes it instant. Key stretching is
 * what makes that search expensive instead, so new PINs use PBKDF2-HMAC-SHA-256
 * with a per-PIN random salt.
 *
 * `verifyPin` still accepts the old digest so existing profiles keep unlocking;
 * the caller re-hashes to the new format on a successful legacy unlock, so the
 * old value is replaced the first time the user enters the PIN.
 */

/** PBKDF2 work factor for newly set PINs. OWASP's floor for PBKDF2-SHA-256. */
const PBKDF2_ITERATIONS = 210_000;

/** Prefix that identifies a stored value as PBKDF2, not the legacy digest. */
const PBKDF2_PREFIX = 'pbkdf2$';

/** The old scheme's input prefix, kept only to verify existing hashes. */
const LEGACY_SALT_PREFIX = 'praha-pin:';

const SALT_BYTES = 16;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Rebuilds a byte array from lowercase hex; invalid input yields null. */
function fromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  // The PIN is the password and the random salt is the salt, which is exactly
  // PBKDF2's contract. 256 bits out is one SHA-256 block, so the stored hex
  // stays 64 characters whatever the iteration count.
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

/** Legacy digest, retained only to verify PINs set before this change. */
async function legacyHash(pin: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${LEGACY_SALT_PREFIX}${pin}`));
  return toHex(new Uint8Array(digest));
}

/**
 * Hashes a PIN for storage.
 *
 * Returns `pbkdf2$<iterations>$<saltHex>$<hashHex>`. The iteration count travels
 * with the value so a future increase does not invalidate existing PINs.
 */
export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(pin, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_PREFIX}${PBKDF2_ITERATIONS}$${toHex(salt)}$${hash}`;
}

/** True when a stored value uses the stretched format rather than the legacy digest. */
export function isPbkdf2Hash(stored: string | undefined): boolean {
  return Boolean(stored && stored.startsWith(PBKDF2_PREFIX));
}

/**
 * Compares two equal-length hex strings without an early exit.
 *
 * A plain `===` on strings short-circuits on the first differing byte. That
 * leaks how much of the digest matched through timing, which for a value the
 * attacker already knows the target of is exactly the bit they need. The cost
 * is negligible and the write is one loop.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Checks a PIN against a stored value, accepting both formats.
 *
 * Returns true when it matches. A malformed stored value returns false instead
 * of throwing, so a corrupted profile cannot lock the app in the PIN screen.
 */
export async function verifyPin(pin: string, stored: string | undefined): Promise<boolean> {
  if (!stored) return false;

  if (!stored.startsWith(PBKDF2_PREFIX)) {
    // Legacy: single SHA-256 of the salted PIN.
    return timingSafeEqualHex(await legacyHash(pin), stored);
  }

  const parts = stored.split('$');
  // pbkdf2 $ iterations $ salt $ hash
  if (parts.length !== 4) return false;
  const iterations = Number.parseInt(parts[1], 10);
  const salt = fromHex(parts[2]);
  const expected = parts[3];
  if (!Number.isFinite(iterations) || iterations <= 0 || !salt || !expected) return false;

  return timingSafeEqualHex(await derive(pin, salt, iterations), expected);
}
