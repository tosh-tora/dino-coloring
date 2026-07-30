// 「じぶんのいろ」6 枠の永続化。並び順は枠の位置そのものなので、
// 使った順に並べ替えたり古いものを落としたりはしない（差し替えは枠単位）。
//
// キーは旧「お気に入りの色」時代のものを引き継いでいる。旧データは null を含まない
// 最大 4 個の配列だが、下のパーサが hex でない要素を null に落として長さ 6 に
// 揃えるので、そのまま枠 0〜3 の色として読み込まれる。
const MY_COLORS_KEY = "dino-coloring:favorite-colors";

/** じぶんのいろの枠の数 */
export const MY_COLOR_SLOTS = 6;

/** まだ色を作っていない枠でピッカーを開いたときの初期色 */
export const MY_COLOR_DEFAULT = "#40c4aa";

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** つねに長さ MY_COLOR_SLOTS の配列を返す。空の枠は null */
export function loadMyColors(): (string | null)[] {
  const slots: (string | null)[] = new Array(MY_COLOR_SLOTS).fill(null);
  try {
    const raw = localStorage.getItem(MY_COLORS_KEY);
    if (!raw) return slots;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return slots;
    for (let i = 0; i < MY_COLOR_SLOTS; i++) {
      const c = parsed[i];
      if (typeof c === "string" && HEX_RE.test(c)) slots[i] = c.toLowerCase();
    }
    return slots;
  } catch {
    return slots;
  }
}

export function saveMyColors(slots: (string | null)[]): void {
  try {
    localStorage.setItem(MY_COLORS_KEY, JSON.stringify(slots));
  } catch {
    // 保存できない環境（プライベートモード等）では永続化だけ諦める
  }
}
