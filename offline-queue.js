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

        const token = authToken || localStorage.getItem('token');
        if (!token) {
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
                    } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                        // Client error (e.g. invalid payload), discard to avoid clogging queue
                        await removeTransaction(record.idempotencyKey);
                    }
                } catch (netErr) {
                    console.warn('⚠️ [OfflineQueue] Network error during replay for', record.idempotencyKey, netErr.message);
                    break; // stop replay loop until next online event
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
