// Names you gave your portals.
//
// Ported from VyseTV `lib/data/live_tv/portal_names.dart` (GPL-3.0-or-later).
// A portal arrives with whatever its provider called the account — usually the
// user name, "5843256" — so a name of your own is shown in its place.

import type { VerifiedPortal } from './models';
import { normalizePortalUrl } from './portal';

const NAMES_KEY = 'live_tv_portal_names';

type Listener = () => void;

function readNames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(NAMES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export class PortalNames {
  private static names: Record<string, string> = {};
  private static loaded = false;
  private static listeners = new Set<Listener>();

  /** Bumped whenever a name changes, so React can re-render. */
  static version = 0;

  static subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private static emit(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  static load(): void {
    if (this.loaded) return;
    this.loaded = true;
    // A name given before the load finished stays.
    this.names = { ...readNames(), ...this.names };
    this.emit();
  }

  static of(portalKey: string): string | null {
    return this.names[portalKey] ?? null;
  }

  /** Give the portal `name`; an empty one takes yours away again. */
  static set(portalKey: string, name: string): void {
    const clean = String(name || '').trim();
    if (!clean) {
      if (!(portalKey in this.names)) return;
      delete this.names[portalKey];
    } else {
      if (this.names[portalKey] === clean) return;
      this.names[portalKey] = clean;
    }
    this.emit();
    this.save();
  }

  private static save(): void {
    try {
      localStorage.setItem(NAMES_KEY, JSON.stringify(this.names));
    } catch {
      // kept in memory; saved with the next change
    }
  }

  /** Tests: as on a device where no portal was ever renamed. */
  static debugReset(): void {
    this.loaded = false;
    this.names = {};
  }
}

/** A portal's name as the app shows it: yours, else its own, else its address. */
export function portalLabel(portal: VerifiedPortal): string {
  return PortalNames.of(portalKeyOf(portal)) ?? (portal.name || portal.portal.url);
}

/** Portal identity used by PortalNames — matches `portalKey` from `portal.ts`. */
export function portalKeyOf(portal: VerifiedPortal): string {
  return `${normalizePortalUrl(portal.portal.url)}|${portal.portal.username}|${portal.portal.password}`.toLowerCase();
}
