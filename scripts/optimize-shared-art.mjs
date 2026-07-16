#!/usr/bin/env node
// 共有下絵 (public/custom/*.png) をコミットする前に縮小・減色する CLI。
// アプリは 1024x768 (src/lineart.ts の CANVAS_W/CANVAS_H と同じ値。この定数を変えたら
// ここも合わせて変更すること) にしか描画しないため、生成AIの書き出しサイズのまま
// コミットすると無駄に大きい。線画は白背景＋黒線＋アンチエイリアスのグレーのみで
// 色数もごくわずかしか要らないため、パレットPNG化で大幅に縮む（実測で概ね 1/10 程度）。
//
// 使い方: node scripts/optimize-shared-art.mjs <入力パス> [出力パス]
//   出力パスを省略すると入力ファイルを上書きする。
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const CANVAS_W = 1024;
const CANVAS_H = 768;

const [, , inputArg, outputArg] = process.argv;
if (!inputArg) {
  console.error("使い方: node scripts/optimize-shared-art.mjs <入力パス> [出力パス]");
  process.exit(1);
}

const input = path.resolve(inputArg);
const output = path.resolve(outputArg ?? inputArg);

if (!fs.existsSync(input)) {
  console.error(`入力ファイルが見つかりません: ${input}`);
  process.exit(1);
}

const beforeSize = fs.statSync(input).size;

// 出力が入力と同じ場合、sharp は同一パスへの直接書き込みを許さないため一旦バッファ化する
const buffer = await sharp(input)
  .resize(CANVAS_W, CANVAS_H, { fit: "inside", withoutEnlargement: true })
  .png({ palette: true, colors: 64, compressionLevel: 9, effort: 10 })
  .toBuffer();

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, buffer);

const afterSize = buffer.length;
const reduction = (100 * (1 - afterSize / beforeSize)).toFixed(1);
console.log(
  `${path.basename(input)}: ${beforeSize.toLocaleString()} bytes → ${afterSize.toLocaleString()} bytes（${reduction}% 削減）→ ${output}`
);
