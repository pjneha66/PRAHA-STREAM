import type { CloudStreamProvider, CloudStreamRepository } from '../types';

/** Browser-playable CloudStream JavaScript extensions bundled with PRAHA. */
export const BUILTIN_CLOUDSTREAM_JS_CODE: Record<string, string> = {
  'consumet-gogoanime': "// @plugin-info {\"id\":\"consumet-gogoanime\",\"name\":\"GogoAnime\",\"version\":\"1.0.0\",\"description\":\"Anime streaming via GogoAnime (powered by Consumet API)\",\"author\":\"CloudStream Win\",\"icon_url\":null,\"supported_types\":[\"anime\"],\"is_builtin\":false}\n\n// GogoAnime plugin using the public Consumet API\n// Consumet is an open-source API that scrapes streaming sites legally for personal use.\n// API docs: https://docs.consumet.org\n//\n// To use this plugin you need a Consumet API instance.\n// You can self-host one: https://github.com/consumet/api.consumet.org\n// Or use the public demo (may be slow): https://api.consumet.org\n//\n// HOW TO CHANGE THE API URL:\n// Edit the BASE_URL constant below to point to your own instance.\n\nconst BASE_URL = \"https://api.consumet.org\";\nconst PROVIDER = \"gogoanime\";\n\nasync function search(query) {\n    const res = await fetch(`${BASE_URL}/anime/${PROVIDER}/${encodeURIComponent(query)}`);\n    if (!res.ok) return JSON.stringify([]);\n\n    const data = await res.json();\n    const results = (data.results || []).map(item => ({\n        id: item.id,\n        title: item.title,\n        poster_url: item.image || null,\n        media_type: \"anime\",\n        year: item.releaseDate ? parseInt(item.releaseDate) : null,\n        rating: null,\n        description: item.subOrDub ? `[${item.subOrDub.toUpperCase()}]` : null,\n    }));\n\n    return JSON.stringify(results);\n}\n\nasync function getEpisodes(showId) {\n    const res = await fetch(`${BASE_URL}/anime/${PROVIDER}/info/${encodeURIComponent(showId)}`);\n    if (!res.ok) return JSON.stringify([]);\n\n    const data = await res.json();\n    const episodes = (data.episodes || []).map(ep => ({\n        id: ep.id,\n        title: ep.title || `Episode ${ep.number}`,\n        season: null,\n        episode_number: ep.number,\n        thumbnail_url: null,\n        description: null,\n    }));\n\n    return JSON.stringify(episodes);\n}\n\nasync function getStreams(mediaId) {\n    const res = await fetch(`${BASE_URL}/anime/${PROVIDER}/watch/${encodeURIComponent(mediaId)}`);\n    if (!res.ok) return JSON.stringify([]);\n\n    const data = await res.json();\n    const streams = (data.sources || []).map(src => ({\n        url: src.url,\n        quality: src.quality || \"auto\",\n        format: src.url.includes(\".m3u8\") ? \"hls\" : \"mp4\",\n        subtitles: (data.subtitles || []).map(sub => ({\n            url: sub.url,\n            language: sub.lang || \"Unknown\",\n            label: sub.lang || \"Unknown\",\n        })),\n        headers: data.headers || {},\n    }));\n\n    return JSON.stringify(streams);\n}\n",
  'consumet-zoro': "// @plugin-info {\"id\":\"consumet-zoro\",\"name\":\"Hianime (Zoro)\",\"version\":\"1.0.0\",\"description\":\"HD anime streaming via Hianime, powered by Consumet API\",\"author\":\"CloudStream Win\",\"icon_url\":null,\"supported_types\":[\"anime\"],\"is_builtin\":false}\n\n// Hianime (formerly Zoro) plugin using Consumet API\n// Has both SUB and DUB, usually 1080p quality.\n// Requires a Consumet API instance — see gogoanime.js for setup instructions.\n\nconst BASE_URL = \"https://api.consumet.org\";\nconst PROVIDER = \"zoro\";\n\nasync function search(query) {\n    const res = await fetch(`${BASE_URL}/anime/${PROVIDER}/${encodeURIComponent(query)}`);\n    if (!res.ok) return JSON.stringify([]);\n\n    const data = await res.json();\n    const results = (data.results || []).map(item => ({\n        id: item.id,\n        title: item.title,\n        poster_url: item.image || null,\n        media_type: \"anime\",\n        year: null,\n        rating: null,\n        description: item.type ? `[${item.type}]` : null,\n    }));\n\n    return JSON.stringify(results);\n}\n\nasync function getEpisodes(showId) {\n    const res = await fetch(`${BASE_URL}/anime/${PROVIDER}/info?id=${encodeURIComponent(showId)}`);\n    if (!res.ok) return JSON.stringify([]);\n\n    const data = await res.json();\n    const episodes = (data.episodes || []).map(ep => ({\n        id: ep.id,\n        title: ep.title || `Episode ${ep.number}`,\n        season: null,\n        episode_number: ep.number,\n        thumbnail_url: null,\n        description: null,\n    }));\n\n    return JSON.stringify(episodes);\n}\n\nasync function getStreams(mediaId) {\n    const res = await fetch(`${BASE_URL}/anime/${PROVIDER}/watch?episodeId=${encodeURIComponent(mediaId)}`);\n    if (!res.ok) return JSON.stringify([]);\n\n    const data = await res.json();\n    const streams = (data.sources || []).map(src => ({\n        url: src.url,\n        quality: src.quality || \"auto\",\n        format: src.url.includes(\".m3u8\") ? \"hls\" : \"mp4\",\n        subtitles: (data.subtitles || [])\n            .filter(sub => sub.lang !== \"Thumbnails\")\n            .map(sub => ({\n                url: sub.url,\n                language: sub.lang,\n                label: sub.lang,\n            })),\n        headers: { \"Referer\": \"https://hianime.to\" },\n    }));\n\n    return JSON.stringify(streams);\n}\n",
  'consumet-movies': "// @plugin-info {\"id\":\"consumet-movies\",\"name\":\"Movies & TV (TMDB)\",\"version\":\"1.0.0\",\"description\":\"Movies and TV shows via TMDB metadata + VidSrc streaming\",\"author\":\"CloudStream Win\",\"icon_url\":null,\"supported_types\":[\"movie\",\"show\"],\"is_builtin\":false}\n\n// Movies & TV Shows plugin\n// - Uses TMDB (The Movie Database) API for metadata and search\n// - Uses VidSrc for stream URLs (free, no API key needed)\n//\n// To get a free TMDB API key: https://www.themoviedb.org/settings/api\n// Replace YOUR_TMDB_API_KEY below with your key.\n\nconst TMDB_API_KEY = \"YOUR_TMDB_API_KEY\";\nconst TMDB_BASE = \"https://api.themoviedb.org/3\";\nconst TMDB_IMG = \"https://image.tmdb.org/t/p/w500\";\nconst VIDSRC_BASE = \"https://vidsrc.to/embed\";\n\nasync function search(query) {\n    const res = await fetch(\n        `${TMDB_BASE}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&include_adult=false`\n    );\n    if (!res.ok) return JSON.stringify([]);\n\n    const data = await res.json();\n    const results = (data.results || [])\n        .filter(item => item.media_type === \"movie\" || item.media_type === \"tv\")\n        .slice(0, 20)\n        .map(item => {\n            const isMovie = item.media_type === \"movie\";\n            return {\n                id: `${item.media_type}:${item.id}`,\n                title: isMovie ? item.title : item.name,\n                poster_url: item.poster_path ? `${TMDB_IMG}${item.poster_path}` : null,\n                media_type: isMovie ? \"movie\" : \"show\",\n                year: isMovie\n                    ? (item.release_date ? parseInt(item.release_date) : null)\n                    : (item.first_air_date ? parseInt(item.first_air_date) : null),\n                rating: item.vote_average ? Math.round(item.vote_average * 10) / 10 : null,\n                description: item.overview || null,\n            };\n        });\n\n    return JSON.stringify(results);\n}\n\nasync function getEpisodes(showId) {\n    // showId format: \"tv:12345\"\n    const [type, id] = showId.split(\":\");\n    if (type !== \"tv\") return JSON.stringify([]);\n\n    // Get show details to find seasons\n    const res = await fetch(`${TMDB_BASE}/tv/${id}?api_key=${TMDB_API_KEY}`);\n    if (!res.ok) return JSON.stringify([]);\n\n    const show = await res.json();\n    const episodes = [];\n\n    // Load episodes from each season\n    for (const season of (show.seasons || [])) {\n        if (season.season_number === 0) continue; // skip specials\n\n        const sRes = await fetch(\n            `${TMDB_BASE}/tv/${id}/season/${season.season_number}?api_key=${TMDB_API_KEY}`\n        );\n        if (!sRes.ok) continue;\n\n        const sData = await sRes.json();\n        for (const ep of (sData.episodes || [])) {\n            episodes.push({\n                id: `tv:${id}:${season.season_number}:${ep.episode_number}`,\n                title: ep.name || `Episode ${ep.episode_number}`,\n                season: season.season_number,\n                episode_number: ep.episode_number,\n                thumbnail_url: ep.still_path ? `${TMDB_IMG}${ep.still_path}` : null,\n                description: ep.overview || null,\n            });\n        }\n    }\n\n    return JSON.stringify(episodes);\n}\n\nasync function getStreams(mediaId) {\n    // mediaId format:\n    //   movie: \"movie:12345\"\n    //   episode: \"tv:12345:1:3\"  (show:season:episode)\n    const parts = mediaId.split(\":\");\n\n    let embedUrl;\n    if (parts[0] === \"movie\") {\n        embedUrl = `${VIDSRC_BASE}/movie/${parts[1]}`;\n    } else if (parts[0] === \"tv\") {\n        embedUrl = `${VIDSRC_BASE}/tv/${parts[1]}/${parts[2]}/${parts[3]}`;\n    } else {\n        return JSON.stringify([]);\n    }\n\n    // VidSrc embed URL is not a direct stream — return it as an embed\n    // The player will open it in a webview\n    return JSON.stringify([{\n        url: embedUrl,\n        quality: \"auto\",\n        format: \"embed\",\n        subtitles: [],\n        headers: {},\n    }]);\n}\n",
};

export const BUILTIN_MANIFEST_URL = "builtin://cloudstream-js";

export function buildBuiltinCloudStreamJsRepository(): CloudStreamRepository {
  const providers: CloudStreamProvider[] = [
    {
      id: "consumet-gogoanime",
      name: "GogoAnime",
      description: "Anime streaming via GogoAnime (Consumet API)",
      repositoryId: "builtin://cloudstream-js",
      enabled: true,
      manifestEnabled: true,
      supportedTypes: ["series"],
      code: BUILTIN_CLOUDSTREAM_JS_CODE["consumet-gogoanime"],
      nativeOnly: false,
      installedAt: Date.now(),
    },
    {
      id: "consumet-zoro",
      name: "Hianime (Zoro)",
      description: "HD anime via Hianime (Consumet API)",
      repositoryId: "builtin://cloudstream-js",
      enabled: true,
      manifestEnabled: true,
      supportedTypes: ["series"],
      code: BUILTIN_CLOUDSTREAM_JS_CODE["consumet-zoro"],
      nativeOnly: false,
      installedAt: Date.now(),
    },
    {
      id: "consumet-movies",
      name: "Movies & TV (TMDB)",
      description: "Movies & TV via TMDB + VidSrc",
      repositoryId: "builtin://cloudstream-js",
      enabled: true,
      manifestEnabled: true,
      supportedTypes: ["movie","series"],
      code: BUILTIN_CLOUDSTREAM_JS_CODE["consumet-movies"],
      nativeOnly: false,
      installedAt: Date.now(),
    }
  ];
  return {
    manifestUrl: "builtin://cloudstream-js",
    name: "CloudStream JS (built-in)",
    description: "Browser-playable CloudStream JavaScript extensions bundled with PRAHA.",
    pluginListUrls: ["builtin://cloudstream-js"],
    enabled: true,
    providers,
    installedAt: Date.now(),
    updatedAt: Date.now(),
  };
}
