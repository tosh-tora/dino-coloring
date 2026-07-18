// 下絵メーカー: アップロード画像の下絵化（白背景の透明化）と、外部画像生成AI用の
// 英語プロンプト生成、クリップボードコピーのユーティリティ。
import { CANVAS_W, CANVAS_H } from "./lineart";

/** File を Image 要素に読み込む */
export function fileToImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("画像を読み込めませんでした"));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * 読み込み済み画像を下絵（透明背景の線画）に変換する。
 * - 1024×768 canvas に contain 配置（縦横比を保って中央に収める）で描画。
 * - 白に近い画素ほど透明にして、暗い線だけを残す。これで塗りレイヤーが下から透ける。
 * 返り値は透明 PNG の data URL。アップロードと共有下絵ロードの両方で使う。
 */
export function imageToTransparentDataUrl(img: HTMLImageElement): string {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d")!;

  // contain 配置
  const scale = Math.min(CANVAS_W / img.width, CANVAS_H / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const x = (CANVAS_W - w) / 2;
  const y = (CANVAS_H - h) / 2;
  ctx.drawImage(img, x, y, w, h);

  // 白背景 → 透明化。明るさ 235 以上は完全透明、190〜235 は線形に減衰。
  const data = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
  const px = data.data;
  const HI = 235; // これ以上明るい画素は透明
  const LO = 190; // これ以下の暗さは線として残す
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 0) continue;
    // 知覚輝度
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (lum >= HI) {
      px[i + 3] = 0;
    } else if (lum > LO) {
      const t = (HI - lum) / (HI - LO); // LO で1, HI で0
      px[i + 3] = Math.round(a * t);
    }
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * 写真っぽい画像かどうかの簡易判定（ぬりえ化トグルの初期値に使う）。
 * 白背景＋黒線の線画は白・黒に画素が寄るので、中間調や有彩色の画素が
 * 一定割合を超えたら写真とみなす。
 */
export function isPhotoLike(img: HTMLImageElement): boolean {
  const N = 64;
  const canvas = document.createElement("canvas");
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, N, N);
  ctx.drawImage(img, 0, 0, N, N);
  const px = ctx.getImageData(0, 0, N, N).data;
  let busy = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma > 40 || (lum > 90 && lum < 210)) busy++;
  }
  return busy / (N * N) > 0.2;
}

/**
 * 写真などの通常画像を、ぬりえ向きの太くシンプルな輪郭線画（黒線＋透明背景の
 * 1024×768 data URL）に変換する。
 * 縮小＋ぼかしで細部を落としてから Sobel で輪郭を取り、膨張と拡大で線を太らせる。
 */
export function photoToColoringDataUrl(img: HTMLImageElement): string {
  // 処理解像度。小さくするほど細部が落ちてシンプルな線になり、
  // 最終キャンバスへの拡大率が上がって線も太くなる。
  const MAX = 480;
  const s = Math.min(1, MAX / Math.max(img.width, img.height));
  const w = Math.max(4, Math.round(img.width * s));
  const h = Math.max(4, Math.round(img.height * s));

  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const sctx = small.getContext("2d")!;
  sctx.fillStyle = "#fff";
  sctx.fillRect(0, 0, w, h);
  sctx.filter = "grayscale(1) blur(1.5px)";
  sctx.drawImage(img, 0, 0, w, h);
  sctx.filter = "none";

  const src = sctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = src[i * 4]; // grayscale 済みなので R 成分でよい

  // Sobel で輪郭抽出
  const THRESHOLD = 70;
  const edge = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1] +
        lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1];
      const gy =
        -lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1] +
        lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1];
      if (Math.hypot(gx, gy) > THRESHOLD) edge[i] = 1;
    }
  }

  // 膨張1回で線を太らせる（このあとの拡大でさらに太くなる）
  const fat = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (edge[i] || edge[i - 1] || edge[i + 1] || edge[i - w] || edge[i + w]) fat[i] = 1;
    }
  }

  // 黒線＋透明背景にして 1024×768 へ contain 配置
  const lineData = sctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) lineData.data[i * 4 + 3] = fat[i] ? 255 : 0;
  sctx.putImageData(lineData, 0, 0);

  const out = document.createElement("canvas");
  out.width = CANVAS_W;
  out.height = CANVAS_H;
  const octx = out.getContext("2d")!;
  const k = Math.min(CANVAS_W / w, CANVAS_H / h);
  const dw = w * k;
  const dh = h * k;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(small, (CANVAS_W - dw) / 2, (CANVAS_H - dh) / 2, dw, dh);
  return out.toDataURL("image/png");
}

/** プロンプトの画風・線・背景・細かさの指定。 */
export interface PromptOptions {
  style: "cute" | "normal" | "realistic";
  line: "thick" | "normal" | "thin";
  background: "none" | "simple" | "full";
  detail: "very-easy" | "easy" | "normal";
}

/** 現行テンプレートと同等の既定値（かわいい・ふとい・背景なし・かんたん）。 */
export const DEFAULT_PROMPT_OPTIONS: PromptOptions = {
  style: "cute",
  line: "thick",
  background: "none",
  detail: "easy",
};

const STYLE_LINES: Record<PromptOptions["style"], string> = {
  cute: "- Cute, friendly cartoon style. Simple and cheerful.",
  normal: "- Clean, friendly illustration style.",
  realistic:
    "- Realistic, encyclopedia-style illustration with accurate proportions and anatomy.",
};

const LINE_LINES: Record<PromptOptions["line"], string> = {
  thick: "- Extra bold, very thick, smooth, continuous black outlines.",
  normal: "- Bold, thick, smooth, continuous black outlines.",
  thin: "- Medium-weight, clean, continuous black outlines. Not fine or delicate lines.",
};

const BACKGROUND_LINES: Record<PromptOptions["background"], string> = {
  none: "- Pure white background with no background elements. The whole subject is fully visible and centered, with generous white space around it.",
  simple:
    "- A simple background with just a few large, easy-to-color elements (e.g. a ground line, a plant, clouds).",
  full: "- A full scene background filling the frame (sky, terrain, plants) drawn in the same line-art style.",
};

const DETAIL_LINES: Record<PromptOptions["detail"], string> = {
  "very-easy":
    "- Extremely simple with very few lines and very large regions, perfect for toddlers to color inside.",
  easy: "- Simple with few lines and large, clearly separated regions that are easy for young children to color inside.",
  normal:
    "- Moderate detail with clearly separated regions, still easy for children to color inside.",
};

/**
 * 日本語の主題から、外部の画像生成AIに貼り付けるための英語塗り絵線画プロンプトを作る。
 * このアプリはバックエンド無しのため主題の英訳はせず、主題を Subject にそのまま埋め込む
 * （近年の画像生成AIは日本語主題も解釈できる）。
 */
export function buildColoringPrompt(
  theme: string,
  opts: PromptOptions = DEFAULT_PROMPT_OPTIONS,
): string {
  const subject = theme.trim() || "a cute dinosaur";
  return [
    "Black-and-white coloring book line art for young children.",
    `Subject: ${subject}`,
    "",
    "Style requirements:",
    LINE_LINES[opts.line],
    "- Outlines only. No shading, no gray tones, no color, no fills, no textures.",
    DETAIL_LINES[opts.detail],
    STYLE_LINES[opts.style],
    BACKGROUND_LINES[opts.background],
    "- Landscape orientation, 4:3 aspect ratio.",
    "- No text, no watermark, no border frame.",
  ].join("\n");
}

/** テキストをクリップボードにコピー。失敗時は execCommand にフォールバック。 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // フォールバックへ
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
