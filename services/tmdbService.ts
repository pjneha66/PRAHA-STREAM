
import { TMDB_API_KEY, TMDB_API_URL } from '../constants';
import { fetchWithAdBlock } from './adBlockerService';

const CACHE_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

const fetchWithCache = async <T,>(url: string, cacheKey: string, adBlockerEnabled: boolean, forceRefresh = false): Promise<T> => {
    const cached = localStorage.getItem(cacheKey);
    if (cached && !forceRefresh) {
        try {
            const { data, timestamp } = JSON.parse(cached);
            if (Date.now() - timestamp < CACHE_EXPIRY_MS) {
                return data as T;
            }
        } catch (e) {
            localStorage.removeItem(cacheKey);
        }
    }

    try {
        const response = await fetchWithAdBlock(url, adBlockerEnabled);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        localStorage.setItem(cacheKey, JSON.stringify({ data, timestamp: Date.now() }));
        return data as T;
    } catch (error) {
        console.error(`Fetch failed for ${url}:`, error);
        if (cached) {
            try {
                const { data } = JSON.parse(cached);
                return data as T; // Return stale cache on error
            } catch (e) {
                localStorage.removeItem(cacheKey);
            }
        }
        throw error;
    }
};

export const tmdbService = {
    searchMulti: (query: string, type: string, adBlockerEnabled: boolean) => {
        const url = type 
            ? `${TMDB_API_URL}/search/${type}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`
            : `${TMDB_API_URL}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`;
        return fetchWithCache<{ results: any[] }>(url, `search_${query}_${type}`, adBlockerEnabled);
    },
    getTrending: (mediaType: 'movie' | 'tv', adBlockerEnabled: boolean) => {
        const url = `${TMDB_API_URL}/trending/${mediaType}/week?api_key=${TMDB_API_KEY}`;
        return fetchWithCache<{ results: any[] }>(url, `trending_${mediaType}`, adBlockerEnabled);
    },
    getIndianMovies: async (adBlockerEnabled: boolean) => {
        const url = `${TMDB_API_URL}/discover/movie?api_key=${TMDB_API_KEY}&region=IN&sort_by=popularity.desc&with_original_language=hi`;
        const data = await fetchWithCache<{ results: any[] }>(url, 'indian_movies_hi', adBlockerEnabled);
        return { 
            ...data,
            results: data.results.map(item => ({...item, media_type: 'movie'}))
        };
    },
    getAnime: async (adBlockerEnabled: boolean) => {
        const url = `${TMDB_API_URL}/discover/tv?api_key=${TMDB_API_KEY}&with_keywords=210024&sort_by=popularity.desc`;
        const data = await fetchWithCache<{ results: any[] }>(url, 'anime_tv', adBlockerEnabled);
        return { 
            ...data,
            results: data.results.map(item => ({...item, media_type: 'tv'}))
        };
    },
    getAnimation: async (adBlockerEnabled: boolean) => {
        const url = `${TMDB_API_URL}/discover/movie?api_key=${TMDB_API_KEY}&with_genres=16&sort_by=popularity.desc`;
        const data = await fetchWithCache<{ results: any[] }>(url, 'animation_movies', adBlockerEnabled);
        return { 
            ...data,
            results: data.results.map(item => ({...item, media_type: 'movie'}))
        };
    },
    getIndianSeries: async (adBlockerEnabled: boolean) => {
        const url = `${TMDB_API_URL}/discover/tv?api_key=${TMDB_API_KEY}&with_origin_country=IN&sort_by=popularity.desc`;
        const data = await fetchWithCache<{ results: any[] }>(url, 'indian_series', adBlockerEnabled);
        return { 
            ...data,
            results: data.results.map(item => ({...item, media_type: 'tv'}))
        };
    },
    getKDramas: async (adBlockerEnabled: boolean) => {
        const url = `${TMDB_API_URL}/discover/tv?api_key=${TMDB_API_KEY}&with_origin_country=KR&sort_by=popularity.desc`;
        const data = await fetchWithCache<{ results: any[] }>(url, 'k_dramas', adBlockerEnabled);
        return { 
            ...data,
            results: data.results.map(item => ({...item, media_type: 'tv'}))
        };
    },
    getWrestling: async (adBlockerEnabled: boolean) => {
        // Keywords: Wrestling (6075), WWE (19320), AEW (257985), UFC (16088), Pro Wrestling (156544)
        // Exclude animation (16) to ensure we get live action wrestling shows
        const url = `${TMDB_API_URL}/discover/tv?api_key=${TMDB_API_KEY}&with_keywords=6075|19320|257985|16088|156544&without_genres=16&sort_by=popularity.desc`;
        const data = await fetchWithCache<{ results: any[] }>(url, 'wrestling_tv_v4', adBlockerEnabled);
        return { 
            ...data,
            results: data.results.map(item => ({...item, media_type: 'tv'}))
        };
    },
    getSports: async (adBlockerEnabled: boolean) => {
        // Use broad keywords for various sports: Sport (2702), Football (5580), Basketball (6048), Tennis (4119), Golf (4118), Soccer (9666), F1 (14937)
        // Exclude wrestling (6075) to keep tabs distinct and exclude animation (16)
        const url = `${TMDB_API_URL}/discover/tv?api_key=${TMDB_API_KEY}&with_keywords=2702|5580|6048|4119|4118|9666|14937&without_keywords=6075&without_genres=16&sort_by=popularity.desc`;
        const data = await fetchWithCache<{ results: any[] }>(url, 'sports_tv_v4', adBlockerEnabled);
        return { 
            ...data,
            results: data.results.map(item => ({...item, media_type: 'tv'}))
        };
    },
    getDocumentaries: async (adBlockerEnabled: boolean) => {
        // Fetch both TV shows and Movies for documentaries to provide a complete list
        const tvUrl = `${TMDB_API_URL}/discover/tv?api_key=${TMDB_API_KEY}&with_genres=99&sort_by=popularity.desc`;
        const movieUrl = `${TMDB_API_URL}/discover/movie?api_key=${TMDB_API_KEY}&with_genres=99&sort_by=popularity.desc`;
        
        try {
            const [tvData, movieData] = await Promise.all([
                fetchWithCache<{ results: any[] }>(tvUrl, 'documentaries_tv_v3', adBlockerEnabled),
                fetchWithCache<{ results: any[] }>(movieUrl, 'documentaries_movie_v3', adBlockerEnabled)
            ]);

            const tvResults = (tvData?.results || []).map(item => ({...item, media_type: 'tv'}));
            const movieResults = (movieData?.results || []).map(item => ({...item, media_type: 'movie'}));
            
            // Combine and sort by popularity
            const combined = [...tvResults, ...movieResults].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

            return { results: combined };
        } catch (e) {
            console.error("Error fetching documentaries:", e);
            // Fallback to just TV if something fails
            const data = await fetchWithCache<{ results: any[] }>(tvUrl, 'documentaries_tv_fallback', adBlockerEnabled);
            return {
                 ...data,
                 results: data.results.map(item => ({...item, media_type: 'tv'}))
            };
        }
    },
    getTvShowDetails: (id: number, adBlockerEnabled: boolean) => {
        const url = `${TMDB_API_URL}/tv/${id}?api_key=${TMDB_API_KEY}`;
        return fetchWithCache<any>(url, `tv_${id}_details`, adBlockerEnabled);
    },
    getTvSeasonDetails: (tvId: number, seasonNumber: number, adBlockerEnabled: boolean) => {
        const url = `${TMDB_API_URL}/tv/${tvId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}`;
        return fetchWithCache<any>(url, `tv_${tvId}_s${seasonNumber}`, adBlockerEnabled);
    },
    getGenres: (adBlockerEnabled: boolean) => {
        const url = `${TMDB_API_URL}/genre/movie/list?api_key=${TMDB_API_KEY}`;
        return fetchWithCache<{ genres: {id: number, name: string}[] }>(url, 'movie_genres', adBlockerEnabled);
    },
};
