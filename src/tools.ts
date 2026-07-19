// ぬりえ画面のツールバー UI（色・太さ・重ね塗りモード・もどす・ぜんぶ消す）
import { PaintEngine } from "./paint";
import { blip } from "./celebrate";
import { addFavorite, loadFavorites, saveFavorites } from "./favorites";

export const PALETTE = [
  "#e74c3c", // あか
  "#f39c12", // オレンジ
  "#f7d51d", // きいろ
  "#8bc34a", // きみどり
  "#2e9e44", // みどり
  "#5bc8f5", // みずいろ
  "#2f6fdc", // あお
  "#8e44ad", // むらさき
  "#f78fb3", // ピンク
  "#8d5524", // ちゃいろ
  "#95a5a6", // はいいろ
  "#222222", // くろ
];

export const SIZES = [8, 16, 28, 46];

/** 長押しで発火するボタン。押している間 CSS 変数 --p (0→1) で進捗リングを描く */
export function bindLongPress(el: HTMLElement, ms: number, onFire: () => void) {
  let timer: number | null = null;
  let raf = 0;
  let start = 0;

  const setP = (p: number) => el.style.setProperty("--p", String(p));

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    cancelAnimationFrame(raf);
    el.classList.remove("pressing");
    setP(0);
  };

  el.addEventListener("pointerdown", (e) => {
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // 合成イベント等で capture できなくても長押し判定は続行する
    }
    start = performance.now();
    el.classList.add("pressing");
    timer = window.setTimeout(() => {
      cancel();
      onFire();
    }, ms);
    const tick = () => {
      setP(Math.min(1, (performance.now() - start) / ms));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
  el.addEventListener("pointerup", cancel);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("pointerleave", cancel);
}

export interface Toolbar {
  colorsEl: HTMLElement;
  toolsEl: HTMLElement;
  /** ストローク後に undo ボタンの有効状態を更新する */
  refresh(): void;
}

export function buildToolbar(engine: PaintEngine, onClear: () => void): Toolbar {
  // ---- 左パネル: 色 ----
  const colorsEl = document.createElement("div");
  colorsEl.className = "panel colors";

  let overlayMode: "normal" | "mix" = "normal";

  const swatches: HTMLButtonElement[] = [];
  const selectSwatch = (btn: HTMLButtonElement) => {
    for (const s of swatches) s.classList.toggle("selected", s === btn);
  };

  for (const color of PALETTE) {
    const btn = document.createElement("button");
    btn.className = "swatch";
    btn.style.setProperty("--c", color);
    btn.addEventListener("click", () => {
      engine.setColor(color);
      engine.setMode(overlayMode);
      selectSwatch(btn);
      blip(520);
    });
    swatches.push(btn);
    colorsEl.appendChild(btn);
  }

  // じぶんの色（ネイティブカラーピッカー）
  const customWrap = document.createElement("button");
  customWrap.className = "swatch custom";
  customWrap.title = "じぶんのいろ";
  const customInput = document.createElement("input");
  customInput.type = "color";
  customInput.value = "#40c4aa";
  customWrap.appendChild(customInput);
  customInput.addEventListener("input", () => {
    engine.setColor(customInput.value);
    engine.setMode(overlayMode);
    selectSwatch(customWrap);
  });
  // ピッカー確定時にお気に入りへ自動登録（input はドラッグ中も連発するので change で拾う）
  customInput.addEventListener("change", () => {
    const color = customInput.value.toLowerCase();
    if (PALETTE.includes(color) || favorites[0] === color) return;
    favorites = addFavorite(color, favorites);
    saveFavorites(favorites);
    renderFavorites();
  });
  swatches.push(customWrap);
  colorsEl.appendChild(customWrap);

  // 消しゴム
  const eraser = document.createElement("button");
  eraser.className = "swatch eraser";
  eraser.title = "けしごむ";
  eraser.innerHTML = `
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <clipPath id="eraser-sleeve">
          <rect x="18" y="16" width="42" height="33" rx="4" />
        </clipPath>
      </defs>
      <g transform="rotate(-18 32 32)">
        <rect x="5" y="20" width="20" height="26" rx="6"
              fill="#f5f2e9" stroke="#1a1a1a" stroke-width="3" />
        <rect x="18" y="16" width="42" height="33" rx="4" fill="#ffffff" />
        <g clip-path="url(#eraser-sleeve)">
          <rect x="18" y="16" width="42" height="6" fill="#2447e0" />
          <rect x="18" y="37" width="42" height="7.5" fill="#1a1a1a" />
          <rect x="18" y="44.5" width="42" height="4.5" fill="#2447e0" />
        </g>
        <text x="39.5" y="33.5" text-anchor="middle"
              font-family="'Hiragino Maru Gothic ProN', 'BIZ UDGothic', 'Yu Gothic UI', sans-serif"
              font-size="10" font-weight="bold" fill="#1a1a1a">けしごむ</text>
        <rect x="18" y="16" width="42" height="33" rx="4"
              fill="none" stroke="#1a1a1a" stroke-width="3" />
      </g>
    </svg>`;
  eraser.addEventListener("click", () => {
    engine.setMode("erase");
    selectSwatch(eraser);
    blip(300);
  });
  swatches.push(eraser);
  colorsEl.appendChild(eraser);

  // ---- お気に入りの色（じぶんの色で選んだ色を自動記憶、じぶんの色と消しゴムの間に表示） ----
  let favorites = loadFavorites();
  const favButtons: HTMLButtonElement[] = [];
  const renderFavorites = () => {
    for (const btn of favButtons) {
      const i = swatches.indexOf(btn);
      if (i !== -1) swatches.splice(i, 1);
      btn.remove();
    }
    favButtons.length = 0;
    for (const color of favorites) {
      const btn = document.createElement("button");
      btn.className = "swatch fav";
      btn.style.setProperty("--c", color);
      btn.addEventListener("click", () => {
        engine.setColor(color);
        engine.setMode(overlayMode);
        selectSwatch(btn);
        blip(520);
      });
      favButtons.push(btn);
      swatches.push(btn);
      colorsEl.insertBefore(btn, eraser);
    }
  };
  renderFavorites();

  // 初期選択: あか
  engine.setColor(PALETTE[0]);
  selectSwatch(swatches[0]);

  // ---- 右パネル: 太さ・モード・もどす・ぜんぶ消す ----
  const toolsEl = document.createElement("div");
  toolsEl.className = "panel tools";

  const sizeBtns: HTMLButtonElement[] = [];
  for (const size of SIZES) {
    const btn = document.createElement("button");
    btn.className = "tool-btn size-btn";
    const dot = document.createElement("span");
    dot.className = "size-dot";
    dot.style.setProperty("--d", `${Math.max(8, size * 0.85)}px`);
    btn.appendChild(dot);
    btn.addEventListener("click", () => {
      engine.setSize(size);
      for (const s of sizeBtns) s.classList.toggle("selected", s === btn);
      blip(440);
    });
    sizeBtns.push(btn);
    toolsEl.appendChild(btn);
  }
  engine.setSize(SIZES[2]);
  sizeBtns[2].classList.add("selected");

  const spacer1 = document.createElement("div");
  spacer1.className = "tool-spacer";
  toolsEl.appendChild(spacer1);

  // 重ね塗りモードトグル（うわがき 🖍️ / まぜまぜ 🌈）
  const modeBtn = document.createElement("button");
  modeBtn.className = "tool-btn mode-btn";
  const renderMode = () => {
    modeBtn.textContent = overlayMode === "normal" ? "🖍️" : "🌈";
    modeBtn.title = overlayMode === "normal" ? "うわがき" : "まぜまぜ";
  };
  renderMode();
  modeBtn.addEventListener("click", () => {
    overlayMode = overlayMode === "normal" ? "mix" : "normal";
    if (engine.getMode() !== "erase") engine.setMode(overlayMode);
    renderMode();
    blip(overlayMode === "mix" ? 740 : 560);
  });
  toolsEl.appendChild(modeBtn);

  // もどす
  const undoBtn = document.createElement("button");
  undoBtn.className = "tool-btn undo-btn";
  undoBtn.textContent = "↩️";
  undoBtn.addEventListener("click", () => {
    engine.undo();
    refresh();
    blip(380);
  });
  toolsEl.appendChild(undoBtn);

  // ぜんぶ消す（1.5 秒長押し）
  const clearBtn = document.createElement("button");
  clearBtn.className = "tool-btn clear-btn longpress";
  clearBtn.textContent = "🗑️";
  bindLongPress(clearBtn, 1500, () => {
    onClear();
    refresh();
    blip(240);
  });
  toolsEl.appendChild(clearBtn);

  const refresh = () => {
    undoBtn.disabled = !engine.canUndo;
  };
  refresh();

  return { colorsEl, toolsEl, refresh };
}
