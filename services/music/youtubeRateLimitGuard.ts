// Serialises YouTube Music resolution requests and backs off when YouTube
// starts treating this network as a bot.
//
// Ported from VyseTV `lib/services/music/youtube_rate_limit_guard.dart`
// (GPL-3.0-or-later). The Dart guard is deliberately simple: one serialised
// tail, a fixed 2 s gap between attempts, and a flat 5 minute cooldown once a
// rate-limit error is seen. That shape is kept exactly — the point is that a
// phone resolving tracks back-to-back does not trip the bot wall.

/** Thrown while the guard is cooling down. The message is UI-ready. */
export class YoutubeRateLimitException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YoutubeRateLimitException';
  }
}

const MINIMUM_RESOLVE_GAP_MS = 2000;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

class YoutubeRateLimitGuard {
  /** Tail of the serialised queue; every resolve chains onto it. */
  private resolverTail: Promise<void> = Promise.resolve();
  private lastResolveAttempt: number | null = null;
  private cooldownUntil: number | null = null;
  private lastReason: string | null = null;

  get isLimited(): boolean {
    return this.cooldownUntil !== null && Date.now() < this.cooldownUntil;
  }

  /** Milliseconds left on the cooldown, or `null` when none was ever set. */
  get remainingMs(): number | null {
    if (this.cooldownUntil === null) return null;
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  get userMessage(): string {
    const wait = this.remainingMs;
    const waitText = wait === null || wait === 0 ? 'a short while' : formatDuration(wait);
    return `YouTube audio source is busy on this network. Will retry online stream resolving in ${waitText}.`;
  }

  get lastFailureReason(): string | null {
    return this.lastReason;
  }

  throwIfLimited(): void {
    if (this.isLimited) throw new YoutubeRateLimitException(this.userMessage);
  }

  /**
   * Runs `action` as one low-rate request: strictly after the previous one,
   * spaced by {@link MINIMUM_RESOLVE_GAP_MS}, and only while not cooling down.
   * Port of `runLowRequest`.
   */
  runLowRequest<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.resolverTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // The tail must never reject, or one failure would poison every later slot.
    this.resolverTail = previous.then(
      () => gate,
      () => gate,
    );

    return (async () => {
      try {
        try {
          await previous;
        } catch {
          /* a failed predecessor must not cancel this slot */
        }

        this.throwIfLimited();

        const last = this.lastResolveAttempt;
        if (last !== null) {
          const wait = MINIMUM_RESOLVE_GAP_MS - (Date.now() - last);
          if (wait > 0) await sleep(wait);
        }

        this.throwIfLimited();
        this.lastResolveAttempt = Date.now();

        try {
          return await action();
        } catch (error) {
          if (isRateLimitError(error)) this.record(error);
          throw error;
        }
      } finally {
        release();
      }
    })();
  }

  /** Starts a cooldown. Port of `record`. */
  record(error: unknown, durationMs: number = DEFAULT_COOLDOWN_MS): void {
    this.lastReason = error instanceof Error ? error.message : String(error);
    this.cooldownUntil = Date.now() + durationMs;
  }

  clear(): void {
    this.cooldownUntil = null;
    this.lastReason = null;
  }

  /** Test hook: also clears the spacing anchor so the next slot is immediate. */
  reset(): void {
    this.cooldownUntil = null;
    this.lastReason = null;
    this.lastResolveAttempt = null;
    this.resolverTail = Promise.resolve();
  }
}

/** Port of `isRateLimitError`: the bot wall does not always arrive as a 429. */
export function isRateLimitError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    text.includes('rate-limit')
    || text.includes('ratelimit')
    || text.includes('429')
    || text.includes('too many requests')
    || text.includes("sign in to confirm you're not a bot")
    || text.includes('unusual traffic')
    || text.includes('bot detection')
  );
}

export const youtubeRateLimitGuard = new YoutubeRateLimitGuard();
