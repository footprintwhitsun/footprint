/**
 * Lazy library loader. Heavy export-only libraries (Excel, PDF) are declared as
 * <script data-lazy-src="..."> and fetched in order after the page has finished
 * loading, so they never delay first paint or the layout/data boot.
 * If an export is clicked before they arrive, window.__libsReady resolves when done.
 */
(function () {
    'use strict';
    var queue = null;
    function load() {
        if (queue) return queue;
        var tags = Array.prototype.slice.call(document.querySelectorAll('script[data-lazy-src]'));
        queue = tags.reduce(function (chain, tag) {
            return chain.then(function () {
                return new Promise(function (resolve) {
                    var s = document.createElement('script');
                    s.src = tag.getAttribute('data-lazy-src');
                    if (tag.crossOrigin) s.crossOrigin = tag.crossOrigin;
                    s.onload = s.onerror = function () { resolve(); };
                    document.head.appendChild(s);
                });
            });
        }, Promise.resolve());
        return queue;
    }
    window.__libsReady = function () { return load(); };
    function start() {
        if ('requestIdleCallback' in window) requestIdleCallback(load, { timeout: 3000 });
        else setTimeout(load, 1500);
    }
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
})();
