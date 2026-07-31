// 共有下絵（GitHub リポジトリ経由）のローダー。
// public/custom/index.json のマニフェストを読み、各 png を白→透明化して LineArt にする。
// これらは全端末にデプロイで配布され、SW が network-first でマニフェストを更新する。
import type { LineArt } from "./lineart";
import { LEVELS, type Level } from "./level-core";
import { imageToTransparentDataUrl } from "./template";

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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("画像を読み込めませんでした: " + src));
    img.src = src;
  });
}

// セッション内のメモリキャッシュ（透明化のやり直しを避ける）
let cache: LineArt[] | null = null;

/**
 * 共有下絵一覧を読み込む。マニフェストが無い・壊れている・オフライン等では空配列を返す
 * （＝共有下絵なしで通常動作する）。個々の画像読み込み失敗はその1件だけスキップ。
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

  const arts: LineArt[] = [];
  for (const it of items) {
    if (!it?.id || !it?.file) continue;
    try {
      const img = await loadImage(CUSTOM_BASE + it.file);
      arts.push({
        id: it.id,
        name: it.name ?? "ぬりえ",
        imageUrl: imageToTransparentDataUrl(img),
        category: it.category,
        level: toLevel(it.level),
      });
    } catch {
      // この1件はスキップ
    }
  }
  cache = arts;
  return arts;
}
