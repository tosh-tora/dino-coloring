// レベル判定の中核。DOM にも Node にも依存しない純粋なコードだけを置く。
//
// ブラウザ（src/level.ts）と、共有下絵の判定を焼き込む CLI
// （scripts/compute-art-levels.mjs）の両方から使う。しきい値を 2 箇所に書くと必ず
// ずれるので、アルゴリズムと定数はこのファイルだけに持つ。
//
// 判定は下絵を 256x192 に縮小したアルファ（＝線の濃さ）だけで行う軽い方法。
// 4歳児にとっての難しさは「線の数」ではなく次の 2つで決まる、という見立てで測る:
//
//   - 細い線の量（fine）: 縮小すると太い線は濃いまま残り、羽根・毛・草・ハッチングの
//     ような細い線は薄くなる。「薄いのに 濃い線の隣ではない」画素だけを数えれば、
//     太い線のフチ（アンチエイリアス）と区別して細い線だけを拾える
//   - 小さい領域の広さ（small）: 塗れる面積のうち、小さな区画が占める割合。
//     うろこ・羽・模様のような細かい塗り分けほど大きくなる
//
// ふたつの見立ての「難しい方」を採る。領域の"数"を使うと、大きな葉が並ぶだけの
// 素朴な絵（velociraptor）が難しい側に、細い線だらけの絵（fukuivenator）が簡単側に
// 落ちてしまうため、数ではなく「細さ」と「小ささ」で測っている。

export type Level = 1 | 2 | 3;

export const LEVELS: Level[] = [1, 2, 3];

/** 子ども向けの表示（星の数）。 */
export const LEVEL_MARK: Record<Level, string> = { 1: "★", 2: "★★", 3: "★★★" };

/** 大人向けの説明ラベル。 */
export const LEVEL_NAME: Record<Level, string> = {
  1: "簡単",
  2: "普通",
  3: "難しい",
};

/** 判定に使う縮小サイズ。1024x768 の 1/4（4:3 を保つ）。 */
export const ANALYZE_W = 256;
export const ANALYZE_H = 192;

/** これ以上のアルファを「線」とみなす。縮小で薄くなった細線も拾えるよう低めにする。 */
const INK_ALPHA = 48;

/** これ以上のアルファは「太い線」。縮小しても濃さが残るのは太い線だけ。 */
const STRONG_ALPHA = 200;

/** これ未満の面積（全画素に対する割合）の区画を「小さい領域」として数える。 */
const SMALL_REGION_FRAC = 0.01;

// しきい値は同梱の下絵の実測と、実際に見て付けた正解ラベルから決めた。
// 細い線の量: 組み込み SVG（太線のみ）は 0、素朴な共有下絵が 0.1〜1.5、
//   羽根やハッチングのある下絵が 2.7〜13。
// 小さい領域: 素朴な下絵が 0〜15%、うろこ・翅のような細かい絵が 21〜31%。
const FINE_MAX_L1 = 0.4;
const FINE_MAX_L2 = 2.5;
const SMALL_MAX_L1 = 8;
const SMALL_MAX_L2 = 20;

/** 白背景を透明にする境界。これ以上明るい画素は完全に透明。 */
const LUM_HI = 235;
/** これ以下の暗さは線としてそのまま残す。あいだは線形に減衰。 */
const LUM_LO = 190;

/**
 * 白背景の線画 1 画素を「線の濃さ」に変換する。明るいほど透明。
 * 下絵の透明化（template.ts）と、CLI での判定の両方で使う共通の規則。
 */
export function lineAlpha(r: number, g: number, b: number, a: number): number {
  if (a === 0) return 0;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b; // 知覚輝度
  if (lum >= LUM_HI) return 0;
  if (lum > LUM_LO) return Math.round(a * ((LUM_HI - lum) / (LUM_HI - LUM_LO)));
  return a;
}

/**
 * 白背景の線画 1 画素を下絵の画素に変換して RGBA バッファへ書き戻し、
 * 線の濃さ（アルファ）を返す。i は画素の先頭バイト位置。
 *
 * 線の"色"はどこにも使っていない（塗りは下のレイヤーから透け、はみだしガード
 * (paint.ts) ・主役の切り抜き (cutout.ts) ・レベル判定はすべてアルファだけを見る）ので
 * RGB は黒に潰す。3 チャンネルが一様になるぶん PNG が縮み、同梱の下絵で実測 2〜6 割。
 * アップロード画像は data URL のまま IndexedDB に入るので、そのまま端末の使用量が減る。
 *
 * px の型を添字アクセスだけにしてあるのは、ブラウザの Uint8ClampedArray（ImageData）と
 * CLI 側の Buffer（scripts/lib/lineart-raw.mjs）を同じ関数で扱うため。
 */
export function writeLinePixel(px: { [i: number]: number }, i: number): number {
  const a = lineAlpha(px[i], px[i + 1], px[i + 2], px[i + 3]);
  px[i] = 0;
  px[i + 1] = 0;
  px[i + 2] = 0;
  px[i + 3] = a;
  return a;
}

/**
 * 等倍のアルファを面積平均で ANALYZE_W x ANALYZE_H に縮小する。
 *
 * 縮小をブラウザ（drawImage の転送先を小さくする）に任せないのが要点。drawImage の
 * 縮小フィルターの品質は仕様で決まっておらず、Chrome は面積平均するが WebKit
 * （iPad / Safari）は安価な間引きで済ませる。fine はアンチエイリアスされた薄い画素だけを
 * 見る指標なので、間引かれると真っ先に消え、iPad では ★3 がほぼ消えて大半が ★1 に
 * なっていた（fine が 15.5 → 0.1 まで落ちる下絵もあった）。例外は出ないので
 * 「もっともらしい ★1」として黙って壊れる。
 *
 * srcW/srcH は ANALYZE_W/ANALYZE_H の整数倍であること（下絵は 1024x768 に正規化済み）。
 */
export function downscaleAlpha(alpha: Uint8Array, srcW: number, srcH: number): Uint8Array {
  const sx = srcW / ANALYZE_W;
  const sy = srcH / ANALYZE_H;
  if (!Number.isInteger(sx) || !Number.isInteger(sy)) {
    throw new Error(`縮小率が整数でない: ${srcW}x${srcH} → ${ANALYZE_W}x${ANALYZE_H}`);
  }
  const out = new Uint8Array(ANALYZE_W * ANALYZE_H);
  const block = sx * sy;
  for (let y = 0; y < ANALYZE_H; y++) {
    for (let x = 0; x < ANALYZE_W; x++) {
      let sum = 0;
      for (let dy = 0; dy < sy; dy++) {
        const row = (y * sy + dy) * srcW + x * sx;
        for (let dx = 0; dx < sx; dx++) sum += alpha[row + dx];
      }
      out[y * ANALYZE_W + x] = Math.round(sum / block);
    }
  }
  return out;
}

/**
 * 縮小した下絵のアルファ配列からレベルを判定する。
 * alpha は w*h 個の 0..255。
 */
export function estimateLevel(alpha: Uint8Array, w: number, h: number): Level {
  const total = w * h;
  const ink = new Uint8Array(total);
  const strong = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (alpha[i] >= INK_ALPHA) {
      ink[i] = 1;
      if (alpha[i] >= STRONG_ALPHA) strong[i] = 1;
    }
  }

  // 細い線の量: 薄い線の画素のうち、太い線に接していないもの（＝太線のフチではなく
  // それ自体が細い線）が画面に占める割合。
  let fineCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!ink[i] || strong[i]) continue;
      let nearStrong = false;
      for (let dy = -1; dy <= 1 && !nearStrong; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (strong[ny * w + nx]) {
            nearStrong = true;
            break;
          }
        }
      }
      if (!nearStrong) fineCount++;
    }
  }

  // 小さい領域の広さ: 線でない画素の連結成分（4近傍）を塗りつぶしながら面積を測り、
  // 塗れる面積のうち小さな区画が占める割合を出す。明示スタックで再帰を避ける。
  const smallArea = Math.round(total * SMALL_REGION_FRAC);
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  let paintable = 0;
  let smallSum = 0;
  for (let start = 0; start < total; start++) {
    if (ink[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let area = 0;
    while (sp > 0) {
      const p = stack[--sp];
      area++;
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0 && !ink[p - 1] && !seen[p - 1]) {
        seen[p - 1] = 1;
        stack[sp++] = p - 1;
      }
      if (x < w - 1 && !ink[p + 1] && !seen[p + 1]) {
        seen[p + 1] = 1;
        stack[sp++] = p + 1;
      }
      if (y > 0 && !ink[p - w] && !seen[p - w]) {
        seen[p - w] = 1;
        stack[sp++] = p - w;
      }
      if (y < h - 1 && !ink[p + w] && !seen[p + w]) {
        seen[p + w] = 1;
        stack[sp++] = p + w;
      }
    }
    paintable += area;
    if (area < smallArea) smallSum += area;
  }

  const fine = (fineCount / total) * 100;
  const small = paintable > 0 ? (smallSum / paintable) * 100 : 0;
  const byFine: Level = fine <= FINE_MAX_L1 ? 1 : fine <= FINE_MAX_L2 ? 2 : 3;
  const bySmall: Level = small <= SMALL_MAX_L1 ? 1 : small <= SMALL_MAX_L2 ? 2 : 3;
  return Math.max(byFine, bySmall) as Level;
}

/** 等倍のアルファ（srcW x srcH）から直接レベルを出す。縮小と判定をまとめたもの。 */
export function levelFromAlpha(alpha: Uint8Array, srcW: number, srcH: number): Level {
  return estimateLevel(downscaleAlpha(alpha, srcW, srcH), ANALYZE_W, ANALYZE_H);
}
