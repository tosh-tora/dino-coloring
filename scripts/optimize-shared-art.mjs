#!/usr/bin/env node
// 共有下絵 (public/custom/*.png) をコミットする前に「そのままアプリで使える下絵」にする CLI。
// やることは 3 つ:
//   - 1024x768 (src/lineart.ts の CANVAS_W/CANVAS_H と同じ値。この定数を変えたら
//     scripts/lib/lineart-raw.mjs も合わせて変更すること) に収める
//   - 白背景を透明にする（線だけ残す）。塗りレイヤーが下から透けるために必要な処理で、
//     以前はブラウザが起動のたびに全下絵ぶんやっていた。ここで 1 回やってコミットする
//   - パレットPNG化で減色する。線画は黒線＋アンチエイリアスのグレーしか無いので大きく縮む
//     （透明化のぶん背景が一様になり、実測で合計 5.1MB → 2.3MB）
//
// すでに透明化済みの画像を渡した場合は透明化をとばす（二度かけると線が薄くなるため）。
//
// 使い方: node scripts/optimize-shared-art.mjs <入力パス> [出力パス]
//   出力パスを省略すると入力ファイルを上書きする。
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { toLineartRaw, CANVAS_W, CANVAS_H } from "./lib/lineart-raw.mjs";

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

const { data, baked } = await toLineartRaw(input);
const buffer = await sharp(data, { raw: { width: CANVAS_W, height: CANVAS_H, channels: 4 } })
  .png({ palette: true, colors: 64, compressionLevel: 9, effort: 10 })
  .toBuffer();

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, buffer);

const afterSize = buffer.length;
const reduction = (100 * (1 - afterSize / beforeSize)).toFixed(1);
console.log(
  `${path.basename(input)}: ${beforeSize.toLocaleString()} bytes → ${afterSize.toLocaleString()} bytes（${reduction}% 削減）` +
    `${baked ? "（透明化済みだったのでとばしました）" : ""} → ${output}`
);
