import type { PageTranslation } from '../shared/types';

const DB_NAME = 'manga-translator';
const STORE = 'pages';
const MAX_ENTRIES = 2000;

interface Entry {
  key: string;
  value: PageTranslation;
  lastUsed: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('lastUsed', 'lastUsed');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheGet(key: string): Promise<PageTranslation | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const entry = (await request(store.get(key))) as Entry | undefined;
  if (entry) store.put({ ...entry, lastUsed: Date.now() });
  await done(tx);
  return entry?.value;
}

export async function cachePut(key: string, value: PageTranslation): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  store.put({ key, value, lastUsed: Date.now() } satisfies Entry);
  const count = await request(store.count());
  if (count > MAX_ENTRIES) {
    // Evict the least recently used entries.
    let toDelete = count - MAX_ENTRIES;
    const cursorReq = store.index('lastUsed').openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor && toDelete-- > 0) {
        cursor.delete();
        cursor.continue();
      }
    };
  }
  await done(tx);
}

export async function cacheCount(): Promise<number> {
  const db = await openDb();
  return request(db.transaction(STORE).objectStore(STORE).count());
}

export async function cacheClear(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await done(tx);
}
