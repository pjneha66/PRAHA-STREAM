
// constants.ts

import { Settings, Servers } from './types';

// FIX: Reverted to the user's original, working TMDB API key to resolve 401 Unauthorized errors.
export const TMDB_API_KEY = 'a063fe3fed20c259091996e6fa7c18a7';
export const TMDB_API_URL = 'https://api.themoviedb.org/3';

// FIX: Added a CORS proxy URL for the VPN feature.
export const CORS_PROXY_URL = 'https://cors-proxy.elfhosted.com/?url='; 

// FIX: Expanded the ad domains list for a stronger ad blocker.
export const AD_DOMAINS = [
    'doubleclick.net', 'adservice.google.com', 'googlesyndication.com',
    'google-analytics.com', 'adinjector.net', 'adserver.com', 'adsrvr.org',
    'adtech.de', 'advertising.com', 'yieldmanager.com', 'revsci.net',
    'live.com', 'adnxs.com', 'rubiconproject.com', 'openx.net', 'pubmatic.com',
    'criteo.com', 'outbrain.com', 'taboola.com', 'amazon-adsystem.com',
    'facebook.com/tr', 'connect.facebook.net', 'ads.twitter.com', 'static.ads-twitter.com',
    'pixel.facebook.com', 'analytics.twitter.com', 't.co', 'ads.linkedin.com',
    'bing.com/bat.js', 'bat.bing.com', 'clarity.ms', 'hotjar.com', 'sentry.io',
    'newrelic.com', 'nr-data.net', 'segment.io', 'segment.com', 'scorecardresearch.com',
    'quantserve.com', 'moatads.com', 'popads.net', 'popcash.net', 'propellerads.com',
    'mc.yandex.ru', 'usefathom.com', 'clicky.com', 'matomo.org', 'getclicky.com',
    'histats.com', 'statcounter.com', 's.pinimg.com', 'ads.pinterest.com',
    'adroll.com', 'app-measurement.com', 'appsflyer.com', 'branch.io',
    'chartbeat.com', 'crazyegg.com', 'fullstory.com', 'heap.io', 'inspectlet.com',
    'intercom.io', 'logrocket.io', 'mixpanel.com', 'mouseflow.com',
    'optimizely.com', 'parsely.com', 'pendo.io', 'pingdom.net', 'qualtrics.com',
    'segment.io', 'siteimprove.com', 'tealiumiq.com', 'userlike.com',
    'usabilla.com', 'visualwebsiteoptimizer.com', 'woopra.com', 'yandex.com',
    'ad-delivery.net', 'ad-maven.com', 'ad-score.com', 'ad-stir.com',
    'ad.360yield.com', 'ad.agkn.com', 'ad.alexametrics.com', 'ad.altervista.org',
    'ad.a-ads.com', 'ad.admitad.com'
];

// FIX: Restored the full, extensive list of streaming servers from the user's original code.
export const SERVERS: Servers = {
    // --- Original Preferred Servers ---
    'vidify-top': { name: '🥇 Vidify (Default)', movieUrl: 'https://player.vidify.top/embed/movie/{id}', tvUrl: 'https://player.vidify.top/embed/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'vidnest-fun': { name: '🥇 VidNest Multi Language', movieUrl: 'https://vidnest.fun/movie/{id}', tvUrl: 'https://vidnest.fun/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'primewire-tf': { name: '🥈 PrimeWire', movieUrl: 'https://www.primewire.tf/embed/movie?tmdb={id}', tvUrl: 'https://www.primewire.tf/embed/tv?tmdb={id}&season={season}&episode={episode}', downloadSupport: true, qualityOptions: ['1080p', '720p'], cors: true },
    'vidsrc-wtf-api2': { name: '🥉 VidSrc.wtf API 2', movieUrl: 'https://www.vidsrc.wtf/api/2/movie/?id={id}', tvUrl: 'https://www.vidsrc.wtf/api/2/tv/?id={id}&s={season}&e={episode}', downloadSupport: true, qualityOptions: ['auto', '720p', '480p'], cors: true },
    'vidrock-net': { name: '🥉 VidRock', movieUrl: 'https://vidrock.net/movie/{id}', tvUrl: 'https://vidrock.net/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'mappletv-uk': { name: '🥉 MapleTV', movieUrl: 'https://mappletv.uk/watch/movie/{id}', tvUrl: 'https://mappletv.uk/watch/tv/{id}/{season}/{episode}', downloadSupport: false, qualityOptions: ['auto', '720p'], cors: true },
    
    // --- Original API Servers ---
    'vidsrc-wtf-api3': { name: '🔥 VidSrc.wtf API 3', movieUrl: 'https://www.vidsrc.wtf/api/3/movie?id={id}', tvUrl: 'https://www.vidsrc.wtf/api/3/tv/?id={id}&s={season}&e={episode}', downloadSupport: true, qualityOptions: ['auto', '720p', '480p'], cors: true },
    'spencerdevs-xyz': { name: '🔥 SpencerDevs', movieUrl: 'https://spencerdevs.xyz/movie/{id}', tvUrl: 'https://spencerdevs.xyz/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'hexa-watch': { name: '🔥 Hexa', movieUrl: 'https://hexa.watch/watch/movie/{id}', tvUrl: 'https://hexa.watch/watch/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'superembed-vip': { name: '🔥 SuperEmbed (VIP)', movieUrl: 'https://multiembed.mov/directstream.php?video_id={id}&tmdb=1', tvUrl: 'https://multiembed.mov/directstream.php?video_id={id}&tmdb=1&s={season}&e={episode}', downloadSupport: true, qualityOptions: ['1080p', '720p'], cors: true },
    'nontongo-win': { name: '🔥 NontonGo', movieUrl: 'https://www.NontonGo.win/embed/movie/{id}', tvUrl: 'https://www.NontonGo.win/embed/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'autoembed-co': { name: '🔥 AutoEmbed.co', movieUrl: 'https://autoembed.co/movie/tmdb/{id}', tvUrl: 'https://autoembed.co/tv/tmdb/{id}-{season}-{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    '111movies-com': { name: '🔥 111Movies', movieUrl: 'https://111movies.com/movie/{id}', tvUrl: 'https://111movies.com/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'vidfast-pro': { name: '🔥 VidFast Pro', movieUrl: 'https://vidfast.pro/movie/{id}', tvUrl: 'https://vidfast.pro/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'vidora-su': { name: '🔥 Vidora', movieUrl: 'https://vidora.su/movie/{id}', tvUrl: 'https://vidora.su/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'vidsrc-embed': { name: '🔹 VidSrc (Original)', movieUrl: 'https://vidsrc-embed.ru/embed/movie/{id}', tvUrl: 'https://vidsrc-embed.ru/embed/tv/{id}/{season}-{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'vidsrc-backup': { name: '🔹 VidSrc (Backup)', movieUrl: 'https://vidsrc-embed.su/embed/movie/{id}', tvUrl: 'https://vidsrc-embed.su/embed/tv/{id}/{season}-{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'embed-su': { name: '🔹 Embed.su', movieUrl: 'https://embed.su/embed/movie/{id}', tvUrl: 'https://embed.su/embed/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'moviesapi': { name: '🔹 MoviesAPI', movieUrl: 'https://moviesapi.club/movie/{id}', tvUrl: 'https://moviesapi.club/tv/{id}-{season}-{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'smashy-stream': { name: '🔹 Smashy Stream', movieUrl: 'https://embed.smashy.stream/movie/{id}', tvUrl: 'https://embed.smashy.stream/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'autoembed': { name: '🔹 AutoEmbed', movieUrl: 'https://player.autoembed.cc/embed/movie?tmdb_id={id}', tvUrl: 'https://player.autoembed.cc/embed/tv?tmdb_id={id}&s={season}&e={episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'vidsrc-legacy': { name: '🔹 VidSrc.to (Legacy)', movieUrl: 'https://vidsrc.to/embed/movie/{id}', tvUrl: 'https://vidsrc.to/embed/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'vidsrc-co': { name: '🔸 VidSrc.co', movieUrl: 'https://player.vidsrc.co/embed/movie/{id}', tvUrl: 'https://player.vidsrc.co/embed/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'vidsrc-wtf-api1': { name: '🔸 VidSrc.wtf API 1', movieUrl: 'https://www.vidsrc.wtf/api/1/movie?id={id}', tvUrl: 'https://www.vidsrc.wtf/api/1/tv/?id={id}&s={season}&e={episode}', downloadSupport: true, qualityOptions: ['auto', '720p', '480p'], cors: true },
    'vidplus-to': { name: '🔸 VidPlus', movieUrl: 'https://player.vidplus.to/embed/movie/{id}', tvUrl: 'https://player.vidplus.to/embed/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'vidsrc-cc-v3': { name: '🔸 VidSrc.cc v3', movieUrl: 'https://vidsrc.cc/v3/embed/movie/{id}', tvUrl: 'https://vidsrc.cc/v3/embed/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'flicky-host': { name: '🔸 Flicky', movieUrl: 'https://flicky.host/embed/movie/?id={id}', tvUrl: 'https://flicky.host/embed/tv/?id={id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'vidsrc-cc-v2': { name: '🔸 VidSrc.cc v2', movieUrl: 'https://vidsrc.cc/v2/embed/movie/{id}', tvUrl: 'https://vidsrc.cc/v2/embed/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'test-autoembed-cc': { name: '🔸 AutoEmbed Test', movieUrl: 'https://test.autoembed.cc/embed/movie/{id}', tvUrl: 'https://test.autoembed.cc/embed/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'rivestream-org': { name: '🔸 Rivestream', movieUrl: 'https://rivestream.org/embed?type=movie&id={id}', tvUrl: 'https://rivestream.org/embed?type=tv&id={id}', downloadSupport: false, qualityOptions: ['auto', '720p'], cors: true },
    'vidlink-pro': { name: '🔸 VidLink Pro', movieUrl: 'https://vidlink.pro/movie/{id}', tvUrl: 'https://vidlink.pro/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    '2embed-cc': { name: '🔸 2Embed', movieUrl: 'https://www.2embed.cc/embedmovie/{id}', tvUrl: 'https://www.2embed.cc/embedtv/{id}&s={season}&e={episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'vidsrc-xyz': { name: '🔸 VidSrc.xyz', movieUrl: 'https://vidsrc.xyz/embed/movie/{id}', tvUrl: 'https://vidsrc.xyz/embed/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'vidsrc-icu': { name: '🔸 VidSrc.icu', movieUrl: 'https://vidsrc.icu/embed/movie/{id}', tvUrl: 'https://vidsrc.icu/embed/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'vidmoly-to': { name: '🔸 VidMoly', movieUrl: 'https://vidmoly.to/embed-{id}.html', tvUrl: 'https://vidmoly.to/embed-{id}.html', downloadSupport: false, qualityOptions: ['auto', '720p'], cors: true },
    'vidlink-pro-color': { name: '🔸 VidLink Pro Color', movieUrl: 'https://vidlink.pro/movie/{id}?primaryColor=63b8bc', tvUrl: 'https://vidlink.pro/tv/{id}/{season}/{episode}?primaryColor=63b8bc', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'videasy-net': { name: '🔸 Videasy', movieUrl: 'https://player.videasy.net/movie/{id}', tvUrl: 'https://player.videasy.net/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'nontongo-win-alt': { name: '🔸 NontonGo Alt', movieUrl: 'https://www.nontongo.win/embed/movie/{id}', tvUrl: 'https://www.nontongo.win/embed/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'vidsrc-xyz-tmdb': { name: '🔸 VidSrc.xyz TMDB', movieUrl: 'https://vidsrc.xyz/embed/movie?tmdb={id}', tvUrl: 'https://vidsrc.xyz/embed/tv?tmdb={id}&season={season}&episode={episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'vidsrc-me': { name: '🔸 VidSrc.me', movieUrl: 'https://vidsrc.me/embed/movie/{id}', tvUrl: 'https://vidsrc.me/embed/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'vidzee-wtf': { name: '🔸 VidZee', movieUrl: 'https://player.vidzee.wtf/embed/movie/{id}', tvUrl: 'https://player.vidzee.wtf/embed/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'cineby-app': { name: '🔸 CineBy', movieUrl: 'https://www.cineby.app/movie/{id}', tvUrl: 'https://www.cineby.app/tv/{id}/{season}/{episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'smashystream-com': { name: '🔸 SmashyStream.com', movieUrl: 'https://embed.smashystream.com/playere.php?tmdb={id}', tvUrl: 'https://embed.smashystream.com/playere.php?tmdb={id}&season={season}&episode={episode}', downloadSupport: true, qualityOptions: ['1080p', '720p', '480p'], cors: true },
    'rapidshare-cc': { name: '🔸 RapidShare', movieUrl: 'https://rapidshare.cc/e/{id}', tvUrl: 'https://rapidshare.cc/e/{id}', downloadSupport: false, qualityOptions: ['auto', '720p'], cors: true },
    'streameeeeee-site': { name: '🔸 Streameeeeee', movieUrl: 'https://streameeeeee.site/embed-1/v3/e-1/{id}', tvUrl: 'https://streameeeeee.site/embed-1/v3/e-1/{id}', downloadSupport: false, qualityOptions: ['auto', '720p'], cors: true }
};


// FIX: Ensured default settings object is complete and matches user expectations.
export const DEFAULT_SETTINGS: Settings = {
    theme: 'dark',
    autoDarkMode: true,
    privacyMode: false,
    trackHistory: true,
    analyticsEnabled: false,
    autoPlay: true,
    defaultQuality: 'auto',
    vpnMode: false,
    adBlocker: true,
};
