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
 *
 * エッジ検出だと弱い輪郭（顔のパーツなど）が消えたり線が途切れたりするため、
 * 色の k-means 量子化で画像を数種類の「塗り分け領域」に分割し、領域どうしの
 * 境界を線として描く。領域の境界線は構造上必ず閉じるので、ぬりえとして
 * 塗り分けられる絵になる。
 */
export function photoToColoringDataUrl(img: HTMLImageElement): string {
  // 処理解像度。小さくするほど細部が落ちてシンプルになり、
  // 最終キャンバスへの拡大率が上がって線も太くなる。
  const MAX = 320;
  // 色クラスタ数。多いほど細かく塗り分けられ、少ないほどシンプルになる。
  const K = 7;
  const s = Math.min(1, MAX / Math.max(img.width, img.height));
  const w = Math.max(8, Math.round(img.width * s));
  const h = Math.max(8, Math.round(img.height * s));
  const n = w * h;

  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const sctx = small.getContext("2d")!;
  sctx.fillStyle = "#fff";
  sctx.fillRect(0, 0, w, h);
  sctx.filter = "blur(1px)"; // 質感・ノイズをならす（色は保持）
  // 少しはみ出して描画し、ぼかしが画像端で白背景と混ざってできる
  // 縁取り（額縁状の線）を防ぐ
  sctx.drawImage(img, -2, -2, w + 4, h + 4);
  sctx.filter = "none";
  const px = sctx.getImageData(0, 0, w, h).data;

  // --- k-means で色を K クラスタに量子化 ---
  // 初期値: 明度順に並べたサンプルから等間隔に取る（明暗の階調を確実に拾う）
  const cent = new Float32Array(K * 3);
  {
    const samples: number[] = [];
    for (let i = 0; i < n; i += 13) samples.push(i);
    const lumOf = (i: number) =>
      0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    samples.sort((a, b) => lumOf(a) - lumOf(b));
    for (let k = 0; k < K; k++) {
      const i = samples[Math.floor(((k + 0.5) * samples.length) / K)];
      cent[k * 3] = px[i * 4];
      cent[k * 3 + 1] = px[i * 4 + 1];
      cent[k * 3 + 2] = px[i * 4 + 2];
    }
  }
  let lab = new Uint8Array(n);
  for (let iter = 0; iter < 8; iter++) {
    const sum = new Float64Array(K * 4);
    for (let i = 0; i < n; i++) {
      const r = px[i * 4];
      const g = px[i * 4 + 1];
      const b = px[i * 4 + 2];
      let best = 0;
      let bd = Infinity;
      for (let k = 0; k < K; k++) {
        const dr = r - cent[k * 3];
        const dg = g - cent[k * 3 + 1];
        const db = b - cent[k * 3 + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      lab[i] = best;
      sum[best * 4] += r;
      sum[best * 4 + 1] += g;
      sum[best * 4 + 2] += b;
      sum[best * 4 + 3]++;
    }
    for (let k = 0; k < K; k++) {
      const c = sum[k * 4 + 3];
      if (c > 0) {
        cent[k * 3] = sum[k * 4] / c;
        cent[k * 3 + 1] = sum[k * 4 + 1] / c;
        cent[k * 3 + 2] = sum[k * 4 + 2] / c;
      }
    }
  }

  // --- 色が近いクラスタ同士を統合 ---
  // 空や壁のグラデーションが数本の縞（帯状の領域境界）になるのを防ぐ。
  // 統合後も境界はラベル差から作るので、線が閉じる性質は変わらない。
  {
    const MERGE_DIST = 48;
    const parent = Array.from({ length: K }, (_, i) => i);
    const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
    for (let a = 0; a < K; a++) {
      for (let b = a + 1; b < K; b++) {
        const dr = cent[a * 3] - cent[b * 3];
        const dg = cent[a * 3 + 1] - cent[b * 3 + 1];
        const db = cent[a * 3 + 2] - cent[b * 3 + 2];
        if (Math.sqrt(dr * dr + dg * dg + db * db) < MERGE_DIST) parent[find(a)] = find(b);
      }
    }
    for (let i = 0; i < n; i++) lab[i] = find(lab[i]);
  }

  // --- 3×3 多数決フィルタでギザギザ境界を除去 ---
  // （2回かけると細い要素まで消えるので1回。斑点は後段の小領域併合が消す）
  for (let pass = 0; pass < 1; pass++) {
    const out = new Uint8Array(n);
    const count = new Uint8Array(K);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        count.fill(0);
        let best = lab[y * w + x];
        let bc = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const l = lab[yy * w + xx];
            if (++count[l] > bc) {
              bc = count[l];
              best = l;
            }
          }
        }
        out[y * w + x] = best;
      }
    }
    lab = out;
  }

  // --- 小さすぎる領域を隣の領域に併合（ゴマ粒領域を消してシンプルにする） ---
  // 連結成分を求め、小さい成分は隣接画素のクラスタ多数決で塗り替える。
  const MIN_REGION = Math.max(24, Math.round(n * 0.001));
  const comp = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const compSize: number[] = [];
  const compLabel: number[] = [];
  let ncomp = 0;
  for (let i0 = 0; i0 < n; i0++) {
    if (comp[i0] >= 0) continue;
    const l = lab[i0];
    let head = 0;
    let tail = 0;
    queue[tail++] = i0;
    comp[i0] = ncomp;
    while (head < tail) {
      const j = queue[head++];
      const x = j % w;
      if (x > 0 && comp[j - 1] < 0 && lab[j - 1] === l) { comp[j - 1] = ncomp; queue[tail++] = j - 1; }
      if (x < w - 1 && comp[j + 1] < 0 && lab[j + 1] === l) { comp[j + 1] = ncomp; queue[tail++] = j + 1; }
      if (j >= w && comp[j - w] < 0 && lab[j - w] === l) { comp[j - w] = ncomp; queue[tail++] = j - w; }
      if (j < n - w && comp[j + w] < 0 && lab[j + w] === l) { comp[j + w] = ncomp; queue[tail++] = j + w; }
    }
    compSize.push(tail);
    compLabel.push(l);
    ncomp++;
  }
  const votes = new Uint32Array(ncomp * K);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x < w - 1 && comp[i] !== comp[i + 1]) {
        votes[comp[i] * K + lab[i + 1]]++;
        votes[comp[i + 1] * K + lab[i]]++;
      }
      if (y < h - 1 && comp[i] !== comp[i + w]) {
        votes[comp[i] * K + lab[i + w]]++;
        votes[comp[i + w] * K + lab[i]]++;
      }
    }
  }
  const newLabel = compLabel.slice();
  for (let c = 0; c < ncomp; c++) {
    if (compSize[c] >= MIN_REGION) continue;
    let best = compLabel[c];
    let bc = 0;
    for (let k = 0; k < K; k++) {
      if (votes[c * K + k] > bc) {
        bc = votes[c * K + k];
        best = k;
      }
    }
    newLabel[c] = best;
  }
  for (let i = 0; i < n; i++) lab[i] = newLabel[comp[i]];

  // --- 領域の境界を線にする ---
  const edge = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if ((x < w - 1 && lab[i] !== lab[i + 1]) || (y < h - 1 && lab[i] !== lab[i + w])) edge[i] = 1;
    }
  }

  // 膨張1回で線を太らせる（このあとの拡大でさらに太くなる）
  const fat = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (
        edge[i] ||
        (x > 0 && edge[i - 1]) ||
        (x < w - 1 && edge[i + 1]) ||
        (y > 0 && edge[i - w]) ||
        (y < h - 1 && edge[i + w])
      )
        fat[i] = 1;
    }
  }

  // 黒線＋透明背景にして 1024×768 へ contain 配置
  const lineData = sctx.createImageData(w, h);
  for (let i = 0; i < n; i++) lineData.data[i * 4 + 3] = fat[i] ? 255 : 0;
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
