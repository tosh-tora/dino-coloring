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
  normal:
    "- Clean, friendly illustration style with believable, slightly realistic proportions.",
  realistic:
    "- Realistic, encyclopedia-style illustration with accurate proportions and anatomy, but keep outlines bold and avoid excessive fine linework or texture detail.",
};

const LINE_LINES: Record<PromptOptions["line"], string> = {
  thick: "- Extra bold, very thick, smooth, continuous black outlines.",
  normal: "- Bold, thick, smooth, continuous black outlines.",
  thin: "- Medium-weight, clean, continuous black outlines. Not fine or delicate lines.",
};

const BACKGROUND_LINES: Record<PromptOptions["background"], string> = {
  none: "- Pure white background with no background elements. The whole subject is fully visible and centered, with generous white space around it.",
  simple:
    "- A very sparse background: one ground line plus at most two other large elements in total (for example one plant and one cloud). Nothing more — leave the rest of the background as empty white space.",
  full: "- A full scene background filling the frame (sky, terrain, plants) drawn in the same drawing style.",
};

/**
 * 背景ありのときだけ足す指定。
 *
 * 「うごかす」（cutout.ts）は線の太さで主役と背景を見分けるので、線幅に差が要る。
 * ただし「際立って太く」のような強い対比語を使うと、生成AIが背景線を細くする方向に
 * 倒しすぎて背景そのものが塗りにくくなる。かといって「背景も同じくらい太く」と足すと
 * 指定同士が矛盾して結果が安定しない。そこで「2段階の太さ。主役がやや太いだけ」と
 * 一貫した言い方にし、どちらも塗れる太さで閉じることを前提に置く。
 *
 * すき間の禁止は cc104e6 で確立した判断（背景を主役の手前で止めるとすき間ができ、
 * 塗る領域が閉じずはみだしガードが効かなくなる）。困るのは手前を横切る場合だけ。
 */
const SUBJECT_SEPARATION_LINE =
  "- Use exactly two line weights: a slightly heavier outline for the subject and a slightly lighter one for the background. Both weights must stay bold, smooth and fully closed — the background lines are only a little lighter, never faint, thin, sketchy or broken. Background elements always touch the subject's outline with no gap between them, and pass behind the subject rather than crossing in front of it.";

/**
 * 背景ありのときだけ足す、背景そのものの描き方の指定。
 *
 * 生成AIは草や茂みを「開いた線の束」（穂先だけの草、下辺の無い茂み）として描きがちで、
 * これだと領域が地面と繋がってしまい、塗り分けられないし はみだしガードも効かない。
 * 要素同士を重ねて茂みの塊にされるのも同じ理由で困る。ひとつずつ閉じた形にして、
 * 離して置いてもらう。
 */
const BACKGROUND_REGION_LINE =
  "- Draw each background element as one simple shape with a fully closed outline that can be filled with a single flat color. No open-ended strokes, no loose tufts of lines, no scribbles, no grass or fur drawn as bare unconnected lines. Space the background elements well apart from each other with plain white gaps between them; never overlap, stack, or cluster them together.";

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
    // 背景が無ければ主役しか居ないので、背景まわりの指定は不要
    ...(opts.background === "none"
      ? []
      : [SUBJECT_SEPARATION_LINE, BACKGROUND_REGION_LINE]),
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
