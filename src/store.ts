// IndexedDB 永続化: 塗りかけ作品 (works, 線画 ID キー) と完成作品 (gallery, 自動採番)、
// カスタム下絵 (templates)、カテゴリー (categories)、下絵ごとのメタ (artmeta)、
// 主役の切り抜き結果 (cutouts)、レベルの自動判定結果 (levels)。
//
// 【重要・マイグレーション方針】onupgradeneeded は「無ければ作る」だけ。既存ストア
// (works/gallery/templates) は絶対に作り直さない・消さない。これによりカスタム下絵は
// アプリのバージョンアップ (DB_VERSION 引き上げ) をまたいでも保持される。

import { DEFAULT_CATEGORIES, type Category } from "./categories";
// 型だけの import なのでビルド後には消える（level.ts → store.ts の実行時の循環は無い）
import type { Level } from "./level";

const DB_NAME = "dino-coloring";
const DB_VERSION = 5;

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

/** 下絵から切り出した主役 1 体ぶん。マスクはアルファだけの PNG data URL で持つ。 */
export interface CutoutSubject {
  maskUrl: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

/**
 * 下絵ごとの主役切り抜き結果のキャッシュ。抽出は数百 ms かかるうえ、下絵が同じなら
 * 結果も同じなので一度だけ計算して使い回す。version は抽出アルゴリズムの版で、
 * 上げると古いキャッシュを無視して再計算する。
 */
export interface Cutout {
  id: string;
  version: number;
  subjects: CutoutSubject[];
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
  /** レベルの上書き。null / undefined は自動判定（levels ストア）を使う */
  level?: Level | null;
}

/**
 * 下絵ごとのレベル自動判定の結果。判定は下絵だけで決まるので一度計算して使い回す。
 * version は判定アルゴリズムの版で、上げると古いキャッシュを無視して計算し直す。
 */
export interface ArtLevel {
  id: string;
  version: number;
  level: Level;
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
      if (!db.objectStoreNames.contains("cutouts")) {
        db.createObjectStore("cutouts", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("levels")) {
        db.createObjectStore("levels", { keyPath: "id" });
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

export async function deleteGalleryItems(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDB();
  const tx = db.transaction("gallery", "readwrite");
  const os = tx.objectStore("gallery");
  for (const id of ids) os.delete(id);
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
  // 下絵と、それに紐づく塗りかけ (works)・メタ (artmeta)・切り抜き (cutouts)・
  // レベル (levels) をまとめて削除
  const tx = db.transaction(["templates", "works", "artmeta", "cutouts", "levels"], "readwrite");
  tx.objectStore("templates").delete(id);
  tx.objectStore("works").delete(id);
  tx.objectStore("artmeta").delete(id);
  tx.objectStore("cutouts").delete(id);
  tx.objectStore("levels").delete(id);
  await txDone(tx);
}

// ---------------------------------------------------------------- cutouts

export async function getCutout(id: string): Promise<Cutout | undefined> {
  const db = await openDB();
  return reqResult(db.transaction("cutouts").objectStore("cutouts").get(id));
}

export async function saveCutout(cutout: Cutout): Promise<void> {
  const db = await openDB();
  const tx = db.transaction("cutouts", "readwrite");
  tx.objectStore("cutouts").put(cutout);
  await txDone(tx);
}

// ---------------------------------------------------------------- levels

export async function getArtLevels(): Promise<Map<string, ArtLevel>> {
  const db = await openDB();
  const items = (await reqResult(
    db.transaction("levels").objectStore("levels").getAll()
  )) as ArtLevel[];
  return new Map(items.map((l) => [l.id, l]));
}

/** 判定結果をまとめて保存する（初回は数十件になるので 1 トランザクションで書く）。 */
export async function saveArtLevels(records: ArtLevel[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openDB();
  const tx = db.transaction("levels", "readwrite");
  const os = tx.objectStore("levels");
  for (const r of records) os.put(r);
  await txDone(tx);
}

// ---------------------------------------------------------------- categories

// 既定カテゴリーのうち「一度シード（追加）した」id を localStorage に記録する。
// これにより、アプリ更新で既定に増えたカテゴリーは既存ユーザーにも一度だけ追加しつつ、
// 利用者が自分で消した既定カテゴリーを次回起動で復活させてしまうのを防ぐ。
const SEEDED_CATS_KEY = "dino-coloring:seeded-default-cats";

function loadSeededCatIds(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(SEEDED_CATS_KEY) ?? "[]");
    return new Set(Array.isArray(arr) ? (arr as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveSeededCatIds(ids: Iterable<string>) {
  try {
    localStorage.setItem(SEEDED_CATS_KEY, JSON.stringify([...ids]));
  } catch {
    // 保存できなくても致命的ではない（次回また追加を試みるだけ）
  }
}

/**
 * カテゴリー一覧（order 昇順）。
 * 初回は既定を全件シード。以降のアプリ更新で既定に増えたカテゴリーも、まだ一度も
 * シードしていなければ一度だけ追加する（利用者が消した既定は復活させない）。
 */
export async function getCategories(): Promise<Category[]> {
  const db = await openDB();
  let items = (await reqResult(
    db.transaction("categories").objectStore("categories").getAll()
  )) as Category[];

  const firstRun = items.length === 0;
  const seeded = loadSeededCatIds();
  const existingIds = new Set(items.map((c) => c.id));
  // 初回は全件、それ以降は「DB に無く かつ まだシードしていない」既定だけを追加する。
  const toAdd = DEFAULT_CATEGORIES.filter(
    (c) => !existingIds.has(c.id) && (firstRun || !seeded.has(c.id))
  );
  if (toAdd.length > 0) {
    const tx = db.transaction("categories", "readwrite");
    const os = tx.objectStore("categories");
    for (const c of toAdd) os.put(c);
    await txDone(tx);
    items = items.concat(toAdd);
  }
  // 既定カテゴリーはすべて「シード済み」として記録し、以後は復活させない。
  saveSeededCatIds(new Set([...seeded, ...DEFAULT_CATEGORIES.map((c) => c.id)]));

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

/** レベルの上書き。null で自動判定に戻す。 */
export function setArtLevel(id: string, level: Level | null): Promise<void> {
  return upsertArtMeta(id, { level });
}

export async function deleteArtMeta(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction("artmeta", "readwrite");
  tx.objectStore("artmeta").delete(id);
  await txDone(tx);
}
