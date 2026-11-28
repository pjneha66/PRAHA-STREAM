// Public channel previews adapted from Hikari's TelegramWeb (GPL-3.0, Copyright (C) 2026 Codegeasse).
import { nativeFetchText } from './androidBridge';

export interface TelegramVideo {
  id: number;
  title: string;
  url: string;
  duration: string;
  poster?: string;
}

export interface TelegramLink {
  channel: string;
  post?: number;
}

const CHANNEL = /^[a-z\d_]{3,64}$/i;

export function telegramLink(input: string): TelegramLink | undefined {
  const raw = input.trim().replace(/^@/, '');
  if (CHANNEL.test(raw)) return { channel: raw };
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        !['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me'].includes(url.hostname)) return;
    const [channel, suffix] = url.pathname.replace(/^\/(?:s\/)?/, '').split('/');
    if (!CHANNEL.test(channel)) return;
    if (suffix && (!/^\d+$/.test(suffix) || !Number.isSafeInteger(Number(suffix)) || Number(suffix) < 1)) return;
    return suffix ? { channel, post: Number(suffix) } : { channel };
  } catch {
    return;
  }
}

export function telegramChannel(input: string) {
  return telegramLink(input)?.channel ?? '';
}

function httpsUrl(raw: string | null | undefined) {
  if (!raw) return undefined;
  try {
    const url = new URL(raw, 'https://t.me/');
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* Skip malformed preview media. */ }
  return undefined;
}

export function parseTelegramPage(html: string, channel: string, requestedPost?: number) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const posts = Array.from(doc.querySelectorAll('.tgme_widget_message[data-post]'));
  const ids: number[] = [];
  const videos: TelegramVideo[] = [];
  let withheld = 0;
  for (const post of posts) {
    const [owner, suffix] = (post.getAttribute('data-post') ?? '').split('/');
    const id = Number(suffix);
    if (owner.toLowerCase() !== channel.toLowerCase() || !Number.isSafeInteger(id) || id < 1 ||
        (requestedPost && id !== requestedPost)) continue;
    ids.push(id);
    const video = post.querySelector('video');
    const raw = video?.getAttribute('src') || video?.getAttribute('data-src') || video?.querySelector('source')?.getAttribute('src');
    const url = httpsUrl(raw);
    if (!url) {
      if (post.querySelector('.message_media_not_supported, .tgme_widget_message_video_player')) withheld++;
      continue;
    }
    const title = post.querySelector('.tgme_widget_message_text')?.textContent?.trim() ||
      post.querySelector('.tgme_widget_message_document_title')?.textContent?.trim() || `Video ${id}`;
    const duration = post.querySelector('.tgme_widget_message_video_duration')?.textContent?.trim() ?? '';
    const style = post.querySelector('.tgme_widget_message_video_thumb, .tgme_widget_message_photo_wrap')?.getAttribute('style');
    const poster = httpsUrl(video?.getAttribute('poster') || style?.match(/url\(['"]?([^)'"]+)/)?.[1]);
    videos.push({ id, title, url, duration, ...(poster ? { poster } : {}) });
  }
  return {
    title: doc.querySelector('.tgme_channel_info_header_title')?.textContent?.trim() ||
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || `@${channel}`,
    before: !requestedPost && ids.length ? Math.min(...ids) : 0,
    videos: videos.sort((a, b) => b.id - a.id),
    withheld,
  };
}

export async function loadTelegramVideos(link: TelegramLink, before?: number, query?: string) {
  const name = encodeURIComponent(link.channel);
  const url = new URL(link.post ? `https://t.me/${name}/${link.post}?embed=1` : `https://t.me/s/${name}`);
  if (query && !link.post) url.searchParams.set('q', query);
  if (before && !link.post) url.searchParams.set('before', String(before));
  const response = await nativeFetchText(url.href);
  if (!response.ok) throw new Error(response.status ? `Telegram returned HTTP ${response.status}.` : 'Could not reach Telegram.');
  return parseTelegramPage(response.data, link.channel, link.post);
}
