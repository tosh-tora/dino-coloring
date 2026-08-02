#!/usr/bin/env node
// 「うごかす」の主役抽出（src/cutout.ts）を全下絵にかけて結果を一覧する CLI。
//
// 抽出は下絵だけで決まるので、しきい値や手順をいじったら全点を回して before/after を
// 見比べれば regression が分かる。数値だけでは「背景を巻き込んでいないか」までは
// 判断できないため、線画にシルエットを赤で重ねた PNG も書き出して目視できるようにする。
//
// 判定アルゴリズムは src/cutout.ts をそのまま import して使う。しきい値を 2 箇所に
// 書くと必ずずれるため、コピーしないこと。
//
// 使い方:
//   node scripts/check-cutouts.mjs                全点を処理して一覧と重ね画像を出す
//   node scripts/check-cutouts.mjs pteranodon     id に部分一致する下絵だけ
//   node scripts/check-cutouts.mjs --no-png       一覧だけ（速い）
//   node scripts/check-cutouts.mjs --out DIR      重ね画像の出力先（既定 cutout-check.local）
//
// TypeScript を直接 import するので Node 22.6 以上が必要（型注釈の除去）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { extractSubjectMasks } from "../src/cutout.ts";
import { toLineartRaw, CANVAS_W, CANVAS_H } from "./lib/lineart-raw.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CUSTOM_DIR = path.join(ROOT, "public", "custom");
const MANIFEST = path.join(CUSTOM_DIR, "index.json");
const LINEART_DIR = path.join(ROOT, "assets", "lineart");

/** src/subject.ts の MIN_CONFIDENCE と同じ値。これ未満の下絵では演出を出さない */
const MIN_CONFIDENCE = 0.85;

const args = process.argv.slice(2);
const noPng = args.includes("--no-png");
const outIdx = args.indexOf("--out");
// 既定の出力先は *.local（.gitignore 済み）に合わせてコミットされないようにする
const outDir = path.resolve(ROOT, outIdx >= 0 ? args[outIdx + 1] : "cutout-check.local");
const filters = args.filter((a, i) => !a.startsWith("--") && !(outIdx >= 0 && i === outIdx + 1));

/** 線画（黒）にシルエット（赤）を重ねた PNG を書き出す */
async function writeOverlay(file, alpha, subjects) {
  const rgb = Buffer.alloc(CANVAS_W * CANVAS_H * 3);
  for (let i = 0; i < CANVAS_W * CANVAS_H; i++) {
    const ink = 255 - alpha[i];
    const on = subjects.some((s) => s.mask[i] === 1);
    rgb[i * 3] = on ? 255 : ink;
    rgb[i * 3 + 1] = on ? Math.min(ink, 120) : ink;
    rgb[i * 3 + 2] = on ? Math.min(ink, 120) : ink;
  }
  await sharp(rgb, { raw: { width: CANVAS_W, height: CANVAS_H, channels: 3 } }).toFile(file);
}

/** 下絵 1 点を処理して 1 行表示する。主役が採用される下絵なら true */
async function checkOne(id, file) {
  const { alpha } = await toLineartRaw(file);
  const subjects = extractSubjectMasks(alpha, CANVAS_W, CANVAS_H);
  const used = subjects.filter((s) => s.confidence >= MIN_CONFIDENCE);

  const detail =
    subjects.length === 0
      ? "主役なし"
      : subjects
          .map(
            (s) =>
              `${s.confidence >= MIN_CONFIDENCE ? "" : "×"}` +
              `conf=${s.confidence.toFixed(3)} area=${s.area} ` +
              `box=${s.x},${s.y} ${s.w}x${s.h}`
          )
          .join(" / ");
  console.log(`${id.padEnd(38)} ${String(subjects.length).padStart(2)}体  ${detail}`);

  if (!noPng) await writeOverlay(path.join(outDir, `${id}.png`), alpha, subjects);
  return used.length > 0;
}

// ---- 対象を集める（共有下絵 + 組み込み SVG） ----

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const targets = (Array.isArray(manifest.items) ? manifest.items : [])
  .map((it) => ({ id: it.id, file: path.join(CUSTOM_DIR, it.file) }))
  .concat(
    (fs.existsSync(LINEART_DIR) ? fs.readdirSync(LINEART_DIR) : [])
      .filter((f) => f.endsWith(".svg"))
      .map((f) => ({ id: f.replace(/\.svg$/, ""), file: path.join(LINEART_DIR, f) }))
  )
  .filter((t) => filters.length === 0 || filters.some((f) => t.id.includes(f)));

if (!noPng) fs.mkdirSync(outDir, { recursive: true });

// ---- 実行 ----

let ok = 0;
for (const t of targets) {
  if (!fs.existsSync(t.file)) {
    console.warn(`⚠ 画像が見つかりません: ${t.id}`);
    continue;
  }
  if (await checkOne(t.id, t.file)) ok++;
}

console.log(`\n${targets.length} 点中 ${ok} 点で主役を採用（confidence >= ${MIN_CONFIDENCE}）`);
if (!noPng) console.log(`重ね画像: ${path.relative(ROOT, outDir)}/`);
