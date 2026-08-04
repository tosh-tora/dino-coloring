// 主役の切り抜き（cutout.ts）と DOM / 永続化のつなぎ。
//
// 抽出そのものは下絵だけで決まるので、結果は下絵 id ごとに IndexedDB へキャッシュする。
// 完成作品は子どもの塗りによって毎回変わるが、切り抜きに使うマスクは同じものを使える。

import { extractSubjectMasks, type SubjectMask } from "./cutout";
import type { CutoutRequest, CutoutResponse } from "./cutout.worker";
import { CANVAS_W, CANVAS_H, loadLineArtImage, type LineArt } from "./lineart";
import * as store from "./store";

/**
 * 抽出アルゴリズムの版。cutout.ts のしきい値や手順を変えたら上げること。
 * 古いキャッシュは無視され、次に開いたときに作り直される。
 */
const CUTOUT_VERSION = 7;

/** これ未満の輪郭一致率なら、主役をきれいに切り出せていないとみなす */
export const MIN_CONFIDENCE = 0.85;

export interface Subject {
  /** 主役だけを残した切り抜き（完成画像と同じ CANVAS_W x CANVAS_H の座標系） */
  canvas: HTMLCanvasElement;
  /** 切り抜きの外接矩形 */
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

// extractSubjectMasks は 1024x768 で数秒かかる同期処理なので、Worker で走らせて
// メインスレッド（お絵かき中の操作や「できた！」の紙吹雪）を止めないようにする。
// Worker を作れない環境（file:// 起動や CSP など）ではその場で呼ぶフォールバックに落ちる。
let worker: Worker | null | undefined;
let nextRequestId = 0;
const pending = new Map<number, { resolve: (m: SubjectMask[]) => void; reject: (e: unknown) => void }>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./cutout.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<CutoutResponse>) => {
      const req = pending.get(e.data.id);
      if (!req) return;
      pending.delete(e.data.id);
      req.resolve(e.data.masks);
    };
    worker.onerror = (e) => {
      // 起きているリクエスト全部をフォールバックへ流す。以降の呼び出しも
      // フォールバック固定にする（壊れた Worker を使い続けても仕方ないため）
      for (const req of pending.values()) req.reject(e);
      pending.clear();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** Worker があればそちらで、無ければメインスレッドで抽出する */
function extractMasks(alpha: Uint8Array, w: number, h: number): Promise<SubjectMask[]> {
  const w2 = getWorker();
  if (!w2) return Promise.resolve(extractSubjectMasks(alpha, w, h));

  const id = nextRequestId++;
  return new Promise<SubjectMask[]>((resolve) => {
    // Worker が落ちたときは reject ではなく、その場でメインスレッド計算にフォールバックする
    pending.set(id, { resolve, reject: () => resolve(extractSubjectMasks(alpha, w, h)) });
    // alpha はここでしか使わないので転送してコピーを避ける
    const buf = alpha.buffer.slice(alpha.byteOffset, alpha.byteOffset + alpha.byteLength) as ArrayBuffer;
    const req: CutoutRequest = { id, alpha: buf, w, h };
    w2.postMessage(req, [buf]);
  });
}

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("マスクを読み込めませんでした"));
    img.src = src;
  });
}

/** シルエットをアルファだけの PNG にする（destination-in で切り抜くために使う） */
function maskToDataUrl(mask: Uint8Array, w: number, h: number): string {
  const canvas = newCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) img.data[i * 4 + 3] = mask[i] === 1 ? 255 : 0;
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

/** 下絵から主役を抽出する（キャッシュを使わない実処理） */
async function extract(art: LineArt): Promise<store.CutoutSubject[]> {
  const img = await loadLineArtImage(art);
  const canvas = newCanvas(CANVAS_W, CANVAS_H);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, CANVAS_W, CANVAS_H);

  const data = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H).data;
  const alpha = new Uint8Array(CANVAS_W * CANVAS_H);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];

  const masks = await extractMasks(alpha, CANVAS_W, CANVAS_H);
  return masks.map((s) => ({
    maskUrl: maskToDataUrl(s.mask, CANVAS_W, CANVAS_H),
    x: s.x,
    y: s.y,
    w: s.w,
    h: s.h,
    confidence: s.confidence,
  }));
}

/**
 * 下絵の主役マスクを返す。キャッシュがあればそれを、無ければ抽出して保存する。
 * 抽出に失敗した（＝主役を見つけられなかった）場合も空配列としてキャッシュする。
 * 失敗を繰り返し計算しても結果は変わらないため。
 */
export async function getSubjectMasks(art: LineArt): Promise<store.CutoutSubject[]> {
  const cached = await store.getCutout(art.id).catch(() => undefined);
  if (cached && cached.version === CUTOUT_VERSION) return cached.subjects;

  const subjects = await extract(art);
  await store.saveCutout({ id: art.id, version: CUTOUT_VERSION, subjects }).catch(() => {});
  return subjects;
}

/**
 * 完成画像をマスクで切り抜いて、動かせるスプライトにする。
 * 一致率が低いものは背景を巻き込んでいるので除外する（呼び出し側は空配列なら
 * 絵まるごと動かすなどのフォールバックに切り替える）。
 */
export async function cutOutSubjects(
  art: LineArt,
  finished: CanvasImageSource
): Promise<Subject[]> {
  const masks = await getSubjectMasks(art);
  const out: Subject[] = [];

  for (const m of masks) {
    if (m.confidence < MIN_CONFIDENCE) continue;
    const canvas = newCanvas(CANVAS_W, CANVAS_H);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(finished, 0, 0, CANVAS_W, CANVAS_H);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(await loadImage(m.maskUrl), 0, 0);
    out.push({ canvas, x: m.x, y: m.y, w: m.w, h: m.h, confidence: m.confidence });
  }
  return out;
}
