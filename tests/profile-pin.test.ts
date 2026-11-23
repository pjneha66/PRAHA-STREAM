import { describe, expect, it } from 'vitest';
import { hashPin, isPbkdf2Hash, verifyPin } from '../services/profilePin';

/**
 * Profile PIN storage.
 *
 * A profile PIN is 4–8 digits, so the stored value is the only thing standing
 * between a device thief and the profile. These tests pin the format (so a
 * future refactor cannot quietly go back to a bare SHA-256) and both halves of
 * the migration: old digests still verify, new ones are stretched and salted.
 */
describe('profilePin', () => {
  it('stores a salted PBKDF2 hash with its iteration count', async () => {
    const stored = await hashPin('1234');
    expect(stored.startsWith('pbkdf2$')).toBe(true);
    const [, iterations, salt, digest] = stored.split('$');
    expect(Number(iterations)).toBeGreaterThanOrEqual(210_000);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);   // 16 random bytes
    expect(digest).toMatch(/^[0-9a-f]{64}$/); // 256 bits out
    expect(isPbkdf2Hash(stored)).toBe(true);
  });

  it('never stores the PIN itself', async () => {
    const stored = await hashPin('482913');
    expect(stored).not.toContain('482913');
  });

  it('salts every hash, so the same PIN yields a different stored value', async () => {
    const [a, b] = await Promise.all([hashPin('1111'), hashPin('1111')]);
    expect(a).not.toBe(b);
    // Both still verify.
    await expect(verifyPin('1111', a)).resolves.toBe(true);
    await expect(verifyPin('1111', b)).resolves.toBe(true);
  });

  it('accepts the right PIN and rejects a wrong one', async () => {
    const stored = await hashPin('2024');
    await expect(verifyPin('2024', stored)).resolves.toBe(true);
    await expect(verifyPin('2025', stored)).resolves.toBe(false);
    await expect(verifyPin('', stored)).resolves.toBe(false);
  });

  it('still verifies a legacy salted-SHA-256 digest so existing profiles unlock', async () => {
    // SHA-256("praha-pin:1234"), which is exactly what the old scheme stored.
    const legacy = 'e4e6340bd035d6f6cc71fee5497003c2d56318262da3072b91d6b2b32b210343';
    expect(isPbkdf2Hash(legacy)).toBe(false);
    await expect(verifyPin('1234', legacy)).resolves.toBe(true);
    await expect(verifyPin('1235', legacy)).resolves.toBe(false);
    await expect(verifyPin('1234', undefined)).resolves.toBe(false);
  });

  it('returns false instead of throwing on a malformed stored value', async () => {
    await expect(verifyPin('1234', 'pbkdf2$')).resolves.toBe(false);
    await expect(verifyPin('1234', 'pbkdf2$notanumber$zz$zz')).resolves.toBe(false);
    await expect(verifyPin('1234', 'pbkdf2$1000$abcd$abcd')).resolves.toBe(false);
    await expect(verifyPin('1234', '')).resolves.toBe(false);
  });

  it('honours the iteration count stored with the value, not a hardcoded one', async () => {
    // The count travels with the value, so a future increase must not strand
    // existing PINs. A hash written with a lower count still verifies against
    // its own digest.
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltHex = Array.from(salt).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('6789'), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 1000, hash: 'SHA-256' }, key, 256);
    const digest = Array.from(new Uint8Array(bits)).map((byte) => byte.toString(16).padStart(2, '0')).join('');

    await expect(verifyPin('6789', `pbkdf2$1000$${saltHex}$${digest}`)).resolves.toBe(true);
    await expect(verifyPin('6790', `pbkdf2$1000$${saltHex}$${digest}`)).resolves.toBe(false);
    // The same digest under a different claimed count is a different derivation.
    await expect(verifyPin('6789', `pbkdf2$210000$${saltHex}$${digest}`)).resolves.toBe(false);
  });
});
