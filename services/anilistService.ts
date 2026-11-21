/**
 * AniList GraphQL client — port of VyseTV's `lib/data/anime/anilist.dart`.
 *
 * Only the two things PRAHA needs are ported here: a title search and the
 * MAL → AniList id cross-reference. The query *bodies* are the Dart ones
 * (`AniList._card`, `browse`, `idsForMal`): AniList rejects unknown fields, so
 * every field below exists on the real schema.
 *
 * Two extras the Dart original has and this port keeps:
 *
 *  - `bannerImage` and `description(asHtml: false)` come from the Dart details
 *    query, not the card; they are folded into the card because `AniListMedia`
 *    carries them.
 *  - AniList allows ~90 requests a minute per IP. Browsing fires searches
 *    faster than that, so every request goes through a serial gate that keeps
 *    at least one slot of `MIN_REQUEST_SPACING_MS` between calls (60_000 / 90
 *    ≈ 667ms). A 429 answer is waited out and retried instead of surfacing as a
 *    hard failure.
 *
 * All traffic goes through `nativeFetchText` (services/androidBridge.ts), which
 * uses the native HTTP bridge inside the APK and browser `fetch` on the web.
 */
import { nativeFetchText } from './androidBridge';

export const ANILIST_ENDPOINT = 'https://graphql.anilist.co';

/** 90 requests per minute ⇒ one request every ~667ms. */
const MIN_REQUEST_SPACING_MS = 667;
const MAX_RATE_LIMIT_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 50;

export interface AniListMedia {
  id: number;
  idMal: number | null;
  title: { romaji: string; english: string | null; native: string | null };
  coverImage: { extraLarge: string | null; large: string | null };
  bannerImage: string | null;
  description: string | null;
  genres: string[];
  averageScore: number | null;
  episodes: number | null;
  status: string | null;
  isAdult: boolean;
  format: string | null;
}

export type AdultFilter = 'hide' | 'include' | 'only';

export interface SearchAnimeOptions {
  /** `hide` (default) sends `isAdult: false`; `only` sends `isAdult: true`; `include` sends neither. */
  adult?: AdultFilter;
  page?: number;
  perPage?: number;
}

/** A GraphQL error, or a transport/HTTP failure from the endpoint. */
export class AniListError extends Error {
  readonly status: number;
  readonly notFound: boolean;

  constructor(message: string, status = 0, notFound = false) {
    super(message);
    this.name = 'AniListError';
    this.status = status;
    this.notFound = notFound;
  }
}

/** The Dart `_card`, plus the two detail fields `AniListMedia` exposes. */
const MEDIA_CARD = `
  id idMal type format status episodes duration season seasonYear averageScore popularity favourites genres isAdult
  title { romaji english native }
  coverImage { extraLarge large color }
  nextAiringEpisode { episode airingAt }
  bannerImage
  description(asHtml: false)
`;

// ───────────────────────── JSON helpers (no `any`) ─────────────────────────

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ───────────────────────── serial gate (90 req/min) ─────────────────────────

let gateTail: Promise<unknown> = Promise.resolve();
let gateNextAt = 0;

/**
 * Runs `task` after every task queued before it, and no sooner than one
 * `MIN_REQUEST_SPACING_MS` slot after the previous one started. A burst of
 * searches therefore leaves at 90 req/min instead of tripping the limiter.
 */
function throughGate<T>(task: () => Promise<T>): Promise<T> {
  const run = gateTail.then(async () => {
    const wait = gateNextAt - Date.now();
    if (wait > 0) await delay(wait);
    gateNextAt = Date.now() + MIN_REQUEST_SPACING_MS;
    return task();
  });
  // The queue must keep moving even when a request fails.
  gateTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ───────────────────────── GraphQL transport ─────────────────────────

async function postGraphQL(
  query: string,
  variables: Record<string, unknown>,
): Promise<JsonRecord> {
  const body = JSON.stringify({ query, variables });
  let lastStatus = 0;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const response = await throughGate(() =>
      nativeFetchText(ANILIST_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
    );
    lastStatus = response.status;

    if (response.status === 429) {
      if (attempt === MAX_RATE_LIMIT_RETRIES) {
        throw new AniListError(
          'AniList is rate limiting this connection (90 requests/minute). Try again in a minute.',
          429,
        );
      }
      const retryAfterRaw = response.headers?.['retry-after'] ?? response.headers?.['Retry-After'] ?? '';
      const retryAfter = Number.parseInt(retryAfterRaw, 10);
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? clamp(retryAfter, 1, 30) * 1000
        : 1500 * (attempt + 1);
      await delay(waitMs);
      continue;
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(response.data);
    } catch {
      parsed = null;
    }

    const root = asRecord(parsed);
    if (!root) {
      throw new AniListError('AniList returned a response that could not be read.', response.status);
    }

    const errors = root.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const first = asRecord(errors[0]);
      const message = asString(first?.message) ?? `HTTP ${response.status}`;
      const notFound = response.status === 404 || /not found/i.test(message);
      throw new AniListError(message, response.status, notFound);
    }

    if (!response.ok) {
      throw new AniListError(`AniList request failed (HTTP ${response.status}).`, response.status);
    }

    const data = asRecord(root.data);
    if (!data) {
      throw new AniListError('AniList answered without a data object.', response.status);
    }
    return data;
  }

  throw new AniListError(`AniList request failed (HTTP ${lastStatus}).`, lastStatus);
}

// ───────────────────────── parsing ─────────────────────────

/** Reads one AniList `Media` node. Missing or null fields stay null — they are normal. */
export function parseAniListMedia(raw: unknown): AniListMedia | null {
  const node = asRecord(raw);
  if (!node) return null;
  const id = asNumber(node.id);
  if (id === null) return null;

  const title = asRecord(node.title) ?? {};
  const cover = asRecord(node.coverImage) ?? {};

  return {
    id,
    idMal: asNumber(node.idMal),
    title: {
      romaji: asString(title.romaji) ?? '',
      english: asString(title.english),
      native: asString(title.native),
    },
    coverImage: {
      extraLarge: asString(cover.extraLarge),
      large: asString(cover.large),
    },
    bannerImage: asString(node.bannerImage),
    description: asString(node.description),
    genres: asStringArray(node.genres),
    averageScore: asNumber(node.averageScore),
    episodes: asNumber(node.episodes),
    status: asString(node.status),
    isAdult: node.isAdult === true,
    format: asString(node.format),
  };
}

function parseMediaList(raw: unknown): AniListMedia[] {
  if (!Array.isArray(raw)) return [];
  const out: AniListMedia[] = [];
  for (const entry of raw) {
    const media = parseAniListMedia(entry);
    if (media) out.push(media);
  }
  return out;
}

// ───────────────────────── public API ─────────────────────────

/**
 * One page of anime matching `query`.
 *
 * `adult` follows the app setting; the default (`hide`) asks AniList for
 * `isAdult: false` itself, so adult titles never reach the client at all.
 * `only` asks for `isAdult: true`; `include` sends no `isAdult` argument.
 */
export async function searchAnime(
  query: string,
  options: SearchAnimeOptions = {},
): Promise<AniListMedia[]> {
  const adult: AdultFilter = options.adult ?? 'hide';
  const page = Math.max(1, Math.trunc(options.page ?? 1));
  const perPage = clamp(Math.trunc(options.perPage ?? DEFAULT_PER_PAGE), 1, MAX_PER_PAGE);
  const search = query.trim();

  const mediaArgs: string[] = ['type: ANIME'];
  const variables: Record<string, unknown> = { page, perPage };
  const declarations: string[] = ['$page: Int', '$perPage: Int'];

  if (search) {
    mediaArgs.push('search: $search', 'sort: [SEARCH_MATCH]');
    declarations.push('$search: String');
    variables.search = search;
  }

  // The adult filter maps onto AniList's own `isAdult` argument.
  if (adult === 'hide') mediaArgs.push('isAdult: false');
  else if (adult === 'only') mediaArgs.push('isAdult: true');

  const gql = `query (${declarations.join(', ')}) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { total hasNextPage }
      media(${mediaArgs.join(', ')}) {${MEDIA_CARD}}
    }
  }`;

  const data = await postGraphQL(gql, variables);
  const pageNode = asRecord(data.Page);
  return parseMediaList(pageNode?.media);
}

/**
 * The AniList entry for a MyAnimeList id, so external ids can be
 * cross-referenced. Returns `null` when AniList does not know the title.
 */
export async function lookupByMalId(malId: number): Promise<AniListMedia | null> {
  if (!Number.isFinite(malId) || malId <= 0) return null;

  const gql = `query ($malId: Int) {
    Media(idMal: $malId, type: ANIME) {${MEDIA_CARD}}
  }`;

  try {
    const data = await postGraphQL(gql, { malId: Math.trunc(malId) });
    return parseAniListMedia(data.Media);
  } catch (error) {
    if (error instanceof AniListError && error.notFound) return null;
    throw error;
  }
}
