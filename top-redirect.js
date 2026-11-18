/**
 * Sends the whole browser window (not just the frame this page was loaded into) to a same-site path.
 * Used by the server when an embedded page needs the login screen: <script src="/top-redirect.js" data-target="/login">.
 * Kept as a file so the page needs no inline script under a strict Content-Security-Policy.
 */
(function () {
    var el = document.currentScript;
    var target = el && el.getAttribute('data-target');
    // same-site paths only: "/x" yes, "//evil.com" and "https://..." no
    if (typeof target === 'string' && target.charAt(0) === '/' && target.charAt(1) !== '/' && target.indexOf('\\') === -1) {
        (window.top || window).location.replace(target);
    }
})();
