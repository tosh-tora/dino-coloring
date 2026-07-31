// 共有下絵（GitHub リポジトリ経由）のローダー。
// public/custom/index.json のマニフェストを読んで LineArt にするだけ。png は
// scripts/optimize-shared-art.mjs で透明化済みなので URL をそのまま使える
// （以前はここで 1 枚ずつ読み込んで白→透明化しており、起動の待ち時間の大半を占めていた）。
// これらは全端末にデプロイで配布され、SW が network-first でマニフェストを更新する。
import type { LineArt } from "./lineart";
import { LEVELS, type Level } from "./level-core";

interface SharedManifestItem {
  id: string;
  name: string;
  category?: string;
  file: string; // public/custom/ 以下のファイル名
  /** 下絵を追加したときに `npm run art-levels` で判定して焼き込んだレベル */
  level?: number;
}

/** マニフェストの level は外から来る値なので 1..3 のときだけ採用する。 */
function toLevel(v: unknown): Level | undefined {
  return LEVELS.find((l) => l === v);
}

const CUSTOM_BASE = import.meta.env.BASE_URL + "custom/";

// セッション内のメモリキャッシュ（マニフェストの取り直しを避ける）
let cache: LineArt[] | null = null;

/**
 * 共有下絵一覧を読み込む。マニフェストが無い・壊れている・オフライン等では空配列を返す
 * （＝共有下絵なしで通常動作する）。
 */
export async function loadSharedArts(): Promise<LineArt[]> {
  if (cache) return cache;
  let items: SharedManifestItem[] = [];
  try {
    const res = await fetch(CUSTOM_BASE + "index.json", { cache: "no-cache" });
    if (!res.ok) return (cache = []);
    const json = await res.json();
    items = Array.isArray(json?.items) ? json.items : [];
  } catch {
    return (cache = []);
  }

  return (cache = items
    .filter((it) => it?.id && it?.file)
    .map((it) => ({
      id: it.id,
      name: it.name ?? "ぬりえ",
      imageUrl: CUSTOM_BASE + it.file,
      category: it.category,
      level: toLevel(it.level),
    })));
}

/** 暖機の同時本数。子どもの操作の邪魔をしない程度に絞る。 */
const WARM_CONCURRENCY = 3;

let warmed = false;

/**
 * 共有下絵の png を裏で取りにいって Service Worker にキャッシュさせる。
 *
 * 一覧のカードは遅延読み込み（loading="lazy"）なので、放っておくと「開いたことのない
 * 下絵はオフラインで出ない」ことになる。以前は起動時に全部読み込んでいたおかげで
 * 結果的にキャッシュが埋まっていたので、その役目だけを表示のあとに引き継ぐ。
 * 失敗しても何もしない（次の起動でまた試す）。
 */
export function warmSharedArts(arts: LineArt[]): void {
  if (warmed) return;
  warmed = true;
  const urls = arts.map((a) => a.imageUrl).filter((u): u is string => !!u);
  let next = 0;
  const pump = async (): Promise<void> => {
    while (next < urls.length) {
      await fetch(urls[next++]).catch(() => {});
    }
  };
  const start = () => {
    for (let i = 0; i < WARM_CONCURRENCY; i++) void pump();
  };
  // 表示が落ち着いてから始める（古い iOS Safari には requestIdleCallback が無い）
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(start, { timeout: 5000 });
  } else {
    window.setTimeout(start, 2000);
  }
}
