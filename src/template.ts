// 下絵メーカー: アップロード画像の下絵化（白背景の透明化）と、外部画像生成AI用の
// 英語プロンプト生成、クリップボードコピーのユーティリティ。
import { CANVAS_W, CANVAS_H } from "./lineart";
import { lineAlpha, levelFromAlpha, type Level } from "./level-core";

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
 * 読み込み済み画像を下絵（透明背景の線画）にして、data URL と線の濃さ（アルファ）を返す。
 * - 1024×768 canvas に contain 配置（縦横比を保って中央に収める）で描画。
 * - 白に近い画素ほど透明にして、暗い線だけを残す。これで塗りレイヤーが下から透ける。
 * アルファはレベル判定にそのまま使える（画像を読み直さずに済む）。
 */
function toTransparent(img: HTMLImageElement): { imageUrl: string; alpha: Uint8Array } {
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
  // 大きい画像を縮めるときの品質。既定の "low" は WebKit だと細い線が消えるほど雑になる
  // （level.ts の判定が iPad で壊れていたのと同じ理由）。仕様上はヒントだが既定よりは良い
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, x, y, w, h);

  // 白背景 → 透明化（規則は level-core.ts の lineAlpha に集約。CLI と同じもの）
  const data = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
  const px = data.data;
  const alpha = new Uint8Array(CANVAS_W * CANVAS_H);
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    const a = lineAlpha(px[i], px[i + 1], px[i + 2], px[i + 3]);
    px[i + 3] = a;
    alpha[p] = a;
  }
  ctx.putImageData(data, 0, 0);
  return { imageUrl: canvas.toDataURL("image/png"), alpha };
}

/**
 * 読み込み済み画像を透明背景の下絵 data URL にする。
 * 共有下絵の読み込みで使う（レベルは index.json に焼き込み済みなので判定しない）。
 */
export function imageToTransparentDataUrl(img: HTMLImageElement): string {
  return toTransparent(img).imageUrl;
}

/**
 * アップロードされた画像ファイルを下絵にする。レベルはこの取り込み時に 1 回だけ判定し、
 * 以後は保存された値を使う（端末やブラウザが変わっても揺れないように）。
 */
export async function processUploadedImage(
  file: File
): Promise<{ imageUrl: string; level: Level }> {
  const { imageUrl, alpha } = toTransparent(await fileToImage(file));
  return { imageUrl, level: levelFromAlpha(alpha, CANVAS_W, CANVAS_H) };
}

/**
 * プロンプトの作り方。
 * - text: 日本語の主題テキストから線画を生成させる
 * - image: 手持ちの画像を添付して線画化させる（ツール内での輪郭抽出は品質的に難しいため
 *   プロンプト方式にしている）
 */
export type PromptMode = "text" | "image";

/** プロンプトの作り方・画風・線・背景・細かさ・忠実さの指定。 */
export interface PromptOptions {
  mode: PromptMode;
  style: "cute" | "normal" | "realistic";
  line: "thick" | "normal" | "thin";
  background: "none" | "simple" | "full";
  detail: "very-easy" | "easy" | "normal";
  /** image モードのみ: 元画像への忠実さ（faithful=そのまま 〜 simple=しっかり単純） */
  fidelity: "faithful" | "balanced" | "simple";
}

/** 現行テンプレートと同等の既定値（ことばから・かわいい・ふとい・背景なし・かんたん）。 */
export const DEFAULT_PROMPT_OPTIONS: PromptOptions = {
  mode: "text",
  style: "cute",
  line: "thick",
  background: "none",
  detail: "easy",
  fidelity: "balanced",
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

/** image モードでの背景の扱い。文面は「元画像の背景をどう扱うか」の指示なので、
 * テキストモード用の BACKGROUND_LINES（何もないところから描かせる指示）とは別に持つ。 */
const IMAGE_BACKGROUND_LINES: Record<PromptOptions["background"], string> = {
  none: "- Ignore the background of the attached photo entirely. Draw only the main subject on a pure white background, fully visible and centered, with generous white space around it.",
  simple:
    "- Keep only two or three of the largest, most recognizable background elements from the attached photo (for example one piece of furniture, one tree). Redraw each as one simple closed shape. Leave everything else as empty white space.",
  full: "- Keep the background from the attached photo, but simplify it into a small number of large, clearly separated regions drawn in the same line-art style as the subject.",
};

/** image モードでの、元画像への忠実さ（3段階）。 */
const FIDELITY_LINES: Record<PromptOptions["fidelity"], string> = {
  faithful:
    "- Stay as faithful as possible to the attached photo: keep the same composition, camera angle, pose, and proportions of everything shown. Do not invent a different pose or redesign the subject. You may still drop details that are too small to color, such as individual hairs, scales, wrinkles, shadows, or surface texture.",
  balanced:
    "- Keep the composition, pose, and clearly recognizable features from the attached photo, but simplify small details into larger, simple shapes that are easy to color.",
  simple:
    "- Use the attached photo only as loose reference for what the subject is and roughly how it is posed. Feel free to redraw it as a simple coloring-book design with few lines and large regions, rather than reproducing the photo closely.",
};

/**
 * 日本語の主題から、外部の画像生成AIに貼り付けるための英語塗り絵線画プロンプトを作る（text モード）。
 * このアプリはバックエンド無しのため主題の英訳はせず、主題を Subject にそのまま埋め込む
 * （近年の画像生成AIは日本語主題も解釈できる）。
 */
function buildTextPrompt(theme: string, opts: PromptOptions): string {
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

/**
 * 添付した手持ち画像を線画化させるための英語プロンプトを作る（image モード）。
 * 呼び出し側は生成した画像生成AIに、このプロンプトと一緒に元画像を添付するよう案内すること。
 */
function buildImagePrompt(theme: string, opts: PromptOptions): string {
  const description = theme.trim();
  return [
    "Convert the attached image into black-and-white coloring book line art for young children.",
    "The attached image is the source — do not invent a different subject.",
    ...(description ? [`The attached image shows: ${description}`] : []),
    "",
    "Style requirements:",
    LINE_LINES[opts.line],
    "- Outlines only. No shading, no gray tones, no color, no fills, no textures.",
    FIDELITY_LINES[opts.fidelity],
    IMAGE_BACKGROUND_LINES[opts.background],
    // 背景が無ければ主役しか居ないので、背景まわりの指定は不要
    ...(opts.background === "none"
      ? []
      : [SUBJECT_SEPARATION_LINE, BACKGROUND_REGION_LINE]),
    "- Landscape orientation, 4:3 aspect ratio. Do not crop the subject — add white space or background as needed to fit this ratio.",
    "- No text, no watermark, no border frame.",
  ].join("\n");
}

/**
 * プロンプトを作る。opts.mode に応じて、日本語の主題テキストから作る（text）か、
 * 添付画像を線画化させる指示を作る（image）かを切り替える。
 */
export function buildColoringPrompt(
  theme: string,
  opts: PromptOptions = DEFAULT_PROMPT_OPTIONS,
): string {
  return opts.mode === "image" ? buildImagePrompt(theme, opts) : buildTextPrompt(theme, opts);
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
