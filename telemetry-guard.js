/**
 * TelemetryGuard - Enterprise Error Boundary & Toast Notification Engine
 * Footprint Enterprise POS
 * 
 * Features:
 * - Centralized unhandled error and promise rejection telemetry
 * - Sleek glassmorphic toast notifications (showToast) replacing intrusive browser alerts
 * - Network status detection and auto-recovery notifications
 */

(function(window) {
    'use strict';

    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    // 1. Telemetry & Error Boundary
    window.addEventListener('error', function(event) {
        console.warn('🛡️ [TelemetryGuard] Caught Unhandled Error:', event.message, 'at', event.filename, ':', event.lineno);
        // Prevent silent failure: log trace
    });

    window.addEventListener('unhandledrejection', function(event) {
        console.warn('🛡️ [TelemetryGuard] Caught Unhandled Promise Rejection:', event.reason);
    });

    // 2. Toast UI Container
    let toastContainer = null;

    function getOrCreateToastContainer() {
        if (toastContainer && document.body.contains(toastContainer)) return toastContainer;
        
        toastContainer = document.createElement('div');
        toastContainer.id = 'telemetry-toast-container';
        toastContainer.style.cssText = `
            position: fixed;
            top: 24px;
            right: 24px;
            z-index: 999999;
            display: flex;
            flex-direction: column;
            gap: 10px;
            pointer-events: none;
            max-width: 400px;
            width: calc(100vw - 48px);
            font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        `;
        document.body.appendChild(toastContainer);
        return toastContainer;
    }

    /**
     * Display a modern non-blocking glassmorphic toast
     * @param {string} message
     * @param {'success'|'error'|'warning'|'info'} [type='info']
     * @param {number} [duration=3500]
     */
    function showToast(message, type = 'info', duration = 3500) {
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', () => showToast(message, type, duration));
            return;
        }

        const container = getOrCreateToastContainer();
        const toast = document.createElement('div');
        toast.className = `toast-item toast-${type}`;
        
        // Colors & Icons
        let bgGradient, borderColor, iconSvg, iconColor;
        switch (type) {
            case 'success':
                bgGradient = 'linear-gradient(135deg, rgba(16, 185, 129, 0.95), rgba(5, 150, 105, 0.95))';
                borderColor = 'rgba(52, 211, 153, 0.4)';
                iconSvg = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>';
                iconColor = '#ffffff';
                break;
            case 'error':
                bgGradient = 'linear-gradient(135deg, rgba(239, 68, 68, 0.95), rgba(220, 38, 38, 0.95))';
                borderColor = 'rgba(248, 113, 113, 0.4)';
                iconSvg = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>';
                iconColor = '#ffffff';
                break;
            case 'warning':
                bgGradient = 'linear-gradient(135deg, rgba(245, 158, 11, 0.95), rgba(217, 119, 6, 0.95))';
                borderColor = 'rgba(251, 191, 36, 0.4)';
                iconSvg = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>';
                iconColor = '#ffffff';
                break;
            default: // info
                bgGradient = 'linear-gradient(135deg, rgba(37, 99, 235, 0.95), rgba(29, 78, 216, 0.95))';
                borderColor = 'rgba(96, 165, 250, 0.4)';
                iconSvg = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>';
                iconColor = '#ffffff';
        }

        toast.style.cssText = `
            background: ${bgGradient};
            border: 1px solid ${borderColor};
            color: #ffffff;
            padding: 12px 18px;
            border-radius: 12px;
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.25), 0 8px 10px -6px rgba(0, 0, 0, 0.15);
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 13.5px;
            font-weight: 500;
            line-height: 1.4;
            backdrop-filter: blur(8px);
            pointer-events: auto;
            opacity: 0;
            transform: translateY(-12px) scale(0.97);
            transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1), transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        `;

        toast.innerHTML = `
            <svg style="width: 20px; height: 20px; flex-shrink: 0; stroke: ${iconColor}; fill: none;" viewBox="0 0 24 24">
                ${iconSvg}
            </svg>
            <span style="flex: 1;">${message}</span>
        `;

        container.appendChild(toast);

        // Force reflow for entrance transition
        toast.offsetHeight;
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0) scale(1)';

        // Auto dismiss
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-12px) scale(0.97)';
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 250);
        }, duration);
    }

    // 3. Network Status Telemetry
    window.addEventListener('online', () => {
        showToast('Internet connection restored. Syncing operational data...', 'success', 3000);
    });

    window.addEventListener('offline', () => {
        showToast('Network offline. Terminal operating in local resilient mode.', 'warning', 4500);
    });

    // Expose globally
    window.showToast = showToast;
    // Provide non-intrusive fallback alias for code using notify()
    if (!window.notify) {
        window.notify = showToast;
    }

})(typeof window !== 'undefined' ? window : this);
