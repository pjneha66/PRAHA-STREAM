import type { StreamSubtitle } from '../types';
import { nativeFetchText } from './androidBridge';

function parseTimestampToMs(raw: string): number | null {
  const cleaned = raw.trim().replace(',', '.');
  const match = cleaned.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const millis = Number((match[4] || '0').padEnd(3, '0'));
  return ((hours * 3600) + (minutes * 60) + seconds) * 1000 + millis;
}

function formatVttTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3600000);
  const minutes = Math.floor((clamped % 3600000) / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const millis = clamped % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * Shifts WebVTT/SRT cue timestamps by `offsetSeconds` and normalizes any SRT
 * or ASS dialogue text into valid HTML5 `WEBVTT` content.
 */
export function convertToWebVtt(rawContent: string, offsetSeconds = 0): string {
  const offsetMs = Math.round(offsetSeconds * 1000);
  const normalized = rawContent.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();

  // Basic ASS/SSA Dialogue parser
  if (/\[Events\]/i.test(normalized) && /^Dialogue:/m.test(normalized)) {
    const cues: string[] = ['WEBVTT', ''];
    normalized.split('\n').forEach((line) => {
      if (!line.startsWith('Dialogue:')) return;
      const parts = line.slice('Dialogue:'.length).split(',');
      if (parts.length < 10) return;
      const startMs = parseTimestampToMs(parts[1]);
      const endMs = parseTimestampToMs(parts[2]);
      if (startMs === null || endMs === null) return;
      const text = parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').trim();
      if (!text) return;
      cues.push(`${formatVttTimestamp(startMs + offsetMs)} --> ${formatVttTimestamp(endMs + offsetMs)}`);
      cues.push(text);
      cues.push('');
    });
    return cues.join('\n');
  }

  const lines = normalized.split('\n');
  const output: string[] = ['WEBVTT', ''];
  const startIndex = /^WEBVTT\b/i.test(lines[0] || '') ? 1 : 0;

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];
    // Skip standalone numeric SRT cue indices right above a timing line
    if (/^\d+$/.test(line.trim()) && lines[i + 1]?.includes('-->')) {
      continue;
    }
    if (line.includes('-->')) {
      const [rawStart, rawRest] = line.split('-->');
      const restParts = (rawRest || '').trim().split(/\s+/);
      const rawEnd = restParts[0] || '';
      const cueSettings = restParts.slice(1).join(' ');
      const startMs = parseTimestampToMs(rawStart);
      const endMs = parseTimestampToMs(rawEnd);
      if (startMs !== null && endMs !== null) {
        const header = `${formatVttTimestamp(startMs + offsetMs)} --> ${formatVttTimestamp(endMs + offsetMs)}`;
        output.push(cueSettings ? `${header} ${cueSettings}` : header);
        continue;
      }
    }
    output.push(line);
  }

  return output.join('\n');
}

const rawSubtitleCache = new Map<string, string>();

/**
 * Prepares a subtitle track so `<video><track>` can always render it:
 * converts `.srt` / `.ass` into `WEBVTT`, bypasses CORS on Android, and
 * applies `offsetSeconds` cue shifting when non-zero.
 */
export async function prepareSubtitleUrl(subtitle: StreamSubtitle, offsetSeconds = 0): Promise<string> {
  if (!subtitle.url) return '';
  const isVttDirect = /\.vtt($|\?)/i.test(subtitle.url) && offsetSeconds === 0 && !subtitle.headers;
  if (isVttDirect && !subtitle.url.startsWith('data:')) {
    // Still try fetching to avoid cross-origin <track> rejection, fallback to raw URL
    try {
      let raw = rawSubtitleCache.get(subtitle.url);
      if (!raw) {
        const res = await nativeFetchText(subtitle.url, { headers: subtitle.headers, timeoutMs: 10000 });
        if (res.ok && res.data) {
          raw = res.data;
          rawSubtitleCache.set(subtitle.url, raw);
        }
      }
      if (raw) {
        const vtt = convertToWebVtt(raw, offsetSeconds);
        return URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      }
    } catch {
      return subtitle.url;
    }
    return subtitle.url;
  }

  let raw = rawSubtitleCache.get(subtitle.url);
  if (!raw) {
    if (subtitle.url.startsWith('blob:')) {
      const resp = await fetch(subtitle.url);
      raw = await resp.text();
    } else {
      const resp = await nativeFetchText(subtitle.url, { headers: subtitle.headers, timeoutMs: 12000 });
      if (!resp.ok) throw new Error(`Subtitle HTTP ${resp.status}`);
      raw = resp.data;
    }
    rawSubtitleCache.set(subtitle.url, raw);
  }

  const vtt = convertToWebVtt(raw, offsetSeconds);
  return URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
}

export async function parseLocalSubtitleFile(file: File): Promise<StreamSubtitle> {
  const content = await file.text();
  const vtt = convertToWebVtt(content, 0);
  const blobUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
  rawSubtitleCache.set(blobUrl, content);
  const baseName = file.name.replace(/\.(srt|vtt|ass|ssa)$/i, '');
  return {
    id: `local:${Date.now()}:${file.name}`,
    url: blobUrl,
    language: 'local',
    name: `${baseName} (Local)`,
  };
}
