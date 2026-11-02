/** Bounded recovery: no retries while paused, seeking, hidden or after exhaustion. */
export const STALL_TIMEOUT_MS = 15_000;
export const MAX_STALL_RETRIES = 2;
export const STABLE_PLAYBACK_SECONDS = 20;

export function stallAction(stalledMs: number, attempts: number, eligible: boolean): 'wait' | 'retry' | 'fail' {
  if (!eligible || stalledMs < STALL_TIMEOUT_MS) return 'wait';
  return attempts < MAX_STALL_RETRIES ? 'retry' : 'fail';
}

export function mediaErrorMessage(code?: number): string {
  switch (code) {
    case 1: return 'Playback was interrupted. Retry or choose another source.';
    case 2: return 'The video network request failed. Check your connection or try another source.';
    case 3: return 'The video could not be decoded. Try another format or an external player.';
    case 4: return 'This format or source is not supported by this player. Try another source or an external player.';
    default: return 'This source could not be played. Retry or choose another source.';
  }
}
