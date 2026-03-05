import { AD_DOMAINS } from '../constants';

declare global {
  interface Window {
    puter: any;
  }
}

const isAdDomain = (url: string) => {
    try {
        const hostname = new URL(url).hostname;
        return AD_DOMAINS.some(adDomain => hostname.includes(adDomain));
    } catch (e) {
        return false;
    }
};

export const fetchWithAdBlock = async (
    url: string, 
    adBlockerEnabled: boolean,
    options?: RequestInit
): Promise<Response> => {
    if (adBlockerEnabled && isAdDomain(url)) {
        console.log(`[AdBlocker] Blocked request to: ${url}`);
        return new Response(null, { status: 204, statusText: "Blocked by Parha AdBlocker" });
    }
    
    // Use puter.js for CORS if available, otherwise fallback to standard fetch
    if (window.puter && window.puter.net && window.puter.net.fetch) {
        return window.puter.net.fetch(url, options);
    }
    
    return fetch(url, options);
};
