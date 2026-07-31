// 画像 1 点を「下絵」の生データ（1024x768 の透明化済み RGBA）にする共通処理。
//
// 下絵の透明化を CLI で 1 回だけやってコミットするため（＝端末側の起動時にやらないため）、
// 焼き込む側（optimize-shared-art.mjs）と、レベルを判定する側
// （compute-art-levels.mjs）の両方がこの変換を必要とする。2 箇所に書くとずれるので
// ここに集約する。しきい値そのものは src/level-core.ts の lineAlpha だけに持つ
// （ブラウザのアップロード変換 src/template.ts とも同じ規則になる）。
//
// TypeScript を直接 import するので Node 22.6 以上が必要（型注釈の除去）。
import sharp from "sharp";
import { lineAlpha } from "../../src/level-core.ts";

// src/lineart.ts の CANVAS_W/CANVAS_H と同じ値。この定数を変えたらここも合わせること
export const CANVAS_W = 1024;
export const CANVAS_H = 768;

/**
 * 元画像の範囲でこの割合を超える画素が透明なら「透明化済みの下絵」とみなす。
 * lineAlpha はアンチエイリアスの画素に対して冪等ではない（薄い線がかけるたびに
 * さらに薄くなる）ため、すでに焼き込んだ PNG に二度目をかけないための判定。
 * 生成AI が書き出す白背景の線画は透明画素 0%、焼き込み済みの下絵は 9 割前後なので
 * 十分に離れている。
 */
const BAKED_CLEAR_RATIO = 0.2;

/**
 * 画像を 1024x768 の透明化済み RGBA にする。
 * 縦横比を保って中に収め（contain）、余白は透明、白に近い画素ほど透明にする。
 *
 * 返り値の data は RGBA の生バッファ（そのまま sharp で PNG 化できる）、
 * alpha は「線の濃さ」だけを取り出した w*h の配列（レベル判定にそのまま渡せる）。
 * baked は入力がすでに透明化済みだった（＝透明化を省いた）かどうか。
 */
export async function toLineartRaw(input) {
  const img = sharp(input).ensureAlpha();
  const meta = await img.metadata();
  // 収まらない画像だけ縮める（焼き込み済みの下絵は 1024x768 ちょうど＝等倍）
  const scale = Math.min(CANVAS_W / meta.width, CANVAS_H / meta.height, 1);
  const w = Math.round(meta.width * scale);
  const h = Math.round(meta.height * scale);
  const top = Math.floor((CANVAS_H - h) / 2);
  const left = Math.floor((CANVAS_W - w) / 2);

  const { data } = await img
    .resize(w, h, { kernel: "lanczos3" })
    .extend({
      top,
      left,
      bottom: CANVAS_H - h - top,
      right: CANVAS_W - w - left,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 透明化済みかどうかは、足した余白を除いた元画像の範囲だけで数える
  let clear = 0;
  for (let y = top; y < top + h; y++) {
    for (let x = left; x < left + w; x++) {
      if (data[(y * CANVAS_W + x) * 4 + 3] === 0) clear++;
    }
  }
  const baked = clear > w * h * BAKED_CLEAR_RATIO;

  const alpha = new Uint8Array(CANVAS_W * CANVAS_H);
  for (let i = 0, p = 0; p < alpha.length; i += 4, p++) {
    const a = baked ? data[i + 3] : lineAlpha(data[i], data[i + 1], data[i + 2], data[i + 3]);
    data[i + 3] = a;
    alpha[p] = a;
  }

  return { data, alpha, baked, width: CANVAS_W, height: CANVAS_H };
}
