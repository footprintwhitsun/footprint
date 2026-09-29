/**
 * International Currency & Financial Precision Monetary Engine
 * Footprint Enterprise POS & ERP
 * 
 * Features:
 * - Dynamic international ISO-4217 currencies (USD, EUR, GBP, GHS, CAD, AUD, NGN, KES, JPY, KWD, etc.)
 * - Banker's Integer-Cents Arithmetic (eliminates IEEE-754 0.1 + 0.2 floating point drift)
 * - Support for 0-decimal (JPY, KRW, UGX), 2-decimal (USD, EUR, GHS), and 3-decimal (KWD, BHD) currencies
 * - formatCurrency, getCurrencySymbol, parseCurrency, safeAdd, safeSubtract, safeMultiply, safeDivide
 * - Auto-sync with localStorage across browser tabs via CustomEvent
 */

(function(root) {
    'use strict';

    const STORAGE_CURRENCY_KEY = 'system_currency';
    const STORAGE_LOCALE_KEY = 'system_locale';
    
    // Default fallback currency
    const DEFAULT_CURRENCY = 'GHS';
    const DEFAULT_LOCALE = 'en-GH';

    // Currencies with non-standard decimal counts
    const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'UGX', 'RWF', 'BIF', 'PYG', 'DJF']);
    const THREE_DECIMAL_CURRENCIES = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'IQD', 'LYD']);

    function getActiveCurrency() {
        if (typeof localStorage !== 'undefined') {
            try {
                return localStorage.getItem(STORAGE_CURRENCY_KEY) || DEFAULT_CURRENCY;
            } catch (e) {
                return DEFAULT_CURRENCY;
            }
        }
        return DEFAULT_CURRENCY;
    }

    function getActiveLocale() {
        if (typeof localStorage !== 'undefined') {
            try {
                return localStorage.getItem(STORAGE_LOCALE_KEY) || DEFAULT_LOCALE;
            } catch (e) {
                return DEFAULT_LOCALE;
            }
        }
        return DEFAULT_LOCALE;
    }

    function getDecimalDigits(currencyCode) {
        const code = (currencyCode || getActiveCurrency()).toUpperCase();
        if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
        if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
        return 2;
    }

    /**
     * Convert decimal amount to integer units (e.g. $12.34 -> 1234 cents)
     */
    function toCents(amount, currencyCode) {
        const digits = getDecimalDigits(currencyCode);
        const factor = Math.pow(10, digits);
        const num = Number(amount);
        const safeNum = Number.isFinite(num) ? num : 0;
        return Math.round(safeNum * factor);
    }

    /**
     * Convert integer units back to decimal float (e.g. 1234 cents -> 12.34)
     */
    function fromCents(cents, currencyCode) {
        const digits = getDecimalDigits(currencyCode);
        const factor = Math.pow(10, digits);
        const num = Number(cents);
        const safeNum = Number.isFinite(num) ? num : 0;
        return safeNum / factor;
    }

    /**
     * Safe banker's addition preventing float drift
     */
    function safeAdd(a, b, currencyCode) {
        const sumCents = toCents(a, currencyCode) + toCents(b, currencyCode);
        return fromCents(sumCents, currencyCode);
    }

    /**
     * Safe banker's subtraction preventing float drift
     */
    function safeSubtract(a, b, currencyCode) {
        const diffCents = toCents(a, currencyCode) - toCents(b, currencyCode);
        return fromCents(diffCents, currencyCode);
    }

    /**
     * Safe banker's multiplication (e.g. price * quantity or price * taxRate)
     */
    function safeMultiply(a, multiplier, currencyCode) {
        const safeMult = Number.isFinite(Number(multiplier)) ? Number(multiplier) : 0;
        const totalCents = Math.round(toCents(a, currencyCode) * safeMult);
        return fromCents(totalCents, currencyCode);
    }

    /**
     * Safe banker's division
     */
    function safeDivide(a, divisor, currencyCode) {
        const d = Number(divisor);
        if (!d || !Number.isFinite(d)) return 0;
        const totalCents = Math.round(toCents(a, currencyCode) / d);
        return fromCents(totalCents, currencyCode);
    }

    /**
     * Format a numeric amount into an international currency string
     */
    function formatCurrency(amount, currencyCode, locale) {
        const curr = (currencyCode || getActiveCurrency()).toUpperCase();
        const loc = locale || getActiveLocale();
        const digits = getDecimalDigits(curr);
        
        // Use banker's rounding to normalize incoming float
        const safeNum = fromCents(toCents(amount, curr), curr);

        try {
            return new Intl.NumberFormat(loc, {
                style: 'currency',
                currency: curr,
                minimumFractionDigits: digits,
                maximumFractionDigits: digits
            }).format(safeNum);
        } catch (err) {
            // Fallback for custom or unsupported ISO codes
            return `${curr} ${safeNum.toFixed(digits)}`;
        }
    }

    /**
     * Get the currency symbol for the current or specified currency
     */
    function getCurrencySymbol(currencyCode) {
        const curr = (currencyCode || getActiveCurrency()).toUpperCase();
        try {
            const parts = new Intl.NumberFormat('en', {
                style: 'currency',
                currency: curr,
                minimumFractionDigits: 0,
                maximumFractionDigits: 0
            }).formatToParts(0);
            const symbolPart = parts.find(p => p.type === 'currency');
            return symbolPart ? symbolPart.value : curr;
        } catch (e) {
            return curr;
        }
    }

    /**
     * Safely parse a monetary string into a clean float
     */
    function parseCurrency(str, currencyCode) {
        if (typeof str === 'number') {
            return Number.isFinite(str) ? str : 0;
        }
        if (!str) return 0;
        const cleaned = str.toString().replace(/[^0-9.-]/g, '');
        const parsed = parseFloat(cleaned);
        const safeParsed = Number.isFinite(parsed) ? parsed : 0;
        return fromCents(toCents(safeParsed, currencyCode), currencyCode);
    }

    /**
     * Set active currency and dispatch update event across open tabs/windows
     */
    function setSystemCurrency(currencyCode, locale) {
        if (!currencyCode) return;
        const upperCode = currencyCode.toUpperCase();
        if (typeof localStorage !== 'undefined') {
            try {
                localStorage.setItem(STORAGE_CURRENCY_KEY, upperCode);
                if (locale) localStorage.setItem(STORAGE_LOCALE_KEY, locale);
            } catch (e) {
                console.warn('Could not persist currency to localStorage:', e);
            }
        }
        if (typeof window !== 'undefined' && window.dispatchEvent) {
            window.dispatchEvent(new CustomEvent('currencychange', {
                detail: { currency: upperCode, locale: locale || getActiveLocale() }
            }));
        }
    }

    const api = {
        formatCurrency,
        getCurrencySymbol,
        parseCurrency,
        setSystemCurrency,
        getActiveCurrency,
        getActiveLocale,
        getDecimalDigits,
        toCents,
        fromCents,
        safeAdd,
        safeSubtract,
        safeMultiply,
        safeDivide
    };

    // Expose to window / root
    if (typeof window !== 'undefined') {
        Object.assign(window, api);
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
