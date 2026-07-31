// ぬりえ画面のツールバー UI（色・太さ・重ね塗りモード・もどす・ぜんぶ消す）
import { PaintEngine } from "./paint";
import { blip } from "./celebrate";
import {
  MY_COLOR_DEFAULT,
  MY_COLOR_SLOTS,
  loadMyColors,
  saveMyColors,
} from "./mycolors";
import type { Level } from "./level";

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
  "#f2f2f2", // しろ（まぜまぜモードで水彩のように色を薄めるのに使う。塗った跡が見えるようごく僅かにグレーへ寄せている）
];

export const SIZES = [8, 16, 28, 46];

/** レベルごとの筆の太さ初期値（SIZES の添字）。むずかしい下絵は細かいので 1段細く始める。 */
const DEFAULT_SIZE_INDEX: Record<Level, number> = { 1: 2, 2: 2, 3: 1 };

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

/** 「捨てる」演出の落下アニメの長さ (ms)。CSS の trash-drop と合わせる */
const TRASH_DROP_MS = 380;

/**
 * 捨てる演出が見え始めるまで、ただ押さえているだけに見える助走の長さ (ms)。
 * 触れた瞬間に絵が縮み出すと誤タップに見えてしまうため、まず何も起きない間を置く。
 */
const TRASH_HOLD_DELAY_MS = 1000;

/**
 * 長押しで削除する要素に「ゴミ箱に捨てられそう」な見た目を付ける。
 *
 * 触れてもすぐには反応せず、TRASH_HOLD_DELAY_MS だけ押さえ続けてはじめて、中身
 * (.trash-inner) が縮んで傾き、下から現れるゴミ箱に吸い込まれていく演出が始まる。
 * 指を離せば元に戻るので、何が起きるのか押しながら確かめられる。
 *
 * 縮みきったところで演出をいったん止め、confirm() で本当に消してよいか確認する。
 * 確認の間は縮みきった見た目のまま（＝消えかけている）を保ち、true が返れば
 * ゴミ箱へ落ちて消えるアニメのあと onFire を呼ぶ。false ならそのまま元に戻る。
 *
 * この演出が始まったあとに指を離した場合は、削除もせず・要素の通常タップ（作品を
 * 動かす・ぬりえを開く）も起きない。中途半端に押した結果を確定させないようにするため。
 * 演出が始まる前（＝助走の間）に離した場合は、これまでどおり普通のタップとして扱う。
 *
 * ms は「触れてから確認ダイアログが出るまで」の合計時間。演出そのものは
 * ms - TRASH_HOLD_DELAY_MS かけて進む。要素は `<el class="longpress longpress-trash">`
 * の内側に `.trash-inner` を持つ構造であることが前提。削除ではない長押し
 * （下絵メーカー起動など）には使わないこと。
 */
export function bindTrashLongPress(
  el: HTMLElement,
  ms: number,
  confirm: () => Promise<boolean>,
  onFire: () => void
) {
  el.classList.add("longpress", "longpress-trash");
  const motionMs = Math.max(1, ms - TRASH_HOLD_DELAY_MS);

  let delayTimer: number | null = null;
  let fireTimer: number | null = null;
  let raf = 0;
  // 演出が始まったあとに離された場合、その離しに続く click を握りつぶして
  // 絵が開かないようにする（発火時も同じ扱いにする）
  let suppressClick = false;
  // 確認ダイアログの返事を待っている間は、指を離しても演出を巻き戻さない
  // （ダイアログ自身に「やめる」があるため、ここでの巻き戻しは不要）
  let confirming = false;

  const setP = (p: number) => el.style.setProperty("--p", String(p));

  const stopMotion = () => {
    if (fireTimer !== null) {
      clearTimeout(fireTimer);
      fireTimer = null;
    }
    cancelAnimationFrame(raf);
    el.classList.remove("pressing");
    setP(0);
  };

  const reset = () => {
    if (confirming) return;
    if (delayTimer !== null) {
      clearTimeout(delayTimer);
      delayTimer = null;
    }
    stopMotion();
  };

  el.addEventListener(
    "click",
    (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    true
  );

  el.addEventListener("pointerdown", (e) => {
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // 合成イベント等で capture できなくても長押し判定は続行する
    }
    delayTimer = window.setTimeout(() => {
      delayTimer = null;
      // ここから演出が見え始める。以降で離してもタップとしては扱わせない
      suppressClick = true;
      el.classList.add("pressing");
      const motionStart = performance.now();
      const tick = () => {
        setP(Math.min(1, (performance.now() - motionStart) / motionMs));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      fireTimer = window.setTimeout(() => {
        fireTimer = null;
        cancelAnimationFrame(raf);
        // ゴミ箱の真上で縮みきった状態のまま止め、本当に消してよいか確認する
        setP(1);
        confirming = true;
        confirm().then((ok) => {
          confirming = false;
          if (ok) {
            el.classList.remove("pressing");
            el.classList.add("trashing");
            blip(300); // 低い「ポイッ」
            window.setTimeout(onFire, TRASH_DROP_MS);
          } else {
            blip(700);
            el.classList.remove("pressing");
            setP(0);
          }
        });
      }, motionMs);
    }, TRASH_HOLD_DELAY_MS);
  });
  el.addEventListener("pointerup", reset);
  el.addEventListener("pointercancel", reset);
  el.addEventListener("pointerleave", reset);
}

export interface Toolbar {
  colorsEl: HTMLElement;
  toolsEl: HTMLElement;
  /** ストローク後に undo ボタンの有効状態を更新する */
  refresh(): void;
}

export function buildToolbar(
  engine: PaintEngine,
  onClear: () => void,
  level: Level = 2
): Toolbar {
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
    // 白は背景に溶けてしまうので、枠線を濃くするクラスを付ける
    btn.className = color === "#f2f2f2" ? "swatch white" : "swatch";
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

  // ---- じぶんのいろ（6 枠・枠ごとに差し替え） ----
  // 枠の位置は固定で、勝手に並び替わったり古い色が押し出されたりしない。まだ色を
  // 作っていない枠は虹色のまま見せ、色が入った枠には「自分で作った色」の目印として
  // 右下に虹色パレットのバッジを出す。
  //
  // 色が入っている枠は 1 タップ目でその色を選ぶだけ（ピッカーは開かない）。選択中の
  // 枠をもう一度タップするか、空の枠をタップするとピッカーが開き、その枠の色が
  // 選んだ色に置き換わる。
  //
  // ピッカーはブラウザ純正（input[type=color]）。iPad Safari は showPicker() での
  // プログラム的なオープンを無視することがあるので、input を枠いっぱいに透明で重ね、
  // 「ユーザーのタップが input 本体に当たる」形にして開かせる。上の 2 段階タップは
  // CSS 側で input の pointer-events を切り替えることで成立させている
  // （色入り・未選択の枠だけ input に当てず、下のボタンでタップを拾う）。
  const paletteBadgeSvg = `
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path d="M32 4 C49 4 61 15 61 28 C61 37 54 41 47 42 C42 43 39 45 39 49
               C39 55 35 60 29 60 C15 60 3 46 3 30 C3 15 15 4 32 4 Z"
            fill="#ffffff" stroke="#1a1a1a" stroke-width="5" stroke-linejoin="round" />
      <circle cx="21" cy="19" r="6" fill="#e74c3c" />
      <circle cx="40" cy="17" r="6" fill="#f7d51d" />
      <circle cx="50" cy="30" r="6" fill="#2f6fdc" />
      <circle cx="18" cy="37" r="6" fill="#2e9e44" />
    </svg>`;

  const myColors = loadMyColors();
  for (let i = 0; i < MY_COLOR_SLOTS; i++) {
    const btn = document.createElement("button");
    btn.className = "swatch mycolor";
    btn.title = "じぶんのいろ";
    const badge = document.createElement("span");
    badge.className = "mycolor-badge";
    badge.innerHTML = paletteBadgeSvg;
    btn.appendChild(badge);
    // 枠いっぱいに透明で重ねる。タップはこの input が直接受け、純正ピッカーが開く。
    // 値の初期化はここだけで行い、以降は input.value に触らない（ピッカーを開いて
    // いる最中の代入はネイティブ UI の状態を乱しうるため）
    const input = document.createElement("input");
    input.type = "color";
    input.value = myColors[i] ?? MY_COLOR_DEFAULT;
    btn.appendChild(input);

    const render = () => {
      const color = myColors[i];
      btn.classList.toggle("filled", color !== null);
      if (color) btn.style.setProperty("--c", color);
      else btn.style.removeProperty("--c");
    };
    render();

    // 色が入っている未選択の枠でだけ呼ばれる（他の枠はタップを input が受ける）。
    // input が受けたタップも bubbling で来るので、その場合は何もしない
    btn.addEventListener("click", (e) => {
      if (e.target === input) return;
      const color = myColors[i];
      if (!color) return;
      engine.setColor(color);
      engine.setMode(overlayMode);
      selectSwatch(btn);
      blip(520);
    });

    // ピッカーはドラッグ中も input を連発するので、見た目と描画色を追従させる
    input.addEventListener("input", () => {
      myColors[i] = input.value.toLowerCase();
      render();
      engine.setColor(input.value);
      engine.setMode(overlayMode);
      selectSwatch(btn);
    });
    // 確定でもキャンセルでも、画面に見えている色をそのまま保存する。iOS のピッカーには
    // キャンセルが無く選んだ色がそのまま残るので、そちらの挙動に揃えている
    const persist = () => saveMyColors(myColors);
    input.addEventListener("change", persist);
    input.addEventListener("cancel", persist);

    swatches.push(btn);
    colorsEl.appendChild(btn);
  }

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
  const sizeIdx = DEFAULT_SIZE_INDEX[level];
  engine.setSize(SIZES[sizeIdx]);
  sizeBtns[sizeIdx].classList.add("selected");

  const spacer1 = document.createElement("div");
  spacer1.className = "tool-spacer";
  toolsEl.appendChild(spacer1);

  // 重ね塗りモードトグル（うわがき 🖍️ / まぜまぜ = 水彩筆の自作SVG）
  const modeWrap = document.createElement("div");
  modeWrap.className = "mode-wrap";
  const modeBtn = document.createElement("button");
  modeBtn.className = "tool-btn mode-btn";
  const modeLabel = document.createElement("span");
  modeLabel.className = "mode-label";
  const brushSvg = `
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="15" cy="45" r="15" fill="#4fb0f0" opacity="0.6" />
      <circle cx="26" cy="54" r="13" fill="#ff5a72" opacity="0.6" />
      <g transform="rotate(-45 32 32)">
        <path d="M4 32 C9 23 18 20.5 27 25 C30.5 26.8 30.5 37.2 27 39 C18 43.5 9 41 4 32 Z"
              fill="#ef4a63" />
        <path d="M4 32 C9 23 18 20.5 27 25" fill="none" stroke="#ff8a9a"
              stroke-width="2" stroke-linecap="round" opacity="0.8" />
        <rect x="27" y="26" width="9" height="12" rx="2" fill="#eef0f2" />
        <rect x="27" y="26" width="9" height="3.5" fill="#b7bcc4" />
        <rect x="27" y="34.5" width="9" height="3.5" fill="#b7bcc4" />
        <path d="M36 29 C46 27.6 56 27.6 63 29 C64.6 30.6 64.6 33.4 63 35
                 C56 36.4 46 36.4 36 35 Z" fill="#e8a85e" />
        <path d="M40 29.5 C48 28.7 56 28.7 60 29.1" fill="none" stroke="#f9dfae"
              stroke-width="1.6" stroke-linecap="round" opacity="0.9" />
      </g>
    </svg>`;
  const renderMode = () => {
    if (overlayMode === "normal") {
      modeBtn.textContent = "🖍️";
    } else {
      modeBtn.innerHTML = brushSvg;
    }
    modeBtn.title = overlayMode === "normal" ? "うわがき" : "まぜまぜ";
  };
  renderMode();
  // タップした瞬間「えのぐ」「くれよん」と一瞬ポップアップして、いま何色モードに
  // 切り替わったのかを子どもにもわかるようにする
  const showModeLabel = () => {
    modeLabel.textContent = overlayMode === "normal" ? "くれよん" : "えのぐ";
    modeLabel.classList.remove("show");
    void modeLabel.offsetWidth; // 連打時にアニメーションを最初から再生させるためのリフロー
    modeLabel.classList.add("show");
  };
  modeBtn.addEventListener("click", () => {
    overlayMode = overlayMode === "normal" ? "mix" : "normal";
    if (engine.getMode() !== "erase") engine.setMode(overlayMode);
    renderMode();
    showModeLabel();
    blip(overlayMode === "mix" ? 740 : 560);
  });
  modeWrap.appendChild(modeBtn);
  modeWrap.appendChild(modeLabel);
  toolsEl.appendChild(modeWrap);

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
