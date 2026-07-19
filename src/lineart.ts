// 線画カタログ。SVG は ?raw でバンドルに含める（オフライン動作・SW キャッシュが単純になる）
import trexSvg from "../assets/lineart/trex.svg?raw";
import triceratopsSvg from "../assets/lineart/triceratops.svg?raw";
import stegosaurusSvg from "../assets/lineart/stegosaurus.svg?raw";
import brachiosaurusSvg from "../assets/lineart/brachiosaurus.svg?raw";
import pteranodonSvg from "../assets/lineart/pteranodon.svg?raw";
import eggBabySvg from "../assets/lineart/egg-baby.svg?raw";
import spinosaurusSvg from "../assets/lineart/spinosaurus.svg?raw";
import ankylosaurusSvg from "../assets/lineart/ankylosaurus.svg?raw";
import pachycephalosaurusSvg from "../assets/lineart/pachycephalosaurus.svg?raw";
import trexSideSvg from "../assets/lineart/trex-side.svg?raw";
import triceratopsSideSvg from "../assets/lineart/triceratops-side.svg?raw";
import mammothSvg from "../assets/lineart/mammoth.svg?raw";
import titanoboaSvg from "../assets/lineart/titanoboa.svg?raw";
import purussaurusSvg from "../assets/lineart/purussaurus.svg?raw";
import fishSvg from "../assets/lineart/fish.svg?raw";
import flowerSvg from "../assets/lineart/flower.svg?raw";
import rocketSvg from "../assets/lineart/rocket.svg?raw";
import butterflySvg from "../assets/lineart/butterfly.svg?raw";
import therizinosaurusSvg from "../assets/lineart/therizinosaurus.svg?raw";
import argentinosaurusSvg from "../assets/lineart/argentinosaurus.svg?raw";
import { BUILTIN_CATEGORY } from "./categories";

export const CANVAS_W = 1024;
export const CANVAS_H = 768;

export interface LineArt {
  id: string;
  name: string;
  /** 組み込み線画は SVG 文字列で定義する */
  svg?: string;
  /** アップロード／共有下絵は透明化済みラスター画像の data URL を持つ */
  imageUrl?: string;
  /** 既定カテゴリー id（artmeta の上書きが無いときに使う）。未分類は undefined */
  category?: string;
}

// カタログ定義（category は categories.ts の BUILTIN_CATEGORY から自動付与）
const catalogBase: Omit<LineArt, "category">[] = [
  { id: "trex", name: "ティラノサウルス", svg: trexSvg },
  { id: "triceratops", name: "トリケラトプス", svg: triceratopsSvg },
  { id: "stegosaurus", name: "ステゴサウルス", svg: stegosaurusSvg },
  { id: "brachiosaurus", name: "ブラキオサウルス", svg: brachiosaurusSvg },
  { id: "pteranodon", name: "プテラノドン", svg: pteranodonSvg },
  { id: "egg-baby", name: "たまごのあかちゃん", svg: eggBabySvg },
  { id: "spinosaurus", name: "スピノサウルス", svg: spinosaurusSvg },
  { id: "ankylosaurus", name: "アンキロサウルス", svg: ankylosaurusSvg },
  { id: "pachycephalosaurus", name: "パキケファロサウルス", svg: pachycephalosaurusSvg },
  { id: "trex-side", name: "ティラノサウルス（よこ）", svg: trexSideSvg },
  { id: "triceratops-side", name: "トリケラトプス（よこ）", svg: triceratopsSideSvg },
  { id: "mammoth", name: "マンモス", svg: mammothSvg },
  { id: "titanoboa", name: "ティタノボア", svg: titanoboaSvg },
  { id: "purussaurus", name: "プルスサウルス", svg: purussaurusSvg },
  { id: "fish", name: "さかな", svg: fishSvg },
  { id: "flower", name: "おはな", svg: flowerSvg },
  { id: "rocket", name: "ロケット", svg: rocketSvg },
  { id: "butterfly", name: "ちょうちょ", svg: butterflySvg },
  { id: "therizinosaurus", name: "テリジノサウルス", svg: therizinosaurusSvg },
  { id: "argentinosaurus", name: "アルゼンチノサウルス", svg: argentinosaurusSvg },
];

export const catalog: LineArt[] = catalogBase.map((a) => ({
  ...a,
  category: BUILTIN_CATEGORY[a.id],
}));

export function getLineArt(id: string): LineArt | undefined {
  return catalog.find((a) => a.id === id);
}

export function svgToDataUrl(svg: string): string {
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

/** 下絵カードや線画描画に使う画像ソース（組み込み SVG or アップロード画像）を返す */
export function lineArtSrc(art: LineArt): string {
  return art.imageUrl ?? svgToDataUrl(art.svg ?? "");
}

const imageCache = new Map<string, Promise<HTMLImageElement>>();

export function loadLineArtImage(art: LineArt): Promise<HTMLImageElement> {
  let p = imageCache.get(art.id);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = lineArtSrc(art);
    });
    imageCache.set(art.id, p);
  }
  return p;
}

/** 線画レイヤー canvas に描画する */
export async function drawLineArt(canvas: HTMLCanvasElement, art: LineArt): Promise<void> {
  const img = await loadLineArtImage(art);
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
}
