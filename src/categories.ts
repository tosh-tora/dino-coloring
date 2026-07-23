// カテゴリー（分類）の共有定義。lineart / store 双方から参照する（循環 import を避けるため
// この小さなモジュールに集約する）。カテゴリーは大人が自由に追加・編集できるが、初回は
// 下記の既定4件をシードする。

export interface Category {
  id: string;
  name: string;
  order: number;
}

/** 初回起動時にシードする既定カテゴリー（固定 id）。 */
export const DEFAULT_CATEGORIES: Category[] = [
  { id: "cat-dino", name: "きょうりゅう", order: 0 },
  // きょうりゅうの直後に出したいが、既存ユーザーの cat-extinct(order 1) と衝突しない
  // よう小数の order を使う（order は並べ替え用のキーなので整数である必要はない）。
  { id: "cat-sea", name: "みずのなかのいきもの", order: 0.5 },
  { id: "cat-extinct", name: "ぜつめつどうぶつ", order: 1 },
  { id: "cat-animal", name: "どうぶつ・いきもの", order: 2 },
  { id: "cat-other", name: "そのた", order: 3 },
];

/** 組み込み線画 id → 既定カテゴリー id。artmeta に上書きが無いときの初期分類。 */
export const BUILTIN_CATEGORY: Record<string, string> = {
  trex: "cat-dino",
  triceratops: "cat-dino",
  stegosaurus: "cat-dino",
  brachiosaurus: "cat-dino",
  pteranodon: "cat-dino",
  "egg-baby": "cat-dino",
  spinosaurus: "cat-dino",
  ankylosaurus: "cat-dino",
  pachycephalosaurus: "cat-dino",
  "trex-side": "cat-dino",
  "triceratops-side": "cat-dino",
  therizinosaurus: "cat-dino",
  argentinosaurus: "cat-dino",
  mammoth: "cat-extinct",
  titanoboa: "cat-extinct",
  purussaurus: "cat-extinct",
  fish: "cat-animal",
  butterfly: "cat-animal",
  flower: "cat-other",
  rocket: "cat-other",
};
