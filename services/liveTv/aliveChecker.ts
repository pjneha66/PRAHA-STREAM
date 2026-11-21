// Checks which streams answer, a handful at a time.
//
// Ported from VyseTV `lib/data/live_tv/live_tv.dart` (`AliveChecker`,
// GPL-3.0-or-later). Only ever given the channels on screen (one category),
// never the whole portal: eight workers, a generation counter so a new check
// cancels the old one, and a 2xx/3xx within 8 s counts as alive.

import { probeUrl } from './http';

export type AliveListener = (state: {
  results: ReadonlyMap<string, boolean>;
  done: number;
  total: number;
  running: boolean;
  working: number;
}) => void;

export class AliveChecker {
  results = new Map<string, boolean>();
  done = 0;
  total = 0;
  running = false;

  private generation = 0;
  private disposed = false;
  private listeners = new Set<AliveListener>();

  /** Streams that answered. */
  get working(): number {
    let count = 0;
    for (const ok of this.results.values()) if (ok) count += 1;
    return count;
  }

  subscribe(listener: AliveListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    if (this.disposed) return;
    const snapshot = {
      results: this.results,
      done: this.done,
      total: this.total,
      running: this.running,
      working: this.working,
    };
    for (const listener of [...this.listeners]) listener(snapshot);
  }

  async check(items: readonly (readonly [string, string])[], timeoutMs = 8000): Promise<void> {
    const generation = ++this.generation;
    this.running = true;
    this.done = 0;
    this.total = items.length;
    this.notify();

    let next = 0;
    const worker = async (): Promise<void> => {
      while (generation === this.generation && next < items.length) {
        const [id, url] = items[next++];
        const result = await probeUrl(url, timeoutMs);
        if (generation !== this.generation) return;
        this.results.set(id, result.ok && result.status >= 200 && result.status < 400);
        this.done += 1;
        this.notify();
      }
    };

    await Promise.all(Array.from({ length: 8 }, () => worker()));
    if (generation === this.generation) {
      this.running = false;
      this.notify();
    }
  }

  stop(): void {
    this.generation += 1;
    this.running = false;
    this.notify();
  }

  dispose(): void {
    this.generation += 1;
    this.disposed = true;
    this.listeners.clear();
  }
}
