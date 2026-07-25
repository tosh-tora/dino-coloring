// 主役（生き物）の切り出し。
//
// 共有下絵は「主役＝太い輪郭線 / 背景（草・シダ・山・雲）＝細い線」という描き分けで
// 描かれている。そこでモルフォロジー・オープニングで細い線だけを消し、残った太線を
// 主役の輪郭とみなして内側を塗りつぶし、シルエットを得る。
//
// 手前の草に隠れて輪郭が途切れている絵が多いため、塗りつぶす前にクロージングで断片を
// 繋ぐ。この 2 つの半径の最適値は絵ごとに大きく違うので、組み合わせを総当たりし、
// 「シルエットの縁がどれだけ太線の上に乗っているか」(outlineCoverage) が最も高いものを
// 採用する。線幅が主役と背景で変わらない絵は原理的に分離できず、confidence が下がる。
//
// 中核 (extractSubjectMasks) は DOM に依存しない純関数にしてある。しきい値の調整を
// Node 側の検証スクリプトから同じコードで回せるようにするため。

/** これ以上のアルファを線とみなす（paint.ts の LINE_ALPHA と同じ考え方） */
const INK_ALPHA = 128;
/**
 * 収縮半径の候補（1024px 幅基準）。半径 R では太さ 2R+1 px 未満の線が消える。
 * 線の太さは絵によってまちまち（背景が細い絵もあれば全体的に太い絵もある）なので、
 * 小さい方から順に試す。小さすぎる半径では主役と背景が繋がったままになり、塗りつぶしが
 * 画面全体へ漏れて弾かれるため、この順番で自然に絵ごとの適切な太さが選ばれる。
 */
const ERODE_RADII = [1, 2, 3];
/**
 * 輪郭のすき間を塞ぐ半径の候補（1024px 幅基準）。手前の草に隠れて輪郭が途切れている絵は
 * 大きい値でないと閉じないが、大きすぎると背景まで橋渡ししてしまう。これも絵ごとに
 * 最適値が違うので候補を総当たりし、後述の「輪郭一致率」が最も高い組み合わせを選ぶ。
 */
const CLOSE_RADII = [1, 3, 5, 8, 12];
/**
 * 採用に必要な輪郭一致率。これを満たす組み合わせが見つかった時点で探索を打ち切る。
 * 満たすものが無ければ、一致率が最も高かった候補を confidence 付きで返す。
 */
const GOOD_COVERAGE = 0.9;
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
/**
 * 切り分けたあと、最大のかたまりのこの割合以上を主役候補として残す。
 * 隣り合う 2 体目を拾いつつ、触れているだけの草や石は落とせる値にしてある。
 */
const SEVER_KEEP_RATIO = 0.3;

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
  /**
   * 輪郭一致率 0〜1。シルエットの縁が「太い線」の上に乗っている割合。
   * 主役の輪郭に沿って切り抜けていれば 1 に近く、背景の細い草などを巻き込んで
   * 切れていると下がる。呼び出し側が演出に使うか諦めるかの判断に使える。
   */
  confidence: number;
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
 * シルエットを細いくびれで切り分ける。
 *
 * 開く（＝細い橋を断ち切る）と、触れているだけの背景も、隣り合って立っている 2 体目も
 * 別のかたまりになる。それぞれを元のシルエットの内側に限って膨らませ直して返す。
 * 無制限に再構成すると橋を渡って元に戻ってしまうので、膨張は切った半径ぶんに留める。
 *
 * 返すのは十分な大きさのかたまりだけ。小さいものは草や石なので落とす。呼び出し側が
 * さらに measure() で主役として妥当かを見る。
 */
function severThinBridges(sil: Uint8Array, w: number, h: number, r: number): Uint8Array[] {
  const core = erode(sil, w, h, r);
  const comps = connectedComponents(core, w, h);
  if (comps.length === 0) return [sil]; // 全部削れるほど細い ＝ 切るものが無い
  comps.sort((a, b) => b.pixels.length - a.pixels.length);

  const minCore = comps[0].pixels.length * SEVER_KEEP_RATIO;
  const out: Uint8Array[] = [];
  for (const comp of comps) {
    if (comp.pixels.length < minCore) break;
    const part = new Uint8Array(w * h);
    for (const p of comp.pixels) part[p] = 1;
    const grown = dilate(part, w, h, r);
    for (let i = 0; i < grown.length; i++) grown[i] = grown[i] === 1 && sil[i] === 1 ? 1 : 0;
    out.push(grown);
  }
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

  return { mask, x: minX, y: minY, w: bw, h: bh, area, confidence: 0 };
}

/**
 * シルエットの縁が太い線の上に乗っている割合を測る。
 *
 * 塗りつぶしは必ず何らかの線で止まるが、主役の輪郭に沿って止まったのか、背景の細い草に
 * 沿って止まったのかはこれで見分けられる。太い線＝主役の輪郭なので、一致率が高いほど
 * 「生き物のかたちで切り抜けている」ことになる。半径の組み合わせを選ぶ物差しに使う。
 */
function outlineCoverage(
  sil: Uint8Array,
  nearThick: Uint8Array,
  w: number,
  h: number
): number {
  const inner = erode(sil, w, h, 1);
  let edge = 0;
  let on = 0;
  for (let i = 0; i < sil.length; i++) {
    if (sil[i] === 1 && inner[i] === 0) {
      edge++;
      if (nearThick[i] === 1) on++;
    }
  }
  return edge === 0 ? 0 : on / edge;
}

/** 太線マスクとすき間埋め半径を決め打ちして主役候補を取り出す */
function extractWithRadii(
  thick: Uint8Array,
  nearThick: Uint8Array,
  w: number,
  h: number,
  cr: number
): SubjectMask[] {
  // 手前の草などに隠れて輪郭は途切れがちなので、クロージングで近い断片を繋ぐ。
  // 断片ごとに塗りつぶすと必ず漏れるため、繋いでから一括で内側を塗る。
  const joined = erode(dilate(thick, w, h, cr), w, h, cr);

  const filled = fillInterior(joined, w, h, cr);
  if (!filled) return [];

  // 塗り終えたシルエットを個体ごとに分ける（対決絵なら 2 体に分かれる）
  const comps = connectedComponents(filled, w, h);
  if (comps.length === 0) return [];
  comps.sort((a, b) => b.pixels.length - a.pixels.length);
  const minArea = comps[0].pixels.length * SECONDARY_RATIO;

  const out: SubjectMask[] = [];
  for (const comp of comps) {
    if (comp.pixels.length < minArea) break;
    const silhouette = new Uint8Array(w * h);
    for (const p of comp.pixels) silhouette[p] = 1;

    for (const part of severThinBridges(silhouette, w, h, scaleR(SEVER_R, w))) {
      const m = measure(part, w, h);
      if (!m) continue;
      m.confidence = outlineCoverage(m.mask, nearThick, w, h);
      out.push(m);
    }
  }
  out.sort((a, b) => b.area - a.area);
  return out;
}

/** 面積で重み付けした平均一致率。半径の組み合わせ同士を比べるためのスコア */
function setScore(subjects: SubjectMask[]): number {
  let area = 0;
  let sum = 0;
  for (const s of subjects) {
    area += s.area;
    sum += s.confidence * s.area;
  }
  return area === 0 ? 0 : sum / area;
}

/**
 * 線画のアルファチャンネルから主役のシルエットを取り出す。
 * 面積の大きい順に返す（対決絵などで 2 体見つかることがある）。見つからなければ空配列。
 *
 * 収縮半径（背景の細線をどこまで落とすか）とすき間埋め半径（途切れた輪郭をどこまで繋ぐか）
 * の最適値は絵ごとに違うため、総当たりして輪郭一致率が最も高い組み合わせを採用する。
 */
export function extractSubjectMasks(alpha: Uint8Array, w: number, h: number): SubjectMask[] {
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = alpha[i] >= INK_ALPHA ? 1 : 0;

  let best: SubjectMask[] = [];
  let bestScore = -1;

  for (const erBase of ERODE_RADII) {
    const er = scaleR(erBase, w);
    // オープニング（収縮→膨張）で細い線を落とし、太い線だけを元の太さで残す
    const thick = dilate(erode(ink, w, h, er), w, h, er);
    // 一致判定は多少のズレを許す（塗りつぶしは線の内側で止まるため）
    const nearThick = dilate(thick, w, h, scaleR(3, w));

    for (const crBase of CLOSE_RADII) {
      const found = extractWithRadii(thick, nearThick, w, h, scaleR(crBase, w));
      if (found.length === 0) continue;
      const score = setScore(found);
      if (score > bestScore) {
        bestScore = score;
        best = found;
      }
      // 十分きれいに取れたら、これ以上半径を上げて歪ませる必要はない
      if (score >= GOOD_COVERAGE) return found;
    }
  }
  return best;
}
