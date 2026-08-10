// 主役（生き物）の切り出し。
//
// 共有下絵は「主役＝太い輪郭線 / 背景（草・シダ・山・雲）＝細い線」という描き分けで
// 描かれている。そこでモルフォロジー・オープニングで細い線だけを消し、残った太線を
// 主役の輪郭とみなして内側を塗りつぶし、シルエットを得る。
//
// 手前の草に隠れて輪郭が途切れている絵が多いため、塗りつぶす前にクロージングで断片を
// 繋ぐ。この 2 つの半径の最適値は絵ごとに大きく違うので、組み合わせを総当たりし、
// 「シルエットの縁がどれだけ太線の上に乗っているか」(edgeCoverage) が最も高いものを
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
/** シルエットの充填率（面積 / 外接矩形）。これ未満はバラけすぎ＝主役ではない */
const MIN_SOLIDITY = 0.25;
/**
 * シルエットの細いくびれを切る半径（1024px 幅基準）。線幅が主役と背景で同じ絵では、
 * 生き物に「触れている」だけの雲や草まで輪郭が繋がって一体化してしまう。接触部分は
 * 線 2 本ぶんの細い橋にしかならないので、この半径で開いて胴体と背景を別々のかたまりに
 * 分け、シルエットの画素をいちばん近いかたまりへ割り当て直して背景を落とす。
 */
const SEVER_R = 7;
/**
 * 切り分けたあと、かたまりから何 px 先までシルエットを戻すか（1024px 幅基準）。
 * くちばし・翼・とさかの先のように細くて kernel に残らない部分は、たかだかこのくらいしか
 * 本体から離れていない（同梱の下絵の実測では最遠でも 51px）。いっぽう地面や氷の稜線の
 * ような「細いまま画面を横切る線」は数百 px 伸びるので、ここで打ち切って背景として捨てる。
 */
const SEVER_REACH = 60;
/**
 * 切り分けたあと、最大のかたまりのこの割合以上を主役候補として残す。
 * 隣り合う 2 体目を拾いつつ、触れているだけの草や石は落とせる値にしてある。
 */
const SEVER_KEEP_RATIO = 0.3;
/**
 * 「いちばん太い線」の物差しを作るとき、太線マスクに最低限残っていてほしいインクの割合。
 * これを満たす中でいちばん厳しい収縮半径を選ぶので、背景も主役も同じ細さで描かれた絵では
 * 自然に緩い（＝ほぼ全部の線を太線とみなす）物差しになる。
 */
const STRONG_INK_RATIO = 0.15;
/**
 * 手放す領域の縁がこの割合以上「いちばん太い線」に乗っていたら、それは背景ではなく
 * 生き物の一部（切り落とされた頭など）とみなす。
 */
const BODY_PART_COVERAGE = 0.7;
/**
 * 逆に、増える領域を「欠けていた体が戻ってきた」と認めるのに要る割合。
 * 手放す側より厳しい理由は addsOnlyBody を参照。
 */
const GROW_BODY_COVERAGE = 0.95;
/** 大きいシルエットへ乗り換えるときに許す、シルエット全体の輪郭一致率の下がりしろ */
const GROW_SCORE_DROP = 0.005;

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
 * 左右で完結していない（画面の外へ続いている）区画のうち、いちばん大きいものの面積。
 *
 * 「対決」の絵などでは、恐竜が画面いっぱいに描かれて胴やしっぽが画面の外へ切れている
 * ことがある。切れた生き物の内側は画像の縁と地続きなので、輪郭の内側を塗る方式では
 * シルエットにならず、代わりに背びれのような「体の一部」だけが閉じた区画として残る。
 * それを動かすと体の一部が本体から剥がれて跳ねてしまうので、呼び出し側は「切り抜けた
 * 主役より大きい区画が画面の外へ続いている」なら、その絵では演出を諦める。
 *
 * 数え方は、輪郭で仕切った紙の区画のうち「画像の一辺だけ、それも左右どちらかに接して
 * いるもの」。空や地面は画面の外へ流れ出ていくので複数の辺にまたがり（水面のような
 * 横帯なら左右の両方に接する）、切れた生き物の胴だけがこの条件に当たる。
 */
function clippedArea(joined: Uint8Array, w: number, h: number, r: number): number {
  const grown = dilate(joined, w, h, r);
  const paper = new Uint8Array(w * h);
  for (let i = 0; i < paper.length; i++) paper[i] = grown[i] === 0 ? 1 : 0;

  let max = 0;
  for (const comp of connectedComponents(paper, w, h)) {
    if (comp.pixels.length <= max) continue;
    const sides =
      (comp.minX === 0 ? 1 : 0) +
      (comp.maxX === w - 1 ? 1 : 0) +
      (comp.minY === 0 ? 1 : 0) +
      (comp.maxY === h - 1 ? 1 : 0);
    if (sides !== 1 || (comp.minX !== 0 && comp.maxX !== w - 1)) continue;
    max = comp.pixels.length;
  }
  return max;
}

/**
 * シルエットを細いくびれで切り分ける。
 *
 * 開く（＝細い橋を断ち切る）と、触れているだけの背景も、隣り合って立っている 2 体目も
 * 別のかたまり（core）になる。そのあとシルエットの画素を「いちばん近い core」へ
 * 割り当て直し、十分な大きさの core のぶんだけを返す。小さい core は草や石なので落とす。
 * 呼び出し側がさらに measure() で主役として妥当かを見る。
 *
 * 距離はシルエットの内側だけを通って測る（core を種にした多点 BFS）。以前のように膨張で
 * 戻すと、くびれより細い先端 — くちばし・翼・とさかの先 — が core から届かず永久に欠けた。
 * 戻すのは reach px 先まで。core を持てないほど細い背景（幅 2r+1 px 未満）はここで本体に
 * 吸われてしまうが、地面や氷の稜線のように長く伸びる線は reach で頭打ちになる。
 */
function severThinBridges(
  sil: Uint8Array,
  w: number,
  h: number,
  r: number,
  reach: number
): Uint8Array[] {
  const core = erode(sil, w, h, r);
  const comps = connectedComponents(core, w, h);
  if (comps.length === 0) return [sil]; // 全部削れるほど細い ＝ 切るものが無い
  comps.sort((a, b) => b.pixels.length - a.pixels.length);

  // すべての core を同時に広げるので、橋の上では両側からの距離が等しいところで分かれる
  const label = new Int32Array(w * h).fill(-1);
  const dist = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  comps.forEach((comp, i) => {
    for (const p of comp.pixels) {
      label[p] = i;
      queue[tail++] = p;
    }
  });
  while (head < tail) {
    const p = queue[head++];
    if (dist[p] >= reach) continue;
    const px = p % w;
    const py = (p - px) / w;
    const push = (q: number) => {
      if (sil[q] === 1 && label[q] === -1) {
        label[q] = label[p];
        dist[q] = dist[p] + 1;
        queue[tail++] = q;
      }
    };
    if (px > 0) push(p - 1);
    if (px < w - 1) push(p + 1);
    if (py > 0) push(p - w);
    if (py < h - 1) push(p + w);
  }

  const minCore = comps[0].pixels.length * SEVER_KEEP_RATIO;
  const out: Uint8Array[] = [];
  for (let i = 0; i < comps.length; i++) {
    if (comps[i].pixels.length < minCore) break;
    const part = new Uint8Array(w * h);
    for (let p = 0; p < part.length; p++) if (label[p] === i) part[p] = 1;
    out.push(part);
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

  // 左右の縁に触れているシルエットは、そこで切れている＝生き物が画面に収まっていない。
  // 足が地面（下の縁）に着くのは普通なので、左右だけを落とす
  for (let y = 0; y < h; y++) if (mask[y * w] === 1) return null;
  for (let y = 0; y < h; y++) if (mask[y * w + w - 1] === 1) return null;

  return { mask, x: minX, y: minY, w: bw, h: bh, area, confidence: 0 };
}

/**
 * 領域の縁が線（near）の上に乗っている割合を測る。
 *
 * 塗りつぶしは必ず何らかの線で止まるが、主役の輪郭に沿って止まったのか、背景の細い草に
 * 沿って止まったのかはこれで見分けられる。太い線＝主役の輪郭なので、一致率が高いほど
 * 「生き物のかたちで切り抜けている」ことになる。シルエット全体に使えば半径の組み合わせを
 * 選ぶ物差しに、候補同士の差分に使えば「そこは体の一部か背景か」の判定になる。
 */
function edgeCoverage(region: Uint8Array, near: Uint8Array, w: number, h: number): number {
  const inner = erode(region, w, h, 1);
  let edge = 0;
  let on = 0;
  for (let i = 0; i < region.length; i++) {
    if (region[i] === 1 && inner[i] === 0) {
      edge++;
      if (near[i] === 1) on++;
    }
  }
  return edge === 0 ? 0 : on / edge;
}

/** a にあって b に無い画素（候補同士の差分を測るため） */
function diffMask(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < out.length; i++) out[i] = a[i] === 1 && b[i] === 0 ? 1 : 0;
  return out;
}

interface Extraction {
  subjects: SubjectMask[];
  /** 画面の外へ続いている、いちばん大きい区画の面積 (px) */
  clipped: number;
}

/** 太線マスクとすき間埋め半径を決め打ちして主役候補を取り出す */
function extractWithRadii(
  thick: Uint8Array,
  nearThick: Uint8Array,
  w: number,
  h: number,
  cr: number
): Extraction {
  // 手前の草などに隠れて輪郭は途切れがちなので、クロージングで近い断片を繋ぐ。
  // 断片ごとに塗りつぶすと必ず漏れるため、繋いでから一括で内側を塗る。
  const joined = erode(dilate(thick, w, h, cr), w, h, cr);

  const filled = fillInterior(joined, w, h, cr);
  if (!filled) return { subjects: [], clipped: 0 };

  // 塗り終えたシルエットを個体ごとに分ける（対決絵なら 2 体に分かれる）
  const comps = connectedComponents(filled, w, h);
  if (comps.length === 0) return { subjects: [], clipped: 0 };
  comps.sort((a, b) => b.pixels.length - a.pixels.length);
  const minArea = comps[0].pixels.length * SECONDARY_RATIO;

  const out: SubjectMask[] = [];
  for (const comp of comps) {
    if (comp.pixels.length < minArea) break;
    const silhouette = new Uint8Array(w * h);
    for (const p of comp.pixels) silhouette[p] = 1;

    const parts = severThinBridges(silhouette, w, h, scaleR(SEVER_R, w), scaleR(SEVER_REACH, w));
    for (const part of parts) {
      const m = measure(part, w, h);
      if (!m) continue;
      m.confidence = edgeCoverage(m.mask, nearThick, w, h);
      out.push(m);
    }
  }
  out.sort((a, b) => b.area - a.area);
  // 候補が無い組み合わせでは、画面の外へ続く区画を数えても使い道が無い
  return { subjects: out, clipped: out.length === 0 ? 0 : clippedArea(joined, w, h, cr) };
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

function totalArea(subjects: SubjectMask[]): number {
  let area = 0;
  for (const s of subjects) area += s.area;
  return area;
}

/** 候補のマスクをひとつに重ねる（候補同士を面で比べるため） */
function unionMask(subjects: SubjectMask[], w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (const s of subjects) {
    for (let i = 0; i < out.length; i++) if (s.mask[i] === 1) out[i] = 1;
  }
  return out;
}

/**
 * 大きい候補から小さい候補へ乗り換えてよいか。
 *
 * 小さいほうが良いのは「背景を巻き込まずに済んでいる」ときだけで、生き物の一部
 * （細い首の先の頭など）が切り落とされて小さくなっているなら乗り換えてはいけない。
 * 手放す領域の縁が太線＝主役の輪郭で囲まれていれば体の一部、そうでなければ背景。
 */
function dropsOnlyBackground(
  larger: Uint8Array,
  smaller: Uint8Array,
  nearStrong: Uint8Array,
  w: number,
  h: number
): boolean {
  return edgeCoverage(diffMask(larger, smaller), nearStrong, w, h) < BODY_PART_COVERAGE;
}

/**
 * 小さい候補から大きい候補へ乗り換えてよいか。
 *
 * ふつう大きいほうは背景を巻き込んだ結果だが、輪郭の切れ目から塗りが漏れて欠けていた
 * 部分が、すき間埋めの半径を上げたことで戻ってくる絵もある（マンモスの胴、プテラノドンの
 * 手前の翼）。戻ってきた体はぐるりと主役の輪郭で囲まれているのに対し、背景を巻き込んだ
 * ときは線の無いところを橋渡ししたぶん縁が線から外れ、シルエット全体の一致率も下がる。
 *
 * 手放す側 (dropsOnlyBackground) より厳しくしてあるのは、岩・氷・草が生き物と同じ太さで
 * 描かれた絵では「増えたぶんも線で囲まれている」が普通に成り立ってしまい、それだけでは
 * 背景と区別できないため。それでも下絵によっては背景を拾う（README の設計メモを参照）。
 */
function addsOnlyBody(
  larger: Uint8Array,
  smaller: Uint8Array,
  nearStrong: Uint8Array,
  w: number,
  h: number,
  scoreDelta: number
): boolean {
  if (scoreDelta < -GROW_SCORE_DROP) return false;
  return edgeCoverage(diffMask(larger, smaller), nearStrong, w, h) >= GROW_BODY_COVERAGE;
}

/**
 * 切り抜けた主役より大きいものが画面の外へ続いているか。
 * そうなら、この絵の本当の主役は画面に収まっていない（＝切り抜けたのは体の一部）。
 */
function missesClippedSubject(found: Extraction): boolean {
  let area = 0;
  for (const s of found.subjects) area += s.area;
  return found.clipped > area;
}

/**
 * 線画のアルファチャンネルから主役のシルエットを取り出す。
 * 面積の大きい順に返す（対決絵などで 2 体見つかることがある）。見つからなければ空配列。
 *
 * 収縮半径（背景の細線をどこまで落とすか）とすき間埋め半径（途切れた輪郭をどこまで繋ぐか）
 * の最適値は絵ごとに違うため、総当たりして輪郭一致率が最も高い組み合わせを採用する。
 *
 * 画面の外へ切れている生き物が写っている絵では、何も返さない。切れた生き物は
 * シルエットにできず、代わりに体の一部だけがきれいな閉領域として残ってしまうため
 * （clippedArea を参照）。
 */
export function extractSubjectMasks(alpha: Uint8Array, w: number, h: number): SubjectMask[] {
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = alpha[i] >= INK_ALPHA ? 1 : 0;
  let inkArea = 0;
  for (let i = 0; i < ink.length; i++) inkArea += ink[i];

  // オープニング（収縮→膨張）で細い線を落とし、太い線だけを元の太さで残す
  const opened = ERODE_RADII.map((erBase) => {
    const er = scaleR(erBase, w);
    return dilate(erode(ink, w, h, er), w, h, er);
  });
  // 候補同士を比べるときだけに使う「いちばん太い線」の物差し。半径ごとの太線マスクは
  // 小さい半径だと背景の細線まで含んでしまい、候補の良し悪しを測れない
  let strong = opened[0];
  for (let i = opened.length - 1; i >= 0; i--) {
    let n = 0;
    for (let p = 0; p < opened[i].length; p++) n += opened[i][p];
    if (n >= inkArea * STRONG_INK_RATIO) {
      strong = opened[i];
      break;
    }
  }
  const nearStrong = dilate(strong, w, h, scaleR(3, w));

  let best: SubjectMask[] = [];
  let bestScore = -1;
  let bestArea = Infinity;
  let bestUnion: Uint8Array | null = null;

  for (let ei = 0; ei < ERODE_RADII.length; ei++) {
    const thick = opened[ei];
    // 一致判定は多少のズレを許す（塗りつぶしは線の内側で止まるため）
    const nearThick = dilate(thick, w, h, scaleR(3, w));

    for (const crBase of CLOSE_RADII) {
      const found = extractWithRadii(thick, nearThick, w, h, scaleR(crBase, w));
      if (found.subjects.length === 0) continue;
      // いちばんよく取れた組み合わせが「主役より大きいものが画面の外へ続いている」と
      // 言っているなら、切り抜けたのは体の一部。半径を変えて探し直しても本体は出て
      // こない（画面の外にあるので）ため、この絵は諦める
      if (missesClippedSubject(found)) return [];
      const score = setScore(found.subjects);

      if (score < GOOD_COVERAGE) {
        // まだ「十分きれい」に届いていない段階では、一致率がいちばん高いものを控えておく
        if (bestScore < GOOD_COVERAGE && score > bestScore) {
          bestScore = score;
          bestArea = totalArea(found.subjects);
          best = found.subjects;
          bestUnion = null;
        }
        continue;
      }

      // ここから先は「十分きれいに切れている」候補同士の比較。
      // 縁が線の上で止まっているだけでは、その線が主役の輪郭なのか地面や草なのかは
      // 区別できない（収縮半径が小さいと背景の線も太線として残るため、一致率は簡単に
      // 1.0 になる）。背景を巻き込めば面積は増えるだけなので、同じくらいきれいに
      // 切れているなら小さいほうが「生き物だけ」を捉えている。ただし増減した領域が体か
      // 背景かで例外を見る（dropsOnlyBackground / addsOnlyBody）。
      const area = totalArea(found.subjects);
      if (bestScore < GOOD_COVERAGE) {
        bestScore = score;
        bestArea = area;
        best = found.subjects;
        bestUnion = null;
        continue;
      }
      const union = unionMask(found.subjects, w, h);
      bestUnion ??= unionMask(best, w, h);
      const better =
        area < bestArea
          ? // 小さくなった理由が「生き物の一部を切り落とした」ならそれは改善ではない
            dropsOnlyBackground(bestUnion, union, nearStrong, w, h)
          : // 大きくなってよいのは、欠けていた体が戻ってきたときだけ
            addsOnlyBody(union, bestUnion, nearStrong, w, h, score - bestScore);
      if (!better) continue;
      bestScore = score;
      bestArea = area;
      best = found.subjects;
      bestUnion = union;
    }
  }
  return best;
}
