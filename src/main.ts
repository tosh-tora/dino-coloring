// 画面遷移 (ライブラリー / ぬりえ / ギャラリー) と composition root
import "./style.css";
import { catalog, svgToDataUrl, drawLineArt, CANVAS_W, CANVAS_H, LineArt } from "./lineart";
import { PaintEngine } from "./paint";
import { buildToolbar, bindLongPress } from "./tools";
import * as store from "./store";
import { celebrate, blip } from "./celebrate";

const app = document.getElementById("app")!;

// ---------------------------------------------------------------- library

async function showLibrary() {
  const workIds = await store.getWorkIds().catch(() => new Set<string>());

  app.innerHTML = "";
  const screen = document.createElement("div");
  screen.className = "screen library";

  const header = document.createElement("header");
  header.className = "topbar";
  const title = document.createElement("h1");
  title.textContent = "🦕 ぬりえ をえらぼう";
  const galleryBtn = document.createElement("button");
  galleryBtn.className = "nav-btn";
  galleryBtn.textContent = "🖼️";
  galleryBtn.title = "ギャラリー";
  galleryBtn.addEventListener("click", () => {
    blip(600);
    showGallery();
  });
  header.append(title, galleryBtn);
  screen.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "library-grid";
  for (const art of catalog) {
    const card = document.createElement("button");
    card.className = "art-card";
    const img = document.createElement("img");
    img.src = svgToDataUrl(art.svg);
    img.alt = art.name;
    img.draggable = false;
    const label = document.createElement("span");
    label.className = "art-name";
    label.textContent = art.name;
    card.append(img, label);
    if (workIds.has(art.id)) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "🖍️";
      card.appendChild(badge);
    }
    card.addEventListener("click", () => {
      blip(660);
      if (workIds.has(art.id)) {
        showResumeChooser(art);
      } else {
        showColoring(art, false);
      }
    });
    grid.appendChild(card);
  }
  screen.appendChild(grid);
  app.appendChild(screen);
}

/** 塗りかけがあるとき: つづきから / あたらしく を選ぶオーバーレイ */
function showResumeChooser(art: LineArt) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const box = document.createElement("div");
  box.className = "chooser";

  const resumeBtn = document.createElement("button");
  resumeBtn.className = "chooser-btn";
  resumeBtn.innerHTML = "▶️<span>つづきから</span>";
  resumeBtn.addEventListener("click", () => {
    blip(700);
    overlay.remove();
    showColoring(art, true);
  });

  const newBtn = document.createElement("button");
  newBtn.className = "chooser-btn";
  newBtn.innerHTML = "✨<span>あたらしく</span>";
  newBtn.addEventListener("click", async () => {
    blip(500);
    overlay.remove();
    await store.deleteWork(art.id).catch(() => {});
    showColoring(art, false);
  });

  const closeBtn = document.createElement("button");
  closeBtn.className = "chooser-close";
  closeBtn.textContent = "✖️";
  closeBtn.addEventListener("click", () => overlay.remove());

  box.append(resumeBtn, newBtn, closeBtn);
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  app.appendChild(overlay);
}

// ---------------------------------------------------------------- coloring

async function showColoring(art: LineArt, resume: boolean) {
  app.innerHTML = "";
  const screen = document.createElement("div");
  screen.className = "screen coloring";

  // ---- 上部バー ----
  const header = document.createElement("header");
  header.className = "topbar";
  const backBtn = document.createElement("button");
  backBtn.className = "nav-btn";
  backBtn.textContent = "🏠";
  const artTitle = document.createElement("span");
  artTitle.className = "art-title";
  artTitle.textContent = art.name;
  const doneBtn = document.createElement("button");
  doneBtn.className = "nav-btn done-btn";
  doneBtn.textContent = "🎉 できた！";
  header.append(backBtn, artTitle, doneBtn);
  screen.appendChild(header);

  // ---- 中央: 2 レイヤー canvas ----
  const workspace = document.createElement("div");
  workspace.className = "workspace";

  const stageWrap = document.createElement("div");
  stageWrap.className = "stage-wrap";
  const stage = document.createElement("div");
  stage.className = "stage";
  const paintCanvas = document.createElement("canvas");
  paintCanvas.className = "paint-layer";
  paintCanvas.width = CANVAS_W;
  paintCanvas.height = CANVAS_H;
  const lineartCanvas = document.createElement("canvas");
  lineartCanvas.className = "lineart-layer";
  lineartCanvas.width = CANVAS_W;
  lineartCanvas.height = CANVAS_H;
  stage.append(paintCanvas, lineartCanvas);
  stageWrap.appendChild(stage);

  const engine = new PaintEngine(paintCanvas);

  // ---- 自動保存 (debounce) ----
  let saveTimer: number | null = null;
  let dirty = false;
  const flushSave = async () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!dirty) return;
    dirty = false;
    await store
      .saveWork({ lineartId: art.id, dataUrl: engine.toDataUrl(), updatedAt: Date.now() })
      .catch(() => {});
  };
  const scheduleSave = () => {
    dirty = true;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flushSave, 1500);
  };

  const toolbar = buildToolbar(engine, () => engine.clearAll());
  engine.onStrokeEnd = () => {
    toolbar.refresh();
    scheduleSave();
  };

  workspace.append(toolbar.colorsEl, stageWrap, toolbar.toolsEl);
  screen.appendChild(workspace);
  app.appendChild(screen);

  // 線画と保存済みの塗りをロード
  await drawLineArt(lineartCanvas, art).catch(() => {});
  if (resume) {
    const work = await store.getWork(art.id).catch(() => undefined);
    if (work) await engine.loadDataUrl(work.dataUrl).catch(() => {});
  }

  const pagehide = () => {
    void flushSave();
  };
  window.addEventListener("pagehide", pagehide);

  backBtn.addEventListener("click", async () => {
    blip(420);
    window.removeEventListener("pagehide", pagehide);
    await flushSave();
    showLibrary();
  });

  doneBtn.addEventListener("click", async () => {
    doneBtn.disabled = true;
    await flushSave();
    // 白背景 + 塗り + 線画を合成して完成作品にする
    const composite = document.createElement("canvas");
    composite.width = CANVAS_W;
    composite.height = CANVAS_H;
    const ctx = composite.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.drawImage(paintCanvas, 0, 0);
    ctx.drawImage(lineartCanvas, 0, 0);
    await store
      .addGalleryItem({
        lineartId: art.id,
        dataUrl: composite.toDataURL("image/png"),
        createdAt: Date.now(),
      })
      .catch(() => {});
    window.removeEventListener("pagehide", pagehide);
    await celebrate();
    showGallery();
  });
}

// ---------------------------------------------------------------- gallery

async function showGallery() {
  const items = await store.getGallery().catch(() => []);

  app.innerHTML = "";
  const screen = document.createElement("div");
  screen.className = "screen gallery";

  const header = document.createElement("header");
  header.className = "topbar";
  const backBtn = document.createElement("button");
  backBtn.className = "nav-btn";
  backBtn.textContent = "🏠";
  backBtn.addEventListener("click", () => {
    blip(420);
    showLibrary();
  });
  const title = document.createElement("h1");
  title.textContent = "🖼️ できた さくひん";
  header.append(backBtn, title);
  screen.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "gallery-grid";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "gallery-empty";
    empty.textContent = "まだ さくひんが ないよ 🎨";
    grid.appendChild(empty);
  }
  for (const item of items) {
    const cell = document.createElement("div");
    cell.className = "gallery-item longpress";
    const img = document.createElement("img");
    img.src = item.dataUrl;
    img.draggable = false;
    cell.appendChild(img);
    // 長押しで削除（おとな向け操作）
    bindLongPress(cell, 1500, async () => {
      if (item.id !== undefined) await store.deleteGalleryItem(item.id).catch(() => {});
      cell.remove();
    });
    grid.appendChild(cell);
  }
  screen.appendChild(grid);
  app.appendChild(screen);
}

// ---------------------------------------------------------------- boot

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

// iPad Safari のダブルタップズーム抑止
document.addEventListener(
  "dblclick",
  (e) => {
    e.preventDefault();
  },
  { passive: false }
);

showLibrary();
