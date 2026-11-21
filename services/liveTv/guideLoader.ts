// The guide for the channels on screen.
//
// Ported line for line from VyseTV `lib/data/live_tv/live_guide.dart` (`GuideLoader`,
// GPL-3.0-or-later). Rows say when they appear and leave; this loads a few at a
// time, newest first, drops requests for rows that scrolled away before their
// turn, and keeps every answer for the rest of the session. A portal with a
// thousand channels only ever costs as many requests as rows you stopped on.

import type { EpgEntry, IptvStream, VerifiedPortal } from './models';
import { IptvClient } from './network';

/** How one request is made; swapped out in tests. */
export type GuideFetch = (
  portal: VerifiedPortal,
  stream: IptvStream,
  options: { first: boolean; limit: number },
) => Promise<EpgEntry[]>;

const TIMEOUT_MS = 14_000;
const EMPTY_RETRY_MS = 15 * 60 * 1000; // nothing came back: ask again much later
const STALE_RETRY_MS = 5 * 60 * 1000; // everything it knew has aired
const NEXT_RETRY_MS = 10 * 60 * 1000; // knows what's on, not what's next
const SCHEDULE_KEEP_MS = 10 * 60 * 1000;

class Slot {
  data: EpgEntry[] | null = null;
  fetchedAt: number | null = null;
  scheduleAt: number | null = null;
  wanted = 0;
  queued = false;
  loading = false;
  scheduleLoading = false;

  constructor(readonly portal: VerifiedPortal, readonly stream: IptvStream) {}
}

function stopMs(entry: EpgEntry): number {
  const value = entry.stop;
  if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function startMs(entry: EpgEntry): number {
  const value = entry.start;
  if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export class GuideLoader {
  private readonly slots = new Map<string, Slot>();
  private readonly queue: Slot[] = [];
  private active = 0;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private watchers = 0;

  /** Only a signal: rows read the time themselves when they draw. */
  clockListeners = new Set<(at: number) => void>();

  constructor(
    private readonly fetcher: GuideFetch,
    private readonly maxActive = 3,
    private readonly settleMs = 220,
  ) {}

  get activeCount(): number { return this.active; }
  get waiting(): number { return this.queue.length; }

  static keyOf(portal: VerifiedPortal, stream: IptvStream): string {
    return `${portal.portal.url}|${portal.portal.username}|${stream.streamId}`;
  }

  /** A page showing guide rows is open (or closed again). */
  addWatcher(): void {
    if (this.watchers++ === 0) {
      this.tick = setInterval(() => {
        const now = Date.now();
        for (const listener of [...this.clockListeners]) listener(now);
      }, 30_000);
    }
  }

  removeWatcher(): void {
    if (this.watchers > 0 && --this.watchers === 0) {
      if (this.tick) clearInterval(this.tick);
      this.tick = null;
    }
  }

  private slot(portal: VerifiedPortal, stream: IptvStream): Slot {
    const key = GuideLoader.keyOf(portal, stream);
    let slot = this.slots.get(key);
    if (!slot) {
      slot = new Slot(portal, stream);
      this.slots.set(key, slot);
    }
    return slot;
  }

  /** The guide held for a channel, for a row to read. */
  guideOf(portal: VerifiedPortal, stream: IptvStream): EpgEntry[] | null {
    return this.slot(portal, stream).data;
  }

  /** A row for this channel came on screen. */
  want(portal: VerifiedPortal, stream: IptvStream): void {
    const slot = this.slot(portal, stream);
    slot.wanted += 1;
    this.enqueue(slot);
  }

  /** The row left: a request that hasn't started is dropped. */
  unwant(portal: VerifiedPortal, stream: IptvStream): void {
    const slot = this.slots.get(GuideLoader.keyOf(portal, stream));
    if (!slot) return;
    if (slot.wanted > 0) slot.wanted -= 1;
    if (slot.wanted === 0 && slot.queued) {
      slot.queued = false;
      const index = this.queue.indexOf(slot);
      if (index >= 0) this.queue.splice(index, 1);
    }
  }

  /** A row still on screen checks whether its guide has run out. */
  refresh(portal: VerifiedPortal, stream: IptvStream): void {
    const slot = this.slots.get(GuideLoader.keyOf(portal, stream));
    if (slot && slot.wanted > 0) this.enqueue(slot);
  }

  /** The longer schedule for one channel, for its details. One request, kept ten minutes. */
  wantSchedule(portal: VerifiedPortal, stream: IptvStream): void {
    const slot = this.slot(portal, stream);
    const at = slot.scheduleAt;
    if (slot.scheduleLoading || (at !== null && Date.now() - at < SCHEDULE_KEEP_MS)) return;
    slot.scheduleLoading = true;
    void this.load(slot, 8).finally(() => {
      slot.scheduleLoading = false;
      slot.scheduleAt = Date.now();
    });
  }

  private needs(slot: Slot, now: number): boolean {
    if (slot.fetchedAt === null) return true;
    const list = slot.data ?? [];
    const age = now - slot.fetchedAt;
    if (!list.length) return age > EMPTY_RETRY_MS;
    if (!list.some((entry) => stopMs(entry) > now)) return age > STALE_RETRY_MS;
    if (!list.some((entry) => startMs(entry) > now)) return age > NEXT_RETRY_MS;
    return false;
  }

  private enqueue(slot: Slot): void {
    if (slot.queued || slot.loading || slot.scheduleLoading || !this.needs(slot, Date.now())) return;
    slot.queued = true;
    this.queue.push(slot);
    if (this.kick === null) {
      this.kick = setTimeout(() => {
        this.kick = null;
        this.pump();
      }, this.settleMs);
    }
  }

  private pump(): void {
    while (this.active < this.maxActive && this.queue.length > 0) {
      const slot = this.queue.pop()!; // newest first: those rows are the ones on screen
      slot.queued = false;
      this.active += 1;
      slot.loading = true;
      const limit = slot.fetchedAt === null ? 2 : 4;
      void this.load(slot, limit).finally(() => {
        slot.loading = false;
        this.active -= 1;
        this.pump();
      });
    }
  }

  /** Never throws: a failed request leaves the row as it was, with no guide. */
  private async load(slot: Slot, limit: number): Promise<void> {
    let list: EpgEntry[] = [];
    const first = slot.fetchedAt === null;
    try {
      list = await Promise.race([
        this.fetcher(slot.portal, slot.stream, { first, limit }),
        new Promise<EpgEntry[]>((resolve) => { setTimeout(() => resolve([]), TIMEOUT_MS); }),
      ]);
    } catch {
      list = [];
    }
    slot.fetchedAt = Date.now();
    const sorted = [...list].sort((a, b) => startMs(a) - startMs(b));
    // A refresh that came back empty keeps what it had.
    if (sorted.length > 0 || slot.data === null) slot.data = sorted;
  }

  /** Drop everything held (signing out of a portal, or tests). */
  clear(): void {
    this.slots.clear();
    this.queue.length = 0;
  }
}

let liveGuideInstance: GuideLoader | null = null;

/** One loader for the whole app run, so the guide survives leaving and reopening a portal. */
export function liveGuide(): GuideLoader {
  if (!liveGuideInstance) {
    liveGuideInstance = new GuideLoader((portal, stream, options) =>
      IptvClient.shortEpg(portal.portal, stream.streamId, options.limit),
    );
  }
  return liveGuideInstance;
}

/** Tests: swap the singleton. */
export function setLiveGuide(loader: GuideLoader | null): void {
  liveGuideInstance = loader;
}
