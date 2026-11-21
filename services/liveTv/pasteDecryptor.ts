// PasteShDecryptor — AES-256-CBC paste.sh blob decoder.
//
// Ported from VyseTV `lib/services/iptv/pastesh_decryptor.dart`
// (GPL-3.0-or-later). paste.sh stores `Salted__` + 8-byte salt + ciphertext as
// base64; key/IV come from `id + serverkey + clientkey + "https://paste.sh"` via
// PBKDF2-HMAC-SHA512 (modern) with an OpenSSL EVP_BytesToKey(MD5) fallback for
// legacy pastes. HTTP access goes through nativeFetchText.

import CryptoJS from 'crypto-js';
import { fetchText } from './http';

const UA = 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko)';

/** Decode a paste.sh URL, returning '' on any failure. */
export async function decryptPasteSh(urlWithHash: string): Promise<string> {
  const hashIdx = urlWithHash.indexOf('#');
  if (hashIdx <= 0) return '';
  const baseUrl = urlWithHash.slice(0, hashIdx);
  const clientKey = urlWithHash.slice(hashIdx + 1);
  const id = baseUrl.slice(baseUrl.lastIndexOf('/') + 1);
  const res = await fetchText(`${baseUrl}.txt`, { headers: { 'User-Agent': UA }, timeoutMs: 12000 });
  if (!res.ok || !res.data) return '';
  const lines = res.data.split('\n');
  if (!lines.length) return '';
  const serverKey = lines[0].trim();
  const b64 = lines.slice(1).join('').trim();
  if (!b64) return '';

  let b64decoded: CryptoJS.lib.WordArray;
  try {
    b64decoded = CryptoJS.enc.Base64.parse(b64);
  } catch {
    return '';
  }
  const binary = b64decoded.toString(CryptoJS.enc.Latin1);
  if (binary.length < 17 || binary.slice(0, 8) !== 'Salted__') return '';
  const salt = CryptoJS.enc.Latin1.parse(binary.slice(8, 16));
  const ciphertext = CryptoJS.enc.Latin1.parse(binary.slice(16));
  const password = `${id}${serverKey}${clientKey}https://paste.sh`;
  const params = { ciphertext, padding: CryptoJS.pad.Pkcs7 } as CryptoJS.lib.CipherParams;

  // 1) PBKDF2-HMAC-SHA512, 1 iteration, 48 bytes (32 key + 16 IV).
  try {
    const derived = CryptoJS.PBKDF2(password, salt, { keySize: 48 / 4, iterations: 1, hasher: CryptoJS.algo.SHA512 });
    const out = CryptoJS.AES.decrypt(params, CryptoJS.lib.WordArray.create(derived.words.slice(0, 8)), {
      iv: CryptoJS.lib.WordArray.create(derived.words.slice(8, 12)),
    }).toString(CryptoJS.enc.Utf8);
    if (out) return out;
  } catch {
    // fall through to the EVP path
  }

  // 2) OpenSSL EVP_BytesToKey(MD5) fallback (legacy pastes).
  try {
    const words: number[] = [];
    let prev = CryptoJS.lib.WordArray.create([] as number[]);
    while (words.length < 12) {
      prev = CryptoJS.MD5(prev.clone().concat(CryptoJS.enc.Utf8.parse(password)).concat(salt));
      for (const word of prev.words) words.push(word);
    }
    return CryptoJS.AES.decrypt(params, CryptoJS.lib.WordArray.create(words.slice(0, 8)), {
      iv: CryptoJS.lib.WordArray.create(words.slice(8, 12)),
    }).toString(CryptoJS.enc.Utf8);
  } catch {
    return '';
  }
}

export const PasteShDecryptor = { decrypt: decryptPasteSh };
