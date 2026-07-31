// ぬりえのレベル（1=かんたん / 2=ふつう / 3=むずかしい）のブラウザ側。
//
// 判定アルゴリズムそのものは level-core.ts にある（DOM 非依存。CLI と共有）。
// ここは canvas から画素を読む部分と、結果のキャッシュだけを持つ。
//
// レベルの決まり方は 3 段構え:
//   1. 大人が手で決めた上書き（artmeta）… 常に最優先（main.ts）
//   2. 下絵に焼き込まれたレベル（art.level）… 共有下絵は index.json、組み込みは
//      catalog、アップロード画像は取り込み時に 1 回判定して templates に保存済み。
//      どの端末でも同じ値になり、実行時の計算は要らない
//   3. どちらも無い下絵だけ、この場で判定して IndexedDB にキャッシュする。
//      本アプリ更新より前にアップロードされた画像の救済用
//
// 縮小をブラウザ任せにしない理由は level-core.ts の downscaleAlpha を参照。

import { CANVAS_W, CANVAS_H, loadLineArtImage, type LineArt } from "./lineart";
import { levelFromAlpha, type Level } from "./level-core";
import * as store from "./store";

export {
  LEVELS,
  LEVEL_MARK,
  LEVEL_NAME,
  estimateLevel,
  levelFromAlpha,
  lineAlpha,
  type Level,
} from "./level-core";

/** 判定アルゴリズムの版。しきい値や手順を変えたら上げる（古いキャッシュを捨てる）。 */
const LEVEL_VERSION = 3;

/** 読めない下絵など、判定できないときのレベル。 */
const FALLBACK_LEVEL: Level = 2;

/** 判定用の canvas。下絵ごとに作らず使い回す（1024x768 を何枚も作らないため）。 */
let analyzeCtx: CanvasRenderingContext2D | null = null;

function getAnalyzeCtx(): CanvasRenderingContext2D {
  if (!analyzeCtx) {
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    analyzeCtx = canvas.getContext("2d", { willReadFrequently: true })!;
  }
  return analyzeCtx;
}

/**
 * 透明化済みの下絵画像からレベルを判定する（キャッシュを使わない実処理）。
 * アップロード直後の取り込みでも使う。
 */
export function levelFromImage(img: HTMLImageElement): Level {
  const ctx = getAnalyzeCtx();
  // canvas を使い回すので前の下絵を消す（下絵は透明部分があり、消さないと重なる）
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  // 等倍で描く（縮小フィルターを通さない）。組み込み SVG も共有下絵も 1024x768。
  ctx.drawImage(img, 0, 0, CANVAS_W, CANVAS_H);
  const data = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H).data;
  const alpha = new Uint8Array(CANVAS_W * CANVAS_H);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
  return levelFromAlpha(alpha, CANVAS_W, CANVAS_H);
}

/** 下絵 1 点を読み込んで判定する。 */
async function computeLevel(art: LineArt): Promise<Level> {
  return levelFromImage(await loadLineArtImage(art));
}

/**
 * 下絵ごとの自動判定レベルを返す。焼き込み済み（art.level）はそのまま使い、キャッシュが
 * あればそれを使い、どちらも無いものだけ判定してまとめて保存する。判定に失敗した下絵は
 * 保存せず「ふつう」として返す（次回やり直す）。
 */
export async function getAutoLevels(arts: LineArt[]): Promise<Map<string, Level>> {
  const levels = new Map<string, Level>();
  // 焼き込み済みで全部そろっていれば IndexedDB を開かずに済む
  const needs = arts.filter((a) => {
    if (a.level) {
      levels.set(a.id, a.level);
      return false;
    }
    return true;
  });
  if (needs.length === 0) return levels;

  const cached = await store.getArtLevels().catch(() => new Map<string, store.ArtLevel>());
  const fresh: store.ArtLevel[] = [];
  for (const art of needs) {
    const hit = cached.get(art.id);
    if (hit && hit.version === LEVEL_VERSION) {
      levels.set(art.id, hit.level);
      continue;
    }
    try {
      const level = await computeLevel(art);
      levels.set(art.id, level);
      fresh.push({ id: art.id, version: LEVEL_VERSION, level });
    } catch {
      levels.set(art.id, FALLBACK_LEVEL);
    }
  }

  if (fresh.length > 0) await store.saveArtLevels(fresh).catch(() => {});
  return levels;
}
