// 主役（生き物）の切り出し。
//
// 共有下絵は「主役＝太い輪郭線 / 背景（草・シダ・山・雲）＝細い線」という描き分けで
// 描かれている。そこでモルフォロジー・オープニングで細い線だけを消し、生き残った太線の
// かたまり＝主役の輪郭とみなし、その内側を塗りつぶして主役のシルエットを得る。
//
// 中核 (extractSubjectMasks) は DOM に依存しない純関数にしてある。しきい値の調整を
// Node 側の検証スクリプトから同じコードで回せるようにするため。

/** これ以上のアルファを線とみなす（paint.ts の LINE_ALPHA と同じ考え方） */
const INK_ALPHA = 128;
/**
 * 収縮半径の候補（1024px 幅基準）。半径 R では太さ 2R+1 px 未満の線が消える。
 * 線の太さは絵によってまちまち（背景が細い絵もあれば全体的に太い絵もある）なので、
 * 小さい方から順に試し、最初に「閉じた妥当なシルエット」が取れた半径を採用する。
 * 小さすぎる半径では主役と背景が繋がったままになり、塗りつぶしが画面全体へ漏れて
 * 弾かれるため、この順番で自然に絵ごとの適切な太さが選ばれる。
 */
const ERODE_RADII = [1, 2, 3];
/** 輪郭のすき間を塞ぐ半径（1024px 幅基準）。これ以下の切れ目なら塗りが漏れない */
const CLOSE_R = 5;
/** 最大パーツのこの割合以上の面積を持つかたまりも主役として扱う（対決絵の2体め用） */
const SECONDARY_RATIO = 0.35;
/** 主役として認めるシルエット面積の範囲（画像全体に対する割合） */
const MIN_AREA_RATIO = 0.08;
const MAX_AREA_RATIO = 0.55;
/** 塗りつぶしがこの割合を超えたら輪郭が閉じていない（漏れた）と判断して捨てる */
const LEAK_AREA_RATIO = 0.6;
/**
 * 画像の縁に接している辺の数がこれを超えたら背景を巻き込んだとみなす。
 * 生き物は画面内に収まって描かれるが、地面・草・空は画面外へ流れ出ていくため、
 * 「3辺以上に接する」ことが背景混入のよい目印になる。
 */
const MAX_BORDER_SIDES = 2;
/** シルエットの充填率（面積 / 外接矩形）。これ未満はバラけすぎ＝主役ではない */
const MIN_SOLIDITY = 0.25;
/**
 * シルエットの細いくびれを切る半径（1024px 幅基準）。線幅が主役と背景で同じ絵では、
 * 生き物に「触れている」だけの雲や草まで輪郭が繋がって一体化してしまう。接触部分は
 * 線 2 本ぶんの細い橋にしかならないので、この半径で開いて胴体だけを残し、
 * 元のシルエットの範囲内へ膨らませ直すことで、触れているだけの背景を落とす。
 */
const SEVER_R = 7;

export interface SubjectMask {
  /** 1 = 主役。長さ w*h */
  mask: Uint8Array;
  /** 主役の外接矩形 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** マスクの面積 (px) */
  area: number;
}

/** 1024px 幅を基準にした半径を実サイズに合わせる */
function scaleR(r: number, w: number): number {
  return Math.max(1, Math.round((r * w) / 1024));
}

/** 二値マスクの収縮（範囲外は 0 として扱うので、画像端に触れる線も削られる） */
function erode(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        if (xx < 0 || xx >= w || src[row + xx] === 0) {
          v = 0;
          break;
        }
      }
      tmp[row + x] = v;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let d = -r; d <= r; d++) {
        const yy = y + d;
        if (yy < 0 || yy >= h || tmp[yy * w + x] === 0) {
          v = 0;
          break;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** 二値マスクの膨張 */
function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < w && src[row + xx] === 1) {
          v = 1;
          break;
        }
      }
      tmp[row + x] = v;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -r; d <= r; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < h && tmp[yy * w + x] === 1) {
          v = 1;
          break;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

interface Component {
  pixels: Int32Array;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 8 近傍の連結成分をすべて取り出す */
function connectedComponents(mask: Uint8Array, w: number, h: number): Component[] {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const buf = new Int32Array(w * h);
  const comps: Component[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || seen[start] === 1) continue;
    let sp = 0;
    let n = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;

    while (sp > 0) {
      const p = stack[--sp];
      buf[n++] = p;
      const px = p % w;
      const py = (p - px) / w;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] === 1 && seen[q] === 0) {
            seen[q] = 1;
            stack[sp++] = q;
          }
        }
      }
    }
    comps.push({ pixels: buf.slice(0, n), minX, minY, maxX, maxY });
  }
  return comps;
}

/**
 * 輪郭の内側を塗りつぶしてシルエットにする。
 * 「膨張 → 外側から塗りつぶし → 収縮」の順にすることで、輪郭に 2*r 未満の切れ目が
 * あっても塗りが外へ漏れない。漏れた（＝輪郭が閉じていない）場合は null を返す。
 */
function fillInterior(
  outline: Uint8Array,
  w: number,
  h: number,
  r: number
): Uint8Array | null {
  const grown = dilate(outline, w, h, r);

  // 外周から、線に当たらない範囲を「外側」として塗り広げる
  const outside = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const push = (p: number) => {
    if (grown[p] === 0 && outside[p] === 0) {
      outside[p] = 1;
      queue[tail++] = p;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (head < tail) {
    const p = queue[head++];
    const px = p % w;
    const py = (p - px) / w;
    if (px > 0) push(p - 1);
    if (px < w - 1) push(p + 1);
    if (py > 0) push(p - w);
    if (py < h - 1) push(p + w);
  }

  const solid = new Uint8Array(w * h);
  for (let i = 0; i < solid.length; i++) solid[i] = outside[i] === 0 ? 1 : 0;

  // 膨張のぶんを戻す
  const shrunk = erode(solid, w, h, r);

  let area = 0;
  for (let i = 0; i < shrunk.length; i++) area += shrunk[i];
  if (area > w * h * LEAK_AREA_RATIO || area === 0) return null;
  return shrunk;
}

/**
 * 触れているだけの背景をシルエットから切り離す。
 * 開いて（＝細い橋を断ち切って）残った最大のかたまりを胴体とみなし、元のシルエットの
 * 内側に限って膨らませ直す。無制限に再構成すると橋を渡って元に戻ってしまうので、
 * 膨張は切った半径ぶんだけに留める。
 */
function severThinBridges(sil: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const core = erode(sil, w, h, r);
  const comps = connectedComponents(core, w, h);
  if (comps.length === 0) return sil; // 全部削れるほど細い ＝ 切るものが無い
  comps.sort((a, b) => b.pixels.length - a.pixels.length);

  const largest = new Uint8Array(w * h);
  for (const p of comps[0].pixels) largest[p] = 1;

  const grown = dilate(largest, w, h, r);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = grown[i] === 1 && sil[i] === 1 ? 1 : 0;
  return out;
}

/** シルエットの外接矩形と面積を測り、主役として妥当なら SubjectMask にして返す */
function measure(mask: Uint8Array, w: number, h: number): SubjectMask | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let area = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] === 0) continue;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (area === 0) return null;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (area < w * h * MIN_AREA_RATIO || area > w * h * MAX_AREA_RATIO) return null;
  if (area < bw * bh * MIN_SOLIDITY) return null;

  // 画像の縁に接している辺を数える（3辺以上なら地面や草を巻き込んでいる）
  let sides = 0;
  for (let x = 0; x < w; x++) if (mask[x] === 1) { sides++; break; }
  for (let x = 0; x < w; x++) if (mask[(h - 1) * w + x] === 1) { sides++; break; }
  for (let y = 0; y < h; y++) if (mask[y * w] === 1) { sides++; break; }
  for (let y = 0; y < h; y++) if (mask[y * w + w - 1] === 1) { sides++; break; }
  if (sides > MAX_BORDER_SIDES) return null;

  return { mask, x: minX, y: minY, w: bw, h: bh, area };
}

/** 収縮半径 er を決め打ちして主役候補を取り出す */
function extractAtRadius(
  ink: Uint8Array,
  w: number,
  h: number,
  er: number,
  cr: number
): SubjectMask[] {
  // オープニング（収縮→膨張）で細い線を落とし、太い線だけを元の太さで残す
  const thick = dilate(erode(ink, w, h, er), w, h, er);

  const comps = connectedComponents(thick, w, h);
  if (comps.length === 0) return [];
  comps.sort((a, b) => b.pixels.length - a.pixels.length);
  const minOutline = comps[0].pixels.length * SECONDARY_RATIO;

  const out: SubjectMask[] = [];
  for (const comp of comps) {
    if (comp.pixels.length < minOutline) break;
    const outline = new Uint8Array(w * h);
    for (const p of comp.pixels) outline[p] = 1;

    const silhouette = fillInterior(outline, w, h, cr);
    if (!silhouette) continue;
    const m = measure(severThinBridges(silhouette, w, h, scaleR(SEVER_R, w)), w, h);
    if (m) out.push(m);
  }
  out.sort((a, b) => b.area - a.area);
  return out;
}

/**
 * 線画のアルファチャンネルから主役のシルエットを取り出す。
 * 面積の大きい順に返す（対決絵などで 2 体見つかることがある）。見つからなければ空配列。
 */
export function extractSubjectMasks(alpha: Uint8Array, w: number, h: number): SubjectMask[] {
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = alpha[i] >= INK_ALPHA ? 1 : 0;

  const cr = scaleR(CLOSE_R, w);
  for (const r of ERODE_RADII) {
    const found = extractAtRadius(ink, w, h, scaleR(r, w), cr);
    if (found.length > 0) return found;
  }
  return [];
}
