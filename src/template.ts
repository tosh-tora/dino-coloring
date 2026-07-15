// 下絵メーカー: アップロード画像の下絵化（白背景の透明化）と、外部画像生成AI用の
// 英語プロンプト生成、クリップボードコピーのユーティリティ。
import { CANVAS_W, CANVAS_H } from "./lineart";

/** File を Image 要素に読み込む */
function fileToImage(file: File): Promise<HTMLImageElement> {
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

/** アップロードされた画像ファイルを透明背景の下絵 data URL に変換する。 */
export async function processUploadedImage(file: File): Promise<string> {
  const img = await fileToImage(file);
  return imageToTransparentDataUrl(img);
}

/**
 * 日本語の主題から、外部の画像生成AIに貼り付けるための英語塗り絵線画プロンプトを作る。
 * このアプリはバックエンド無しのため主題の英訳はせず、主題を Subject にそのまま埋め込む
 * （近年の画像生成AIは日本語主題も解釈できる）。
 */
export function buildColoringPrompt(theme: string): string {
  const subject = theme.trim() || "a cute dinosaur";
  return [
    "Black-and-white coloring book line art for young children.",
    `Subject: ${subject}`,
    "",
    "Style requirements:",
    "- Bold, clean, continuous black outlines on a pure white background.",
    "- Outlines only. No shading, no gray tones, no color, no fills, no textures.",
    "- Thick, smooth lines with large, clearly separated regions that are easy to color inside.",
    "- Cute, friendly cartoon style. Simple and cheerful.",
    "- The whole subject is fully visible and centered, with generous white space around it.",
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
