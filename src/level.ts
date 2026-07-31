// ぬりえのレベル（1=かんたん / 2=ふつう / 3=むずかしい）の自動判定。
//
// 判定は下絵を 256x192 に縮小したアルファ（＝線の濃さ）だけで行う軽い方法。
// 4歳児にとっての難しさは「線の数」ではなく次の 2つで決まる、という見立てで測る:
//
//   - 細い線の量（fine）: 縮小すると太い線は濃いまま残り、羽根・毛・草・ハッチングの
//     ような細い線は薄くなる。「薄いのに 濃い線の隣ではない」画素だけを数えれば、
//     太い線のフチ（アンチエイリアス）と区別して細い線だけを拾える
//   - 小さい領域の広さ（small）: 塗れる面積のうち、小さな区画が占める割合。
//     うろこ・羽・模様のような細かい塗り分けほど大きくなる
//
// ふたつの見立ての「難しい方」を採る。領域の"数"を使うと、大きな葉が並ぶだけの
// 素朴な絵（velociraptor）が難しい側に、細い線だらけの絵（fukuivenator）が簡単側に
// 落ちてしまうため、数ではなく「細さ」と「小ささ」で測っている。
//
// 縮小はブラウザ任せ（drawImage の転送先を小さくする）にせず、等倍で描いてから 4x4 の
// 面積平均を自前で行う。drawImage の縮小フィルターの品質は仕様で決まっておらず、Chrome は
// 面積平均するが WebKit（iPad / Safari）は安価な間引きで済ませる。fine はアンチエイリアス
// された薄い画素だけを見る指標なので、間引かれると真っ先に消え、iPad では ★3 がほぼ消えて
// 大半が ★1 になっていた（fine が 15.5 → 0.1 まで落ちる下絵もあった）。
//
// 結果は下絵 id ごとに IndexedDB へキャッシュする（下絵が同じなら結果も同じ）。
// 大人が手で決めた上書きは artmeta 側にあり、そちらが優先される（main.ts）。

import { CANVAS_W, CANVAS_H, loadLineArtImage, type LineArt } from "./lineart";
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
const LEVEL_VERSION = 3;

/** 判定に使う縮小サイズ。1024x768 の 1/4（4:3 を保つ）。 */
const ANALYZE_W = 256;
const ANALYZE_H = 192;

/** 面積平均するブロックの一辺。CANVAS_W/H と ANALYZE_W/H の比（= 4）。 */
const SCALE = CANVAS_W / ANALYZE_W;

/** これ以上のアルファを「線」とみなす。縮小で薄くなった細線も拾えるよう低めにする。 */
const INK_ALPHA = 48;

/** これ以上のアルファは「太い線」。縮小しても濃さが残るのは太い線だけ。 */
const STRONG_ALPHA = 200;

/** これ未満の面積（全画素に対する割合）の区画を「小さい領域」として数える。 */
const SMALL_REGION_FRAC = 0.01;

// しきい値は同梱の下絵 64 点（組み込み 20 + 共有 44）の実測と、実際に見て付けた
// 正解ラベルから決めた。
// 細い線の量: 組み込み SVG（太線のみ）は 0、素朴な共有下絵が 0.1〜1.5、
//   羽根やハッチングのある下絵が 2.7〜13。
// 小さい領域: 素朴な下絵が 0〜15%、うろこ・翅のような細かい絵が 21〜31%。
const FINE_MAX_L1 = 0.4;
const FINE_MAX_L2 = 2.5;
const SMALL_MAX_L1 = 8;
const SMALL_MAX_L2 = 20;

/** 読めない下絵など、判定できないときのレベル。 */
const FALLBACK_LEVEL: Level = 2;

/**
 * 縮小した下絵のアルファ配列からレベルを判定する（DOM 非依存の純関数）。
 * alpha は w*h 個の 0..255。
 */
export function estimateLevel(alpha: Uint8Array, w: number, h: number): Level {
  const total = w * h;
  const ink = new Uint8Array(total);
  const strong = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (alpha[i] >= INK_ALPHA) {
      ink[i] = 1;
      if (alpha[i] >= STRONG_ALPHA) strong[i] = 1;
    }
  }

  // 細い線の量: 薄い線の画素のうち、太い線に接していないもの（＝太線のフチではなく
  // それ自体が細い線）が画面に占める割合。
  let fineCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!ink[i] || strong[i]) continue;
      let nearStrong = false;
      for (let dy = -1; dy <= 1 && !nearStrong; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (strong[ny * w + nx]) {
            nearStrong = true;
            break;
          }
        }
      }
      if (!nearStrong) fineCount++;
    }
  }

  // 小さい領域の広さ: 線でない画素の連結成分（4近傍）を塗りつぶしながら面積を測り、
  // 塗れる面積のうち小さな区画が占める割合を出す。明示スタックで再帰を避ける。
  const smallArea = Math.round(total * SMALL_REGION_FRAC);
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  let paintable = 0;
  let smallSum = 0;
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
    paintable += area;
    if (area < smallArea) smallSum += area;
  }

  const fine = (fineCount / total) * 100;
  const small = paintable > 0 ? (smallSum / paintable) * 100 : 0;
  const byFine: Level = fine <= FINE_MAX_L1 ? 1 : fine <= FINE_MAX_L2 ? 2 : 3;
  const bySmall: Level = small <= SMALL_MAX_L1 ? 1 : small <= SMALL_MAX_L2 ? 2 : 3;
  return Math.max(byFine, bySmall) as Level;
}

/**
 * 等倍（CANVAS_W x CANVAS_H）の RGBA からアルファだけを SCALE x SCALE の面積平均で
 * ANALYZE_W x ANALYZE_H に縮小する。どのブラウザでも同じ値になるよう自前で計算する。
 */
function downscaleAlpha(rgba: Uint8ClampedArray): Uint8Array {
  const alpha = new Uint8Array(ANALYZE_W * ANALYZE_H);
  const block = SCALE * SCALE;
  for (let y = 0; y < ANALYZE_H; y++) {
    for (let x = 0; x < ANALYZE_W; x++) {
      let sum = 0;
      for (let dy = 0; dy < SCALE; dy++) {
        // 元画像の 1 行ぶんの先頭（アルファは 4 バイトおき）
        const row = ((y * SCALE + dy) * CANVAS_W + x * SCALE) * 4 + 3;
        for (let dx = 0; dx < SCALE; dx++) sum += rgba[row + dx * 4];
      }
      alpha[y * ANALYZE_W + x] = Math.round(sum / block);
    }
  }
  return alpha;
}

/** 判定用の canvas。下絵ごとに作らず使い回す（1024x768 を何十枚も作らないため）。 */
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

/** 下絵 1 点を縮小して判定する（キャッシュを使わない実処理）。 */
async function computeLevel(art: LineArt): Promise<Level> {
  const img = await loadLineArtImage(art);
  const ctx = getAnalyzeCtx();
  // canvas を使い回すので前の下絵を消す（下絵は透明部分があり、消さないと重なる）
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  // 等倍で描く（縮小フィルターを通さない）。組み込み SVG も共有下絵も 1024x768。
  ctx.drawImage(img, 0, 0, CANVAS_W, CANVAS_H);
  const data = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H).data;
  return estimateLevel(downscaleAlpha(data), ANALYZE_W, ANALYZE_H);
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
