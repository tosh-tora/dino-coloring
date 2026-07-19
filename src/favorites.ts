// じぶんの色で選んだ「お気に入りの色」の永続化（最近使った順・最大4個）
const FAVORITES_KEY = "dino-coloring:favorite-colors";

export const MAX_FAVORITES = 4;

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const colors: string[] = [];
    for (const c of parsed) {
      if (typeof c !== "string" || !HEX_RE.test(c)) continue;
      const norm = c.toLowerCase();
      if (!colors.includes(norm)) colors.push(norm);
    }
    return colors.slice(0, MAX_FAVORITES);
  } catch {
    return [];
  }
}

export function saveFavorites(colors: string[]): void {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(colors));
  } catch {
    // 保存できない環境（プライベートモード等）では永続化だけ諦める
  }
}

/** 先頭に color を積んだ新しい配列を返す。既存の同色は先頭へ移動し、超過分は末尾から落ちる */
export function addFavorite(color: string, list: string[]): string[] {
  const norm = color.toLowerCase();
  return [norm, ...list.filter((c) => c !== norm)].slice(0, MAX_FAVORITES);
}
