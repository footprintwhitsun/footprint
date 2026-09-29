/**
 * InstantNav - Speculative Navigation Prefetch Engine
 * Footprint Enterprise POS
 * 
 * Provides 0ms perceived page transitions across multi-page HTML architecture.
 * Speculatively prefetches destination pages on link hover / touchstart.
 */

(function() {
    'use strict';

    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const prefetchedUrls = new Set();
    const isSupported = 'fetch' in window;

    function shouldPrefetch(anchor) {
        if (!anchor || anchor.tagName !== 'A') return false;
        const href = anchor.getAttribute('href');
        if (!href) return false;

        // Skip non-HTML / hash / external / action links
        if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return false;
        if (anchor.target && anchor.target !== '_self') return false;
        if (anchor.hasAttribute('download')) return false;
        
        // Skip logout and API routes
        if (href.includes('logout') || href.includes('/api/')) return false;

        try {
            const url = new URL(href, window.location.href);
            // Only same-origin
            if (url.origin !== window.location.origin) return false;
            // Don't prefetch current page
            if (url.pathname === window.location.pathname) return false;
            // Avoid duplicates
            if (prefetchedUrls.has(url.pathname)) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    function prefetchUrl(anchor) {
        if (!shouldPrefetch(anchor)) return;

        try {
            const url = new URL(anchor.getAttribute('href'), window.location.href);
            prefetchedUrls.add(url.pathname);

            // Use rel=prefetch link if supported, else fallback to low-priority fetch
            const link = document.createElement('link');
            link.rel = 'prefetch';
            link.href = url.href;
            link.as = 'document';
            document.head.appendChild(link);
        } catch (e) {
            // Silently ignore prefetch errors
        }
    }

    let prefetchTimeout = null;

    function onPointerEnter(e) {
        const anchor = e.target.closest('a');
        if (!anchor) return;
        // Debounce 65ms to avoid spamming on rapid cursor movement
        clearTimeout(prefetchTimeout);
        prefetchTimeout = setTimeout(() => {
            prefetchUrl(anchor);
        }, 65);
    }

    function onTouchStart(e) {
        const anchor = e.target.closest('a');
        if (!anchor) return;
        prefetchUrl(anchor);
    }

    function init() {
        if (!isSupported) return;
        document.addEventListener('mouseover', onPointerEnter, { passive: true });
        document.addEventListener('touchstart', onTouchStart, { passive: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.__instantNav = { prefetchedUrls };
})();
