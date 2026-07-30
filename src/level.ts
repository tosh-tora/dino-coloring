// ぬりえのレベル（1=かんたん / 2=ふつう / 3=むずかしい）の自動判定。
//
// 判定は下絵を 256x192 に縮小したアルファ（＝線の濃さ）だけで行う軽い方法:
//   - 塗る領域の数: 線でない画素の連結成分の数（小さすぎるものは数えない）
//   - 線の密度    : 線の画素の割合
// 領域が多いほど塗り分けが大変で、細い線が詰まっているほど（＝縮小しても密度が高い）
// はみ出さずに塗るのが難しい。ふたつの見立ての「難しい方」を採る。
//
// 結果は下絵 id ごとに IndexedDB へキャッシュする（下絵が同じなら結果も同じ）。
// 大人が手で決めた上書きは artmeta 側にあり、そちらが優先される（main.ts）。

import { loadLineArtImage, type LineArt } from "./lineart";
import * as store from "./store";

export type Level = 1 | 2 | 3;

export const LEVELS: Level[] = [1, 2, 3];

/** 子ども向けの表示（星の数）。 */
export const LEVEL_MARK: Record<Level, string> = { 1: "★", 2: "★★", 3: "★★★" };

/** 大人向けの説明ラベル。 */
export const LEVEL_NAME: Record<Level, string> = {
  1: "かんたん",
  2: "ふつう",
  3: "むずかしい",
};

/** 判定アルゴリズムの版。しきい値や手順を変えたら上げる（古いキャッシュを捨てる）。 */
const LEVEL_VERSION = 1;

/** 判定に使う縮小サイズ。1024x768 の 1/4（4:3 を保つ）。 */
const ANALYZE_W = 256;
const ANALYZE_H = 192;

/** これ以上のアルファを「線」とみなす。縮小で薄くなった細線も拾えるよう低めにする。 */
const INK_ALPHA = 48;

/** 塗る領域として数える最小面積（全画素に対する割合）。ゴマ粒は数えない。 */
const MIN_REGION_FRAC = 0.0015;

// しきい値は同梱の下絵 64 点（組み込み 20 + 共有 44）を実測して決めた。
// 領域数: 組み込みの単体恐竜が 2〜9、風景つきが 10〜24、細密なものが 25〜52。
// 線密度: 単体恐竜が 6〜14%、細密なもの（草むら・うろこ・ハッチング）が 27〜37%。
const REGION_MAX_L1 = 9;
const REGION_MAX_L2 = 24;
const INK_MAX_L1 = 0.15;
const INK_MAX_L2 = 0.22;

/** 読めない下絵など、判定できないときのレベル。 */
const FALLBACK_LEVEL: Level = 2;

/**
 * 縮小した下絵のアルファ配列からレベルを判定する（DOM 非依存の純関数）。
 * alpha は w*h 個の 0..255。
 */
export function estimateLevel(alpha: Uint8Array, w: number, h: number): Level {
  const total = w * h;
  const ink = new Uint8Array(total);
  let inkCount = 0;
  for (let i = 0; i < total; i++) {
    if (alpha[i] >= INK_ALPHA) {
      ink[i] = 1;
      inkCount++;
    }
  }

  // 線でない画素の連結成分（4近傍）を数える。再帰ではなく明示スタックで塗りつぶす。
  const minArea = Math.max(8, Math.round(total * MIN_REGION_FRAC));
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  let regions = 0;
  for (let start = 0; start < total; start++) {
    if (ink[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let area = 0;
    while (sp > 0) {
      const p = stack[--sp];
      area++;
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0 && !ink[p - 1] && !seen[p - 1]) {
        seen[p - 1] = 1;
        stack[sp++] = p - 1;
      }
      if (x < w - 1 && !ink[p + 1] && !seen[p + 1]) {
        seen[p + 1] = 1;
        stack[sp++] = p + 1;
      }
      if (y > 0 && !ink[p - w] && !seen[p - w]) {
        seen[p - w] = 1;
        stack[sp++] = p - w;
      }
      if (y < h - 1 && !ink[p + w] && !seen[p + w]) {
        seen[p + w] = 1;
        stack[sp++] = p + w;
      }
    }
    if (area >= minArea) regions++;
  }

  const inkRatio = inkCount / total;
  const byRegion: Level = regions <= REGION_MAX_L1 ? 1 : regions <= REGION_MAX_L2 ? 2 : 3;
  const byInk: Level = inkRatio <= INK_MAX_L1 ? 1 : inkRatio <= INK_MAX_L2 ? 2 : 3;
  return Math.max(byRegion, byInk) as Level;
}

/** 下絵 1 点を縮小して判定する（キャッシュを使わない実処理）。 */
async function computeLevel(art: LineArt): Promise<Level> {
  const img = await loadLineArtImage(art);
  const canvas = document.createElement("canvas");
  canvas.width = ANALYZE_W;
  canvas.height = ANALYZE_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, ANALYZE_W, ANALYZE_H);
  const data = ctx.getImageData(0, 0, ANALYZE_W, ANALYZE_H).data;
  const alpha = new Uint8Array(ANALYZE_W * ANALYZE_H);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
  return estimateLevel(alpha, ANALYZE_W, ANALYZE_H);
}

/**
 * 下絵ごとの自動判定レベルを返す。キャッシュがあればそれを使い、無いものだけ判定して
 * まとめて保存する。判定に失敗した下絵は保存せず「ふつう」として返す（次回やり直す）。
 */
export async function getAutoLevels(arts: LineArt[]): Promise<Map<string, Level>> {
  const cached = await store.getArtLevels().catch(() => new Map<string, store.ArtLevel>());
  const levels = new Map<string, Level>();
  const fresh: store.ArtLevel[] = [];

  for (const art of arts) {
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
