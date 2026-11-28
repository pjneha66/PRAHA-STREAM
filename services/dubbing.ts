import { bridgeRpcAvailable, nativeFetchText, prahaRpc } from './androidBridge';
import { convertToWebVtt } from './subtitleService';

export interface DubCue {
  start: number;
  end: number;
  text: string;
}

export function parseDubCues(raw: string): DubCue[] {
  const seconds = (stamp: string) => stamp.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  return convertToWebVtt(raw).split(/\n\s*\n/).flatMap((block) => {
    const rows = block.split('\n');
    const timing = rows.findIndex((line) => line.includes(' --> '));
    if (timing === -1) return [];
    const match = /^(\d+:\d+:\d+\.\d+) --> (\d+:\d+:\d+\.\d+)/.exec(rows[timing]);
    const text = rows.slice(timing + 1).join(' ').replace(/<[^>]*>/g, '').trim();
    if (!match || !text) return [];
    return [{ start: seconds(match[1]), end: seconds(match[2]), text }];
  }).sort((a, b) => a.start - b.start);
}

export async function translateDubCues(cues: DubCue[], target: string, key: string): Promise<DubCue[]> {
  const translations = new Map<string, string>();
  const unique = [...new Set(cues.map((cue) => cue.text))];
  for (let i = 0; i < unique.length; i += 40) {
    const q = unique.slice(i, i + 40);
    const response = await nativeFetchText('https://translation.googleapis.com/language/translate/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
      body: JSON.stringify({ q, target, format: 'text' }),
    });
    if (!response.ok) throw new Error(`Google Translate returned HTTP ${response.status}.`);
    const values = JSON.parse(response.data).data?.translations;
    if (!Array.isArray(values) || values.length !== q.length) throw new Error('Google Translate returned an incomplete translation.');
    q.forEach((line, index) => translations.set(line, values[index].translatedText));
  }
  return cues.map((cue) => ({ ...cue, text: translations.get(cue.text) ?? cue.text }));
}

export type DubSpeechEngine = 'android' | 'web';

export async function getDubSpeechEngine(): Promise<DubSpeechEngine | null> {
  const native = bridgeRpcAvailable();
  if (native && await prahaRpc<boolean>('dubAvailable', []).catch(() => false)) return 'android';
  if (typeof speechSynthesis !== 'undefined' && (!native || speechSynthesis.getVoices().length)) return 'web';
  return null;
}

export function speakDub(engine: DubSpeechEngine, cue: DubCue, language: string, playbackRate: number) {
  const rate = Math.min(2, Math.max(0.8, cue.text.split(/\s+/).length / (Math.max(0.5, cue.end - cue.start) / playbackRate * 2.6)));
  if (engine === 'android') {
    void prahaRpc('dubSpeak', [cue.text, language, rate]).catch(() => {});
  } else if (typeof speechSynthesis !== 'undefined') {
    const utterance = new SpeechSynthesisUtterance(cue.text);
    utterance.lang = language;
    utterance.rate = rate;
    speechSynthesis.speak(utterance);
  }
}

export function stopDub() {
  if (bridgeRpcAvailable()) void prahaRpc('dubStop', []).catch(() => {});
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

/** Hikari-style online translation, only when the viewer enables it. */
export async function translatePlayerDub(text: string, language: string, key: string): Promise<string> {
  if (key) {
    const [cue] = await translateDubCues([{ start: 0, end: 3, text }], language, key);
    return cue.text;
  }
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.search = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: language, dt: 't', q: text }).toString();
  const response = await nativeFetchText(url.href, { timeoutMs: 8000 });
  if (!response.ok) throw new Error(`Google translation returned HTTP ${response.status}.`);
  const parts = JSON.parse(response.data)[0] as [string][];
  const translated = parts.map(([fragment]) => fragment).join('').trim();
  if (!translated) throw new Error('Google returned an empty translation.');
  return translated;
}

export function googleDubVoiceAvailable() {
  return bridgeRpcAvailable();
}

export async function fetchGoogleDubVoice(text: string, language: string) {
  const audio = await prahaRpc<string>('dubGoogleVoice', [text.slice(0, 800), language], 12000);
  if (!audio) throw new Error('Google voice returned no audio.');
  return `data:audio/mpeg;base64,${audio}`;
}

export function piperVoiceSupported(language: string) {
  return bridgeRpcAvailable() && ['en', 'hi'].includes(language);
}

export function piperVoiceReady(language: string) {
  return prahaRpc<boolean>('dubPiperReady', [language]);
}

export function installPiperVoice(language: string) {
  return prahaRpc<boolean>('dubPiperInstall', [language], 180000);
}

export async function fetchPiperVoice(text: string, language: string) {
  const audio = await prahaRpc<string>('dubPiperVoice', [text.slice(0, 420), language], 16000);
  if (!audio) throw new Error('Piper returned no audio.');
  return `data:audio/wav;base64,${audio}`;
}
