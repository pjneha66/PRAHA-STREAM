/** Time and byte formatting helpers shared by the mpvRx-style player. */

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** `1:02:03` when an hour is present, otherwise `02:03`. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

export function formatBitrate(bitsPerSecond?: number): string {
  if (!bitsPerSecond || !Number.isFinite(bitsPerSecond)) return '—';
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bitsPerSecond / 1000)} kbps`;
}

export function formatBytes(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatSpeed(rate: number): string {
  return `${Number(rate.toFixed(2))}x`;
}

/** Human-readable host of a stream URL, for the stats overlay. */
export function streamHost(url?: string): string {
  if (!url) return '—';
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 48);
  }
}
