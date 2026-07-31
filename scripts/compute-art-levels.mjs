#!/usr/bin/env node
// 下絵のレベル（★〜★★★）を判定して public/custom/index.json に焼き込む CLI。
//
// レベルは下絵だけで決まる固定の値なので、端末ごとに実行時判定する必要はない。
// 共有下絵を追加したらこれを 1 回走らせて index.json に書き込む。以後どのブラウザでも
// 同じ値が使われる（実行時判定は canvas の縮小品質がエンジンごとに違うため、iPad で
// ★3 がほぼ消えて大半が ★1 になる不具合があった）。
//
// 判定アルゴリズムは src/level-core.ts をそのまま import して使う。しきい値を 2 箇所に
// 書くと必ずずれるため、コピーしないこと。
//
// 使い方:
//   node scripts/compute-art-levels.mjs          判定して index.json を書き換える
//   node scripts/compute-art-levels.mjs --check   書き換えず、現在の値との差だけ表示する
//
// TypeScript を直接 import するので Node 22.6 以上が必要（型注釈の除去）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { levelFromAlpha, LEVEL_MARK } from "../src/level-core.ts";
import { toLineartRaw, CANVAS_W, CANVAS_H } from "./lib/lineart-raw.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CUSTOM_DIR = path.join(ROOT, "public", "custom");
const MANIFEST = path.join(CUSTOM_DIR, "index.json");
const LINEART_DIR = path.join(ROOT, "assets", "lineart");

/** 組み込み SVG の想定レベル（src/lineart.ts の BUILTIN_LEVEL と同じ値）。 */
const BUILTIN_LEVEL = 1;

const check = process.argv.includes("--check");

/** 画像 1 点のレベルを判定する。透明化は optimize-shared-art.mjs と同じ変換を通す。 */
async function levelOf(input) {
  const { alpha } = await toLineartRaw(input);
  return levelFromAlpha(alpha, CANVAS_W, CANVAS_H);
}

// ---- 共有下絵 ----

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const items = Array.isArray(manifest.items) ? manifest.items : [];
const tally = { 1: 0, 2: 0, 3: 0 };
const changes = [];

for (const it of items) {
  const file = path.join(CUSTOM_DIR, it.file);
  if (!fs.existsSync(file)) {
    console.warn(`⚠ 画像が見つかりません: ${it.file}（${it.id}）`);
    continue;
  }
  const level = await levelOf(file);
  if (it.level !== level) changes.push(`  ${it.id}: ${it.level ?? "なし"} → ${level}`);
  it.level = level;
  tally[level]++;
}

// ---- 組み込み SVG（レベルは src/lineart.ts に定数で持つので、ここでは確認だけ） ----

const svgs = fs.existsSync(LINEART_DIR)
  ? fs.readdirSync(LINEART_DIR).filter((f) => f.endsWith(".svg"))
  : [];
const builtinOff = [];
for (const f of svgs) {
  const level = await levelOf(path.join(LINEART_DIR, f));
  if (level !== BUILTIN_LEVEL) builtinOff.push(`  ${f}: ${level}`);
}

// ---- 出力 ----

console.log(`共有下絵 ${items.length} 点:`);
for (const l of [1, 2, 3]) console.log(`  ${LEVEL_MARK[l].padEnd(3)} ${tally[l]} 点`);

if (changes.length > 0) {
  console.log(`\n変化 ${changes.length} 件:`);
  for (const c of changes) console.log(c);
} else {
  console.log("\n変化なし");
}

if (builtinOff.length > 0) {
  console.log(
    `\n⚠ 組み込み SVG ${builtinOff.length} 点が想定（${BUILTIN_LEVEL}）と違います。` +
      `src/lineart.ts の BUILTIN_LEVEL を見直してください:`
  );
  for (const b of builtinOff) console.log(b);
} else if (svgs.length > 0) {
  console.log(`\n組み込み SVG ${svgs.length} 点はすべて想定どおり ★${BUILTIN_LEVEL}`);
}

if (check) {
  console.log("\n--check のため index.json は書き換えていません");
  process.exit(changes.length > 0 ? 1 : 0);
}

fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
console.log(`\n${path.relative(ROOT, MANIFEST)} を更新しました`);
