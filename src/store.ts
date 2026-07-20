// IndexedDB 永続化: 塗りかけ作品 (works, 線画 ID キー) と完成作品 (gallery, 自動採番)、
// カスタム下絵 (templates)、カテゴリー (categories)、下絵ごとのメタ (artmeta)。
//
// 【重要・マイグレーション方針】onupgradeneeded は「無ければ作る」だけ。既存ストア
// (works/gallery/templates) は絶対に作り直さない・消さない。これによりカスタム下絵は
// アプリのバージョンアップ (DB_VERSION 引き上げ) をまたいでも保持される。

import { DEFAULT_CATEGORIES, type Category } from "./categories";

const DB_NAME = "dino-coloring";
const DB_VERSION = 3;

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

export interface CustomTemplate {
  id: string;
  name: string;
  /** 透明化済み下絵画像の data URL */
  imageUrl: string;
  createdAt: number;
}

/** 下絵ごとの上書きメタ（組み込み・共有・ローカル共通、id は各下絵の id）。 */
export interface ArtMeta {
  id: string;
  /** カテゴリー上書き。null は「みぶんるい」に明示上書き、undefined レコード無し=既定を使う */
  categoryId: string | null;
  /** ライブラリーで非表示にするか（組み込み・共有下絵の「削除」相当） */
  hidden: boolean;
  /** 名前の上書き。null / undefined は既定の名前を使う */
  name?: string | null;
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
      if (!db.objectStoreNames.contains("templates")) {
        db.createObjectStore("templates", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("categories")) {
        db.createObjectStore("categories", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("artmeta")) {
        db.createObjectStore("artmeta", { keyPath: "id" });
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

export async function addTemplate(t: CustomTemplate): Promise<void> {
  const db = await openDB();
  const tx = db.transaction("templates", "readwrite");
  tx.objectStore("templates").put(t);
  await txDone(tx);
}

export async function getTemplates(): Promise<CustomTemplate[]> {
  const db = await openDB();
  const items = await reqResult(db.transaction("templates").objectStore("templates").getAll());
  return (items as CustomTemplate[]).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteTemplate(id: string): Promise<void> {
  const db = await openDB();
  // 下絵と、それに紐づく塗りかけ (works)・メタ (artmeta) をまとめて削除する
  const tx = db.transaction(["templates", "works", "artmeta"], "readwrite");
  tx.objectStore("templates").delete(id);
  tx.objectStore("works").delete(id);
  tx.objectStore("artmeta").delete(id);
  await txDone(tx);
}

// ---------------------------------------------------------------- categories

/** カテゴリー一覧（order 昇順）。空なら既定をシードして返す。 */
export async function getCategories(): Promise<Category[]> {
  const db = await openDB();
  const items = (await reqResult(
    db.transaction("categories").objectStore("categories").getAll()
  )) as Category[];
  if (items.length === 0) {
    const tx = db.transaction("categories", "readwrite");
    const os = tx.objectStore("categories");
    for (const c of DEFAULT_CATEGORIES) os.put(c);
    await txDone(tx);
    return [...DEFAULT_CATEGORIES];
  }
  return items.sort((a, b) => a.order - b.order);
}

export async function addCategory(name: string): Promise<Category> {
  const db = await openDB();
  const existing = await getCategories();
  const maxOrder = existing.reduce((m, c) => Math.max(m, c.order), -1);
  const cat: Category = { id: "cat-" + Date.now(), name, order: maxOrder + 1 };
  const tx = db.transaction("categories", "readwrite");
  tx.objectStore("categories").put(cat);
  await txDone(tx);
  return cat;
}

export async function renameCategory(id: string, name: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction("categories", "readwrite");
  const os = tx.objectStore("categories");
  const cat = (await reqResult(os.get(id))) as Category | undefined;
  if (cat) os.put({ ...cat, name });
  await txDone(tx);
}

export async function deleteCategory(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction("categories", "readwrite");
  tx.objectStore("categories").delete(id);
  await txDone(tx);
}

// ---------------------------------------------------------------- artmeta

export async function getArtMeta(): Promise<Map<string, ArtMeta>> {
  const db = await openDB();
  const items = (await reqResult(
    db.transaction("artmeta").objectStore("artmeta").getAll()
  )) as ArtMeta[];
  return new Map(items.map((m) => [m.id, m]));
}

/** id のメタを部分更新（upsert・既存とマージ）。 */
async function upsertArtMeta(id: string, patch: Partial<Omit<ArtMeta, "id">>): Promise<void> {
  const db = await openDB();
  const tx = db.transaction("artmeta", "readwrite");
  const os = tx.objectStore("artmeta");
  const cur = (await reqResult(os.get(id))) as ArtMeta | undefined;
  const next: ArtMeta = { id, categoryId: null, hidden: false, ...cur, ...patch };
  os.put(next);
  await txDone(tx);
}

export function setArtCategory(id: string, categoryId: string | null): Promise<void> {
  return upsertArtMeta(id, { categoryId });
}

export function setArtHidden(id: string, hidden: boolean): Promise<void> {
  return upsertArtMeta(id, { hidden });
}

/** 名前の上書き。null で既定の名前に戻す。 */
export function setArtName(id: string, name: string | null): Promise<void> {
  return upsertArtMeta(id, { name });
}

export async function deleteArtMeta(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction("artmeta", "readwrite");
  tx.objectStore("artmeta").delete(id);
  await txDone(tx);
}
