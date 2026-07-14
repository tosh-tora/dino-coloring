// IndexedDB 永続化: 塗りかけ作品 (works, 線画 ID キー) と完成作品 (gallery, 自動採番)

const DB_NAME = "dino-coloring";
const DB_VERSION = 1;

export interface Work {
  lineartId: string;
  dataUrl: string;
  updatedAt: number;
}

export interface GalleryItem {
  id?: number;
  lineartId: string;
  dataUrl: string;
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("works")) {
        db.createObjectStore("works", { keyPath: "lineartId" });
      }
      if (!db.objectStoreNames.contains("gallery")) {
        db.createObjectStore("gallery", { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveWork(work: Work): Promise<void> {
  const db = await openDB();
  const tx = db.transaction("works", "readwrite");
  tx.objectStore("works").put(work);
  await txDone(tx);
}

export async function getWork(lineartId: string): Promise<Work | undefined> {
  const db = await openDB();
  return reqResult(db.transaction("works").objectStore("works").get(lineartId));
}

export async function getWorkIds(): Promise<Set<string>> {
  const db = await openDB();
  const keys = await reqResult(db.transaction("works").objectStore("works").getAllKeys());
  return new Set(keys as string[]);
}

export async function deleteWork(lineartId: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction("works", "readwrite");
  tx.objectStore("works").delete(lineartId);
  await txDone(tx);
}

export async function addGalleryItem(item: GalleryItem): Promise<void> {
  const db = await openDB();
  const tx = db.transaction("gallery", "readwrite");
  tx.objectStore("gallery").add(item);
  await txDone(tx);
}

export async function getGallery(): Promise<GalleryItem[]> {
  const db = await openDB();
  const items = await reqResult(db.transaction("gallery").objectStore("gallery").getAll());
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteGalleryItem(id: number): Promise<void> {
  const db = await openDB();
  const tx = db.transaction("gallery", "readwrite");
  tx.objectStore("gallery").delete(id);
  await txDone(tx);
}
