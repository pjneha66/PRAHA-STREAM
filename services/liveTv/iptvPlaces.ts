// Where you stopped in each IPTV film and episode, on this device.
//
// Ported from VyseTV `lib/data/live_tv/iptv_playback.dart` (`IptvPlaces`,
// GPL-3.0-or-later). The first half minute is not a place to come back to, and
// neither are the credits; the newest 300 places are kept. The stored id is a
// stable hash of the address, never the address itself — that holds the
// portal's sign-in.

const PLACES_KEY = 'iptv.vod.places';
const MAX_PLACES = 300;
const SAVE_DEBOUNCE_MS = 5000;

interface Place { seconds: number; at: number; }

let cache: Map<string, Place> | null = null;
let saving: ReturnType<typeof setTimeout> | null = null;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash ^ text.charCodeAt(index)) * 0x01000193) & 0xffffffff;
  }
  return hash & 0x3fffffff;
}

function read(): Map<string, Place> {
  if (cache) return cache;
  const out = new Map<string, Place>();
  try {
    const raw = localStorage.getItem(PLACES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed)) {
          if (!Array.isArray(value) || value.length < 2) continue;
          const seconds = Number(value[0]);
          const at = Number(value[1]);
          if (Number.isFinite(seconds) && Number.isFinite(at)) out.set(key, { seconds, at });
        }
      }
    }
  } catch {
    // unreadable: start again
  }
  cache = out;
  return out;
}

function write(): void {
  saving = null;
  if (!cache) return;
  if (cache.size > MAX_PLACES) {
    const newest = [...cache.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_PLACES);
    cache = new Map(newest);
  }
  try {
    const plain: Record<string, [number, number]> = {};
    for (const [key, place] of cache) plain[key] = [place.seconds, place.at];
    localStorage.setItem(PLACES_KEY, JSON.stringify(plain));
  } catch {
    // kept in memory; saved with the next one
  }
}

export class IptvPlaces {
  /** Where to carry on from, if it was left part of the way through. */
  static of(url: string): number | null {
    const place = read().get(String(fnv1a(url)));
    return place ? place.seconds : null;
  }

  /** The first half minute is not a place to come back to, and neither are the credits. */
  static put(url: string, positionSeconds: number, durationSeconds: number): void {
    if (!cache) read();
    if (!cache || durationSeconds < 60) return;
    const key = String(fnv1a(url));
    const credits = Math.min(300, Math.max(30, Math.round(durationSeconds * 0.05)));
    if (positionSeconds > 30 && positionSeconds < durationSeconds - credits) {
      cache.set(key, { seconds: Math.floor(positionSeconds), at: Date.now() });
    } else if (!cache.delete(key)) {
      return;
    }
    if (saving === null) saving = setTimeout(write, SAVE_DEBOUNCE_MS);
  }

  static flush(): void {
    if (saving !== null) clearTimeout(saving);
    write();
  }

  /** Tests: forget what is in memory, so the next read is from storage. */
  static debugForget(): void {
    if (saving !== null) clearTimeout(saving);
    saving = null;
    cache = null;
  }
}
