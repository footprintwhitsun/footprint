/**
 * OfflineQueue - IndexedDB Transaction & Catalog Resilience Engine
 * Footprint Enterprise POS
 * 
 * Features:
 * - Persistent IndexedDB store for offline checkouts
 * - UUIDv4 Idempotency Key protection ensuring zero duplicate charges
 * - Automatic background replay synchronization upon connection recovery
 * - Offline product catalog cache for instant barcode lookup without network
 */

(function(window) {
    'use strict';

    if (typeof window === 'undefined') return;

    const DB_NAME = 'footprint_pos_offline_db';
    const DB_VERSION = 1;
    const TX_STORE = 'offline_transactions';
    const CATALOG_STORE = 'cached_catalog';

    let dbPromise = null;

    function openDb() {
        if (dbPromise) return dbPromise;

        dbPromise = new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) {
                return reject(new Error('IndexedDB not supported in this environment'));
            }

            const req = indexedDB.open(DB_NAME, DB_VERSION);

            req.onupgradeneeded = function(e) {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(TX_STORE)) {
                    const txStore = db.createObjectStore(TX_STORE, { keyPath: 'idempotencyKey' });
                    txStore.createIndex('createdAt', 'createdAt', { unique: false });
                    txStore.createIndex('status', 'status', { unique: false });
                }
                if (!db.objectStoreNames.contains(CATALOG_STORE)) {
                    const catStore = db.createObjectStore(CATALOG_STORE, { keyPath: 'barcode' });
                    catStore.createIndex('name', 'name', { unique: false });
                }
            };

            req.onsuccess = function(e) {
                resolve(e.target.result);
            };

            req.onerror = function(e) {
                reject(e.target.error);
            };
        });

        return dbPromise;
    }

    function generateUUID() {
        if (crypto && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /**
     * Store transaction locally in IndexedDB when offline
     */
    async function enqueueTransaction(transactionData) {
        const db = await openDb();
        const idempotencyKey = transactionData.idempotencyKey || generateUUID();
        const offlineReceipt = 'OFF-' + Date.now();

        const record = {
            idempotencyKey,
            receiptNumber: offlineReceipt,
            data: transactionData,
            createdAt: new Date().toISOString(),
            status: 'pending',
            retries: 0
        };

        return new Promise((resolve, reject) => {
            const tx = db.transaction(TX_STORE, 'readwrite');
            const store = tx.objectStore(TX_STORE);
            store.put(record);

            tx.oncomplete = () => {
                console.log('📦 [OfflineQueue] Enqueued transaction locally:', idempotencyKey, offlineReceipt);
                resolve({
                    success: true,
                    offline: true,
                    idempotencyKey,
                    receiptNumber: offlineReceipt,
                    transactionId: 'offline_' + idempotencyKey
                });
            };

            tx.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Retrieve all pending offline transactions
     */
    async function getPendingTransactions() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(TX_STORE, 'readonly');
            const store = tx.objectStore(TX_STORE);
            const req = store.getAll();

            req.onsuccess = () => {
                const pending = (req.result || []).filter(r => r.status === 'pending');
                resolve(pending);
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Delete or mark synced transaction
     */
    async function removeTransaction(idempotencyKey) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(TX_STORE, 'readwrite');
            const store = tx.objectStore(TX_STORE);
            store.delete(idempotencyKey);
            tx.oncomplete = () => resolve(true);
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Sync all pending transactions to the backend
     */
    let isSyncing = false;

    async function syncOfflineQueue(authToken) {
        if (isSyncing || !navigator.onLine) return;
        isSyncing = true;

        // Pages store the session under different keys, so look for all of them.
        const token = authToken || localStorage.getItem('authToken')
            || localStorage.getItem('token')
            || localStorage.getItem('companyToken');
        if (!token) {
            console.warn('[OfflineQueue] No session token found; queued sales stay pending.');
            isSyncing = false;
            return;
        }

        try {
            const pending = await getPendingTransactions();
            if (!pending.length) {
                isSyncing = false;
                return;
            }

            console.log(`🔄 [OfflineQueue] Syncing ${pending.length} pending offline transactions...`);
            if (window.showToast) {
                window.showToast(`Syncing ${pending.length} offline transactions...`, 'info', 2500);
            }

            for (const record of pending) {
                try {
                    const res = await fetch('/api/transactions', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`,
                            'X-Idempotency-Key': record.idempotencyKey
                        },
                        body: JSON.stringify({
                            ...record.data,
                            idempotencyKey: record.idempotencyKey
                        })
                    });

                    if (res.ok || res.status === 409) {
                        // 200 OK or 409 Conflict (already recorded)
                        await removeTransaction(record.idempotencyKey);
                        console.log('✅ [OfflineQueue] Synced & cleared transaction:', record.idempotencyKey);
                    } else if (res.status === 401 || res.status === 403) {
                        // Expired session is not a bad sale. Keep it and retry after login,
                        // otherwise the record would be destroyed without ever reaching the
                        // server.
                        await markAttempt(record, 'authentication required');
                    } else if (res.status >= 400 && res.status < 500) {
                        // Rejected payload — retrying cannot help, but keep it visible so the
                        // cashier can re-enter the sale rather than losing it silently.
                        await markAttempt(record, `server rejected payload (${res.status})`);
                    } else {
                        await markAttempt(record, `server error (${res.status})`);
                    }
                } catch (netErr) {
                    console.warn('⚠️ [OfflineQueue] Network error during replay for', record.idempotencyKey, netErr.message);
                    if (!navigator.onLine) break; // rest of the replay would fail too
                    await markAttempt(record, 'network error');
                }
            }

            const remaining = await getPendingTransactions();
            if (remaining.length === 0 && window.showToast) {
                window.showToast('All offline transactions synced successfully!', 'success', 3000);
            }
        } catch (e) {
            console.error('❌ [OfflineQueue] Sync failed:', e);
        } finally {
            isSyncing = false;
        }
    }

    /**
     * Count an unsuccessful replay. Records that keep failing are parked as 'failed' so they
     * drop out of getPendingTransactions instead of being retried on every online event, and
     * so the cashier can still see them rather than losing the sale silently.
     */
    async function markAttempt(record, reason) {
        const db = await openDb();
        const attempts = (record.retries || 0) + 1;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(TX_STORE, 'readwrite');
            const store = tx.objectStore(TX_STORE);
            store.put({
                ...record,
                retries: attempts,
                lastError: reason,
                status: attempts >= 8 ? 'failed' : 'pending'
            });
            tx.oncomplete = () => resolve(attempts);
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Cache product catalog for offline barcode scanning
     */
    async function cacheProducts(products) {
        if (!Array.isArray(products) || !products.length) return;
        try {
            const db = await openDb();
            const tx = db.transaction(CATALOG_STORE, 'readwrite');
            const store = tx.objectStore(CATALOG_STORE);
            for (const p of products) {
                if (p.barcode) store.put(p);
            }
        } catch (e) {
            console.warn('Could not cache products in IndexedDB:', e);
        }
    }

    /**
     * Lookup a product offline by barcode
     */
    async function getCachedProduct(barcode) {
        if (!barcode) return null;
        try {
            const db = await openDb();
            return new Promise((resolve) => {
                const tx = db.transaction(CATALOG_STORE, 'readonly');
                const store = tx.objectStore(CATALOG_STORE);
                const req = store.get(barcode);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
        } catch (e) {
            return null;
        }
    }

    // Auto-sync on connection recovery
    window.addEventListener('online', () => {
        setTimeout(() => syncOfflineQueue(), 1200);
    });

    // 'online' only fires when connectivity *changes*. A cashier who reloads the page while
    // already online would otherwise leave queued sales stranded in IndexedDB forever.
    if (navigator.onLine) {
        window.addEventListener('load', () => setTimeout(() => syncOfflineQueue(), 1500));
    }

    // Expose API
    window.OfflineQueue = {
        enqueueTransaction,
        getPendingTransactions,
        syncOfflineQueue,
        cacheProducts,
        getCachedProduct,
        generateUUID
    };

})(typeof window !== 'undefined' ? window : this);
