// 画面遷移 (ライブラリー / ぬりえ / ギャラリー) と composition root
import "./style.css";
import { catalog, lineArtSrc, drawLineArt, CANVAS_W, CANVAS_H, LineArt } from "./lineart";
import { PaintEngine } from "./paint";
import { buildToolbar, bindLongPress, bindTrashLongPress } from "./tools";
import * as store from "./store";
import { celebrate } from "./celebrate";
import { blip, startBgm, stopBgm, startBrush, stopBrush, makeMuteButton } from "./audio";
import {
  processUploadedImage,
  buildColoringPrompt,
  copyToClipboard,
  DEFAULT_PROMPT_OPTIONS,
  type PromptOptions,
} from "./template";
import { loadSharedArts } from "./shared";
import { cutOutSubjects, type Subject } from "./subject";
import { playSubjects } from "./animate";
import type { Category } from "./categories";
import { getAutoLevels, LEVELS, LEVEL_MARK, LEVEL_NAME, type Level } from "./level";

const app = document.getElementById("app")!;

// ライブラリーの分類フィルター（null = ぜんぶ）。再描画をまたいで保持する。
let libraryFilter: string | null = null;
// ライブラリーのレベルフィルター（null = ぜんぶ）。同じく再描画をまたいで保持する。
let libraryLevel: Level | null = null;

type ArtOrigin = "builtin" | "shared" | "local";

interface ArtEntry {
  art: LineArt;
  origin: ArtOrigin;
  category: string | null;
  hidden: boolean;
  /** 大人が手で決めたレベル。null は自動判定を使う */
  level: Level | null;
  /** 既定（上書き前）の名前。名前をリセットするときに使う */
  defaultName: string;
}

/** 3供給元の下絵をまとめて取得し、有効カテゴリー・非表示を算出して返す。 */
async function collectArts(): Promise<{
  categories: Category[];
  arts: ArtEntry[];
}> {
  const [templates, categories, artMeta, sharedArts] = await Promise.all([
    store.getTemplates().catch(() => []),
    store.getCategories().catch(() => [] as Category[]),
    store.getArtMeta().catch(() => new Map<string, store.ArtMeta>()),
    loadSharedArts().catch(() => [] as LineArt[]),
  ]);
  const validIds = new Set(categories.map((c) => c.id));
  const localArts: LineArt[] = templates.map((t) => ({
    id: t.id,
    name: t.name,
    imageUrl: t.imageUrl,
  }));

  const build = (art: LineArt, origin: ArtOrigin): ArtEntry => {
    const meta = artMeta.get(art.id);
    const hidden = meta?.hidden ?? false;
    // meta があればその categoryId を優先（null=みぶんるい）。無ければ既定 category。
    let category = meta ? meta.categoryId : art.category ?? null;
    if (category && !validIds.has(category)) category = null; // 削除済みカテゴリーは未分類扱い
    // 名前の上書き（あれば）。カタログ等の共有オブジェクトを汚さないよう複製する。
    const defaultName = art.name;
    const name = meta?.name ?? defaultName;
    const outArt = name === defaultName ? art : { ...art, name };
    return { art: outArt, origin, category, hidden, level: meta?.level ?? null, defaultName };
  };

  const arts = [
    ...localArts.map((a) => build(a, "local" as const)),
    ...sharedArts.map((a) => build(a, "shared" as const)),
    ...catalog.map((a) => build(a, "builtin" as const)),
  ];
  return { categories, arts };
}

/**
 * 下絵のレベルを解決する。auto は自動判定（初回だけ計算してキャッシュ）、
 * effective は「大人の上書き があればそれ、無ければ自動判定」。
 */
async function resolveLevels(arts: ArtEntry[]): Promise<{
  auto: Map<string, Level>;
  effective: Map<string, Level>;
}> {
  const auto = await getAutoLevels(arts.map((a) => a.art)).catch(() => new Map<string, Level>());
  const effective = new Map<string, Level>();
  for (const a of arts) {
    // 自動判定に失敗した下絵は「ふつう」に寄せる（絞り込みから消えないように）
    effective.set(a.art.id, a.level ?? auto.get(a.art.id) ?? 2);
  }
  return { auto, effective };
}

// ---- 親の強制フィルター（見せるレベル）。この端末に保存する ----

const ALLOWED_LEVELS_KEY = "dino-coloring:allowed-levels";

/** ライブラリーに出してよいレベル。未保存・壊れた値・空はぜんぶ許可。 */
function loadAllowedLevels(): Set<Level> {
  try {
    const saved = JSON.parse(localStorage.getItem(ALLOWED_LEVELS_KEY) ?? "");
    if (Array.isArray(saved)) {
      const set = new Set(LEVELS.filter((l) => saved.includes(l)));
      if (set.size > 0) return set;
    }
  } catch {
    // 未保存や壊れた値はぜんぶ許可
  }
  return new Set(LEVELS);
}

function saveAllowedLevels(levels: Set<Level>) {
  try {
    localStorage.setItem(ALLOWED_LEVELS_KEY, JSON.stringify(LEVELS.filter((l) => levels.has(l))));
  } catch {
    // 保存できなくても今回のセッション内では効かせられる
  }
}

// ---------------------------------------------------------------- library

async function showLibrary() {
  const workIds = await store.getWorkIds().catch(() => new Set<string>());
  const { categories, arts } = await collectArts();
  const { effective: levelOf } = await resolveLevels(arts);
  const allowedLevels = loadAllowedLevels();

  // 削除済みカテゴリーが選択中なら「ぜんぶ」に戻す
  if (libraryFilter && !categories.some((c) => c.id === libraryFilter)) libraryFilter = null;
  // 親の設定で見せなくなったレベルが選択中なら「ぜんぶ」に戻す
  if (libraryLevel !== null && !allowedLevels.has(libraryLevel)) libraryLevel = null;

  app.innerHTML = "";
  const screen = document.createElement("div");
  screen.className = "screen library";

  const header = document.createElement("header");
  header.className = "topbar";
  const title = document.createElement("h1");
  title.textContent = "🦕 ぬりえ をえらぼう";
  // おとなメニューは大人向け機能。長押しで起動する（誤操作防止）
  const makerBtn = document.createElement("button");
  makerBtn.className = "nav-btn maker-btn longpress";
  makerBtn.textContent = "🖊️";
  makerBtn.title = "おとなメニュー（長押し）";
  bindLongPress(makerBtn, 800, () => {
    blip(720);
    showAdultMenu();
  });
  const galleryBtn = document.createElement("button");
  galleryBtn.className = "nav-btn";
  galleryBtn.textContent = "🖼️";
  galleryBtn.title = "ギャラリー";
  galleryBtn.addEventListener("click", () => {
    blip(600);
    showGallery();
  });
  header.append(title, makeMuteButton(), makerBtn, galleryBtn);
  screen.appendChild(header);

  // 絞り込みバー: 左に分類チップ（多いので横スクロール）、右端にレベルチップを固定する
  const filterBar = document.createElement("div");
  filterBar.className = "filter-bar";
  const catGroup = document.createElement("div");
  catGroup.className = "filter-group filter-cats";
  const addChip = (label: string, value: string | null) => {
    const chip = document.createElement("button");
    chip.className = "filter-chip" + (libraryFilter === value ? " active" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => {
      libraryFilter = value;
      blip(560);
      showLibrary();
    });
    catGroup.appendChild(chip);
  };
  addChip("ぜんぶ", null);
  for (const c of categories) addChip(c.name, c.id);
  filterBar.appendChild(catGroup);

  // レベルチップ（★の数）。選んでいるものをもう一度押すと解除＝ぜんぶ。
  // 親が 1 レベルしか見せていないなら選ぶ余地が無いので出さない。
  if (allowedLevels.size > 1) {
    const levelGroup = document.createElement("div");
    levelGroup.className = "filter-group filter-levels";
    for (const lv of LEVELS) {
      if (!allowedLevels.has(lv)) continue;
      const chip = document.createElement("button");
      chip.className = "filter-chip level" + (libraryLevel === lv ? " active" : "");
      chip.textContent = LEVEL_MARK[lv];
      chip.title = LEVEL_NAME[lv];
      chip.addEventListener("click", () => {
        libraryLevel = libraryLevel === lv ? null : lv;
        blip(libraryLevel === null ? 480 : 600 + lv * 60);
        showLibrary();
      });
      levelGroup.appendChild(chip);
    }
    filterBar.append(levelGroup);
  }
  screen.appendChild(filterBar);

  const grid = document.createElement("div");
  grid.className = "library-grid";

  // レベルはカードには出さない（絵を見せたいので）。絞り込みチップだけで足りる。
  const makeCard = (art: LineArt, origin: ArtOrigin) => {
    const card = document.createElement("button");
    const local = origin === "local";
    card.className = "art-card" + (local ? " custom-card" : "");
    const img = document.createElement("img");
    img.src = lineArtSrc(art);
    img.alt = art.name;
    img.draggable = false;
    const label = document.createElement("span");
    label.className = "art-name";
    label.textContent = art.name;
    // 長押し演出で中身だけを縮めるため、絵と名前は内側にまとめる
    const inner = document.createElement("div");
    inner.className = "trash-inner";
    inner.append(img, label);
    card.appendChild(inner);
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
    // ローカル下絵は長押しで削除（おとな向け操作）。押している間ゴミ箱に吸い込まれ、
    // 縮みきったところで確認ダイアログを出す
    if (local) {
      bindTrashLongPress(
        card,
        3000,
        () => confirmDelete(1),
        async () => {
          await store.deleteTemplate(art.id).catch(() => {});
          showLibrary();
        }
      );
    }
    return card;
  };

  const visible = arts.filter((a) => {
    const level = levelOf.get(a.art.id) ?? 2;
    return (
      !a.hidden &&
      (libraryFilter === null || a.category === libraryFilter) &&
      allowedLevels.has(level) &&
      (libraryLevel === null || level === libraryLevel)
    );
  });
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "gallery-empty";
    empty.textContent = "ここには まだ ないよ 🦖";
    grid.appendChild(empty);
  }
  for (const a of visible) {
    grid.appendChild(makeCard(a.art, a.origin));
  }
  screen.appendChild(grid);
  app.appendChild(screen);

  // BGM は初期画面（ライブラリー）のみ。AudioContext のジェスチャ制約により
  // 実際の再生は最初のタップ後に始まる。
  startBgm();
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

// ---------------------------------------------------------------- adult menu

/** 汎用オーバーレイ枠。右上に✖️。既定では背景クリックでも閉じるが、opts で無効化できる。 */
function makeOverlay(
  boxClass: string,
  opts: { closeOnOutsideClick?: boolean } = {}
): { overlay: HTMLDivElement; box: HTMLDivElement } {
  const { closeOnOutsideClick = true } = opts;
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const box = document.createElement("div");
  box.className = boxClass;
  const closeBtn = document.createElement("button");
  closeBtn.className = "chooser-close";
  closeBtn.textContent = "✖️";
  closeBtn.addEventListener("click", () => overlay.remove());
  box.appendChild(closeBtn);
  overlay.appendChild(box);
  if (closeOnOutsideClick) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
  }
  return { overlay, box };
}

/** おとなメニュー（ハブ）。下絵づくり／かんり／カテゴリー編集への入口。 */
function showAdultMenu() {
  const { overlay, box } = makeOverlay("adult-menu", { closeOnOutsideClick: false });
  const heading = document.createElement("h1");
  heading.className = "tm-heading";
  heading.textContent = "🔧 おとなメニュー";

  const mkBtn = (label: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.className = "menu-btn";
    b.textContent = label;
    b.addEventListener("click", () => {
      blip(660);
      overlay.remove();
      onClick();
    });
    return b;
  };

  box.append(
    heading,
    mkBtn("🖊️ 下絵をつくる", () => showTemplateMaker()),
    mkBtn("🗂️ ぬりえのかんり（削除・分類・レベル）", () => showManage()),
    mkBtn("🏷️ カテゴリーのへんしゅう", () => showCategoryEditor()),
    mkBtn("⚙️ ぬりえのせってい", () => showColoringSettings())
  );
  app.appendChild(overlay);
}

// ---------------------------------------------------------------- coloring settings

const GUARD_KEY = "dino-coloring:guard-threshold";
const GUARD_DEFAULT = 36;
const GUARD_MAX = 200;

/** はみだしガードの閾値 (px)。0 = オフ。未保存・不正値はデフォルト。 */
function loadGuardThreshold(): number {
  try {
    const raw = localStorage.getItem(GUARD_KEY);
    if (raw === null) return GUARD_DEFAULT;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(GUARD_MAX, Math.max(0, v)) : GUARD_DEFAULT;
  } catch {
    return GUARD_DEFAULT;
  }
}

function saveGuardThreshold(v: number) {
  try {
    localStorage.setItem(GUARD_KEY, String(v));
  } catch {
    // 保存できなくても今回のセッション内では効かせられる
  }
}

/** ぬりえのせってい: はみだしガードの閾値と、子どもに見せるレベルを設定する。 */
function showColoringSettings() {
  const { overlay, box } = makeOverlay("adult-menu", { closeOnOutsideClick: false });
  const heading = document.createElement("h1");
  heading.className = "tm-heading";
  heading.textContent = "⚙️ ぬりえのせってい";

  const sub = document.createElement("h2");
  sub.className = "guard-sub";
  sub.textContent = "はみ出しガード";
  const desc = document.createElement("p");
  desc.className = "tm-desc";
  // 「レベル」はぬりえの難易度を指す語として使うので、ここでは「強さ」と呼ぶ
  desc.textContent =
    "「どのくらいはみ出すとはみ出した線が描かれるか」の強さです。大きいほどはみだしにくく、0でオフになります。";

  const row = document.createElement("div");
  row.className = "guard-row";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(GUARD_MAX);
  slider.step = "1";
  slider.value = String(loadGuardThreshold());
  slider.className = "guard-slider";
  const value = document.createElement("span");
  value.className = "guard-value";
  const render = () => {
    const v = Number(slider.value);
    value.textContent = v === 0 ? "オフ" : String(v);
  };
  render();
  slider.addEventListener("input", () => {
    saveGuardThreshold(Number(slider.value));
    render();
  });
  row.append(slider, value);

  // ---- 見せるレベル（親の強制フィルター）----
  const lvSub = document.createElement("h2");
  lvSub.className = "guard-sub";
  lvSub.textContent = "見せるレベル";
  const lvDesc = document.createElement("p");
  lvDesc.className = "tm-desc";
  lvDesc.textContent =
    "チェックしたレベルのぬりえだけを ライブラリーに出します。レベルは絵の複雑さから自動で決まり、「ぬりえのかんり」で変えられます。";

  const allowed = loadAllowedLevels();
  const lvRow = document.createElement("div");
  lvRow.className = "level-checks";
  for (const lv of LEVELS) {
    const label = document.createElement("label");
    label.className = "level-check";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = allowed.has(lv);
    const text = document.createElement("span");
    text.textContent = `${LEVEL_MARK[lv]} ${LEVEL_NAME[lv]}`;
    check.addEventListener("change", () => {
      // 全部off にすると 1枚も出せなくなるので、最後の 1つは外せない
      if (!check.checked && allowed.size === 1) {
        check.checked = true;
        blip(240);
        return;
      }
      if (check.checked) allowed.add(lv);
      else allowed.delete(lv);
      saveAllowedLevels(allowed);
      blip(check.checked ? 620 : 380);
    });
    label.append(check, text);
    lvRow.appendChild(label);
  }

  const foot = document.createElement("p");
  foot.className = "tm-desc";
  foot.textContent = "せっていは この端末に保存され、次にひらいたときも 有効です。";

  box.append(heading, sub, desc, row, lvSub, lvDesc, lvRow, foot);
  // 閉じたらライブラリーを更新（見せるレベルの変更を反映する）
  box.querySelector(".chooser-close")!.addEventListener("click", () => showLibrary());
  app.appendChild(overlay);
}

/** ぬりえのかんり: 全下絵の削除（ローカル）・非表示（組み込み/共有）・カテゴリー/レベル割当。 */
async function showManage() {
  const { overlay, box } = makeOverlay("manage", { closeOnOutsideClick: false });
  const { categories, arts } = await collectArts();
  const { auto: autoLevels } = await resolveLevels(arts);

  const heading = document.createElement("h1");
  heading.className = "tm-heading";
  heading.textContent = "🗂️ ぬりえのかんり";
  const desc = document.createElement("p");
  desc.className = "tm-desc";
  desc.textContent =
    "なまえ・分類・レベルを変えたり、いらないぬりえを消せます。組み込み・共有の下絵は「非表示」にでき、あとで戻せます。";

  const list = document.createElement("div");
  list.className = "manage-list";

  const originLabel: Record<ArtOrigin, string> = {
    builtin: "組み込み",
    shared: "共有",
    local: "この端末",
  };

  for (const a of arts) {
    const row = document.createElement("div");
    row.className = "manage-row" + (a.hidden ? " row-hidden" : "");

    const img = document.createElement("img");
    img.className = "manage-thumb";
    img.src = lineArtSrc(a.art);
    img.draggable = false;

    const info = document.createElement("div");
    info.className = "manage-info";
    const nm = document.createElement("input");
    nm.type = "text";
    nm.className = "manage-name";
    nm.value = a.art.name;
    nm.title = "なまえを へんしゅう";
    nm.setAttribute("aria-label", "なまえ");
    // 空欄／既定名と同じなら上書きを解除して既定名に戻す。
    nm.addEventListener("change", async () => {
      const v = nm.value.trim();
      if (v === "" || v === a.defaultName) {
        nm.value = a.defaultName;
        await store.setArtName(a.art.id, null).catch(() => {});
      } else {
        nm.value = v;
        await store.setArtName(a.art.id, v).catch(() => {});
      }
      blip(660);
    });
    const org = document.createElement("div");
    org.className = "manage-origin";
    org.textContent = originLabel[a.origin];
    info.append(nm, org);

    // カテゴリー select
    const sel = document.createElement("select");
    sel.className = "manage-select";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "みぶんるい";
    sel.appendChild(none);
    for (const c of categories) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      sel.appendChild(opt);
    }
    sel.value = a.category ?? "";
    sel.addEventListener("change", async () => {
      await store.setArtCategory(a.art.id, sel.value || null).catch(() => {});
    });

    // レベル select（空 = 自動判定にまかせる）
    const lvSel = document.createElement("select");
    lvSel.className = "manage-select";
    lvSel.title = "レベル";
    const autoLevel = autoLevels.get(a.art.id) ?? 2;
    const autoOpt = document.createElement("option");
    autoOpt.value = "";
    autoOpt.textContent = `じどう（${LEVEL_MARK[autoLevel]}）`;
    lvSel.appendChild(autoOpt);
    for (const lv of LEVELS) {
      const opt = document.createElement("option");
      opt.value = String(lv);
      opt.textContent = `${LEVEL_MARK[lv]} ${LEVEL_NAME[lv]}`;
      lvSel.appendChild(opt);
    }
    lvSel.value = a.level === null ? "" : String(a.level);
    lvSel.addEventListener("change", async () => {
      const lv = lvSel.value === "" ? null : (Number(lvSel.value) as Level);
      await store.setArtLevel(a.art.id, lv).catch(() => {});
    });

    const selects = document.createElement("div");
    selects.className = "manage-selects";
    selects.append(sel, lvSel);

    // 操作ボタン
    const actions = document.createElement("div");
    actions.className = "manage-actions";
    if (a.origin === "local") {
      const del = document.createElement("button");
      del.className = "manage-icon danger";
      del.textContent = "🗑";
      del.title = "削除";
      del.addEventListener("click", async () => {
        await store.deleteTemplate(a.art.id).catch(() => {});
        blip(300);
        row.remove();
      });
      actions.appendChild(del);
    } else {
      const toggle = document.createElement("button");
      toggle.className = "manage-icon";
      const render = () => {
        toggle.textContent = a.hidden ? "🙈" : "👁️";
        toggle.title = a.hidden ? "ひょうじする" : "ひひょうじにする";
        row.classList.toggle("row-hidden", a.hidden);
      };
      render();
      toggle.addEventListener("click", async () => {
        a.hidden = !a.hidden;
        await store.setArtHidden(a.art.id, a.hidden).catch(() => {});
        blip(a.hidden ? 320 : 600);
        render();
      });
      actions.appendChild(toggle);
    }

    row.append(img, info, selects, actions);
    list.appendChild(row);
  }

  const foot = document.createElement("p");
  foot.className = "tm-desc";
  foot.textContent = "とじると ライブラリーに はんえいされます。";

  const body = document.createElement("div");
  body.className = "modal-body";
  body.append(desc, list, foot);

  box.append(heading, body);
  // 閉じたらライブラリーを更新
  box.querySelector(".chooser-close")!.addEventListener("click", () => showLibrary());
  app.appendChild(overlay);
}

/** カテゴリーのへんしゅう: 追加・リネーム・削除。 */
async function showCategoryEditor() {
  const { overlay, box } = makeOverlay("cat-editor", { closeOnOutsideClick: false });
  const heading = document.createElement("h1");
  heading.className = "tm-heading";
  heading.textContent = "🏷️ カテゴリー";

  const list = document.createElement("div");
  list.className = "cat-list";

  const renderList = async () => {
    const categories = await store.getCategories().catch(() => []);
    list.innerHTML = "";
    for (const c of categories) {
      const row = document.createElement("div");
      row.className = "cat-row";
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "tm-input";
      nameInput.value = c.name;
      nameInput.addEventListener("change", async () => {
        const v = nameInput.value.trim();
        if (v) await store.renameCategory(c.id, v).catch(() => {});
      });
      const del = document.createElement("button");
      del.className = "manage-icon danger";
      del.textContent = "🗑";
      del.title = "削除";
      del.addEventListener("click", async () => {
        await store.deleteCategory(c.id).catch(() => {});
        blip(300);
        await renderList();
      });
      row.append(nameInput, del);
      list.appendChild(row);
    }
  };

  const addRow = document.createElement("div");
  addRow.className = "cat-row";
  const addInput = document.createElement("input");
  addInput.type = "text";
  addInput.className = "tm-input";
  addInput.placeholder = "あたらしい分類（例: うみのいきもの）";
  const addBtn = document.createElement("button");
  addBtn.className = "tm-btn";
  addBtn.textContent = "＋ ついか";
  addBtn.addEventListener("click", async () => {
    const v = addInput.value.trim();
    if (!v) return;
    await store.addCategory(v).catch(() => {});
    addInput.value = "";
    blip(680);
    await renderList();
  });
  addRow.append(addInput, addBtn);

  const body = document.createElement("div");
  body.className = "modal-body";
  body.append(list, addRow);

  box.append(heading, body);
  box.querySelector(".chooser-close")!.addEventListener("click", () => showLibrary());
  app.appendChild(overlay);
  await renderList();
}

// ---------------------------------------------------------------- template maker

const PROMPT_OPTIONS_KEY = "dino-coloring:prompt-options";

/** つくり方（text/image）専用の定義。他の軸とは見た目を分けて① 直下に大きく置くため、
 * チップ行を並べる PROMPT_OPTION_DEFS には含めない（読み込み・保存の検証にだけ使う）。 */
const MODE_DEF = {
  key: "mode" as const,
  choices: [
    { value: "image", label: "画像から" },
    { value: "text", label: "言葉から" },
  ],
};

/** プロンプトオプションの各軸のUIラベルと選択肢（チップの表示順）。
 * modes を省略すると両モードで表示、指定するとそのモードのときだけ表示する。 */
const PROMPT_OPTION_DEFS: {
  key: keyof PromptOptions;
  label: string;
  choices: { value: string; label: string }[];
  modes?: PromptOptions["mode"][];
}[] = [
  {
    key: "fidelity",
    label: "忠実さ",
    choices: [
      { value: "faithful", label: "そのまま" },
      { value: "balanced", label: "すこし単純" },
      { value: "simple", label: "しっかり単純" },
    ],
    modes: ["image"],
  },
  {
    key: "style",
    label: "画風",
    choices: [
      { value: "cute", label: "かわいい" },
      { value: "normal", label: "ふつう" },
      { value: "realistic", label: "リアル" },
    ],
    modes: ["text"],
  },
  {
    key: "line",
    label: "線の太さ",
    choices: [
      { value: "thick", label: "ふとい" },
      { value: "normal", label: "ふつう" },
      { value: "thin", label: "ほそめ" },
    ],
  },
  {
    key: "background",
    label: "背景",
    choices: [
      { value: "none", label: "なし" },
      { value: "simple", label: "シンプル" },
      { value: "full", label: "しっかり" },
    ],
  },
  {
    key: "detail",
    label: "細かさ",
    choices: [
      { value: "very-easy", label: "とてもかんたん" },
      { value: "easy", label: "かんたん" },
      { value: "normal", label: "ふつう" },
    ],
    modes: ["text"],
  },
];

/** 保存済みのプロンプトオプションを読む。不正値・未保存はデフォルトにフォールバック。 */
function loadPromptOptions(): PromptOptions {
  const opts: Record<string, string> = { ...DEFAULT_PROMPT_OPTIONS };
  try {
    const saved = JSON.parse(localStorage.getItem(PROMPT_OPTIONS_KEY) ?? "");
    for (const def of [MODE_DEF, ...PROMPT_OPTION_DEFS]) {
      const v = saved?.[def.key];
      if (def.choices.some((c) => c.value === v)) opts[def.key] = v;
    }
  } catch {
    // 未保存や壊れた値はデフォルトのまま
  }
  return opts as unknown as PromptOptions;
}

function savePromptOptions(opts: PromptOptions) {
  try {
    localStorage.setItem(PROMPT_OPTIONS_KEY, JSON.stringify(opts));
  } catch {
    // 保存できなくても機能には影響しない
  }
}

/** 下絵メーカー: 生成プロンプト作成 と 画像アップロード のオーバーレイ */
async function showTemplateMaker() {
  const categories = await store.getCategories().catch(() => []);
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const box = document.createElement("div");
  box.className = "template-maker";

  const closeBtn = document.createElement("button");
  closeBtn.className = "chooser-close";
  closeBtn.textContent = "✖️";
  closeBtn.addEventListener("click", () => overlay.remove());

  const heading = document.createElement("h1");
  heading.className = "tm-heading";
  heading.textContent = "🖊️ 下絵メーカー（おとな向け）";

  // ---- セクション1: プロンプトを作る ----
  const sec1 = document.createElement("section");
  sec1.className = "tm-section";
  const h1 = document.createElement("h2");
  h1.textContent = "① プロンプトを作る";

  const promptOpts = loadPromptOptions();

  // つくり方（画像から／言葉から）は他の軸と違って生成物そのものを切り替える大きな分岐なので、
  // 小さなチップとは見た目を分けた大きめのトグルにして見出し直下に置く。
  const modeToggle = document.createElement("div");
  modeToggle.className = "tm-mode-toggle";
  const modeButtons: HTMLButtonElement[] = [];
  for (const choice of MODE_DEF.choices) {
    const modeBtn = document.createElement("button");
    modeBtn.type = "button";
    modeBtn.className = "tm-mode-btn";
    modeBtn.textContent = choice.label;
    modeBtn.classList.toggle("active", promptOpts.mode === choice.value);
    modeBtn.addEventListener("click", () => {
      promptOpts.mode = choice.value as PromptOptions["mode"];
      for (const b of modeButtons) b.classList.toggle("active", b === modeBtn);
      savePromptOptions(promptOpts);
      blip(600);
      refreshMode();
    });
    modeButtons.push(modeBtn);
    modeToggle.appendChild(modeBtn);
  }

  const desc1 = document.createElement("p");
  desc1.className = "tm-desc";

  const DESC_BY_MODE: Record<PromptOptions["mode"], string> = {
    text: "描きたいものを日本語で入力して「作る」を押すと、画像生成AI（ChatGPT など）に貼り付ける英語のプロンプトが生成され、クリップボードにコピーされます。",
    image:
      "手持ちの写真やイラストをぬりえにしたいときのモードです。画像の説明（任意）を入れて「作る」を押すとプロンプトができるので、ChatGPT などに元の画像を添付し、プロンプトを貼り付けて送ってください。",
  };
  const PLACEHOLDER_BY_MODE: Record<PromptOptions["mode"], string> = {
    text: "例: トリケラトプスとティラノサウルスのたたかい",
    image: "例: いえで飼っているねこ（にんい）",
  };

  const input = document.createElement("input");
  input.type = "text";
  input.className = "tm-input";

  // 作り方の手順案内。モードを問わず出す。生成後、画像モードだけ「元画像を添付して」を強調する。
  const note = document.createElement("p");
  note.className = "tm-note";
  const NOTE_GUIDE_BY_MODE: Record<PromptOptions["mode"], string> = {
    text: "手順: ① プロンプトを作る → ChatGPT などにこのプロンプトを貼り付けて送る → できあがった白背景の線画を②でアップロード",
    image:
      "手順: ① プロンプトを作る → ChatGPT などに元の画像を添付して、このプロンプトを貼り付ける → できあがった白背景の線画を②でアップロード",
  };
  const NOTE_REMINDER = "⚠️ 元の画像を添付してから、このプロンプトを貼り付けてください";

  // 画像の感じの指定チップ（各軸で排他選択）。選択は localStorage に保存して次回復元。
  const optionsBox = document.createElement("div");
  optionsBox.className = "tm-options";
  const rows: { row: HTMLDivElement; modes?: PromptOptions["mode"][] }[] = [];
  for (const def of PROMPT_OPTION_DEFS) {
    const row = document.createElement("div");
    row.className = "tm-option-row";
    const label = document.createElement("span");
    label.className = "tm-option-label";
    label.textContent = def.label;
    row.appendChild(label);
    const chips: HTMLButtonElement[] = [];
    for (const choice of def.choices) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tm-chip";
      chip.textContent = choice.label;
      chip.classList.toggle("active", promptOpts[def.key] === choice.value);
      chip.addEventListener("click", () => {
        (promptOpts as unknown as Record<string, string>)[def.key] = choice.value;
        for (const c of chips) c.classList.toggle("active", c === chip);
        savePromptOptions(promptOpts);
        blip(600);
      });
      chips.push(chip);
      row.appendChild(chip);
    }
    optionsBox.appendChild(row);
    rows.push({ row, modes: def.modes });
  }

  const makeBtn = document.createElement("button");
  makeBtn.className = "tm-btn";
  makeBtn.textContent = "作る 📋";

  const output = document.createElement("textarea");
  output.className = "tm-output";
  output.readOnly = true;
  output.rows = 8;
  output.hidden = true;

  const toast = document.createElement("div");
  toast.className = "tm-toast";
  toast.hidden = true;

  /** モードに応じて、説明文・プレースホルダー・チップ行の表示・案内ノートを切り替える。
   * 前のモードで作った出力はモードが変わったら混乱のもとなので消す。 */
  function refreshMode() {
    const mode = promptOpts.mode;
    desc1.textContent = DESC_BY_MODE[mode];
    input.placeholder = PLACEHOLDER_BY_MODE[mode];
    for (const { row, modes } of rows) row.hidden = modes != null && !modes.includes(mode);
    note.textContent = NOTE_GUIDE_BY_MODE[mode];
    output.hidden = true;
    toast.hidden = true;
  }
  refreshMode();

  makeBtn.addEventListener("click", async () => {
    blip(680);
    const prompt = buildColoringPrompt(input.value, promptOpts);
    output.value = prompt;
    output.hidden = false;
    const ok = await copyToClipboard(prompt);
    toast.textContent = ok ? "コピーしました ✅" : "コピーできませんでした。選択してコピーしてください";
    toast.hidden = false;
    if (promptOpts.mode === "image") note.textContent = NOTE_REMINDER;
  });

  sec1.append(h1, modeToggle, desc1, input, optionsBox, note, makeBtn, output, toast);

  // ---- セクション2: 画像をアップロード ----
  const sec2 = document.createElement("section");
  sec2.className = "tm-section";
  const h2 = document.createElement("h2");
  h2.textContent = "② 画像をアップロード";
  const desc2 = document.createElement("p");
  desc2.className = "tm-desc";
  desc2.textContent =
    "AIで作った白背景の下絵画像を選ぶと、ぬりえに追加されます。名前は①の「描きたいもの」が初期値です（変更可）。";

  // 名前欄。初期値は①の「描きたいもの」。ユーザーが手で編集するまでは追従する。
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "tm-input";
  nameInput.placeholder = "マイぬりえ";
  nameInput.value = input.value;
  let nameEdited = false;
  nameInput.addEventListener("input", () => {
    nameEdited = true;
  });
  input.addEventListener("input", () => {
    if (!nameEdited) nameInput.value = input.value;
  });

  // カテゴリー選択（任意）。既定は「みぶんるい」。
  const catSelect = document.createElement("select");
  catSelect.className = "tm-input tm-select";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "みぶんるい";
  catSelect.appendChild(noneOpt);
  for (const c of categories) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    catSelect.appendChild(opt);
  }

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.className = "tm-file";
  fileInput.id = "tm-file-input";
  const fileLabel = document.createElement("label");
  fileLabel.className = "tm-btn tm-upload";
  fileLabel.htmlFor = "tm-file-input";
  fileLabel.textContent = "画像を選ぶ 🖼️";

  const status = document.createElement("div");
  status.className = "tm-toast";
  status.hidden = true;

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    status.hidden = false;
    status.textContent = "変換中… ⏳";
    fileLabel.classList.add("disabled");
    try {
      const imageUrl = await processUploadedImage(file);
      const createdAt = Date.now();
      const id = "custom-" + createdAt;
      const name = nameInput.value.trim() || "マイぬりえ";
      await store.addTemplate({ id, name, imageUrl, createdAt });
      if (catSelect.value) await store.setArtCategory(id, catSelect.value).catch(() => {});
      blip(760);
      overlay.remove();
      showLibrary();
    } catch {
      status.textContent = "この画像は読み込めませんでした 😢";
      fileLabel.classList.remove("disabled");
      fileInput.value = "";
    }
  });

  sec2.append(h2, desc2, nameInput, catSelect, fileLabel, fileInput, status);

  const body = document.createElement("div");
  body.className = "template-maker-body";
  body.append(sec1, sec2);

  box.append(closeBtn, heading, body);
  overlay.appendChild(box);
  app.appendChild(overlay);
}

// ---------------------------------------------------------------- coloring

async function showColoring(art: LineArt, resume: boolean) {
  stopBgm(); // ぬりえ画面では BGM を止める
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
  header.append(backBtn, artTitle, makeMuteButton(), doneBtn);
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
  engine.setGuardThreshold(loadGuardThreshold());

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
  // ドラッグ中は塗り/消しゴム音を継続再生する
  engine.onStrokeStart = () => startBrush(engine.getMode());
  engine.onStrokeEnd = () => {
    stopBrush();
    toolbar.refresh();
    scheduleSave();
  };

  workspace.append(toolbar.colorsEl, stageWrap, toolbar.toolsEl);
  screen.appendChild(workspace);
  app.appendChild(screen);

  // 線画と保存済みの塗りをロード
  await drawLineArt(lineartCanvas, art).catch(() => {});
  // 線画からはみだしガード用の障壁マップを作る（読めない画像などで失敗したらガードなし）
  try {
    engine.setLineart(lineartCanvas);
  } catch {
    // 例: 外部画像で canvas が汚染されて getImageData できない場合
  }
  if (resume) {
    const work = await store.getWork(art.id).catch(() => undefined);
    if (work) await engine.loadDataUrl(work.dataUrl).catch(() => {});
  }

  const pagehide = () => {
    stopBrush();
    void flushSave();
  };
  window.addEventListener("pagehide", pagehide);

  backBtn.addEventListener("click", async () => {
    stopBrush();
    blip(420);
    window.removeEventListener("pagehide", pagehide);
    await flushSave();
    showLibrary();
  });

  doneBtn.addEventListener("click", async () => {
    doneBtn.disabled = true;
    stopBrush();
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
    // 切り抜きは数百 ms かかるので、紙吹雪を出している間に裏で走らせる
    const cutting = cutOutSubjects(art, composite).catch(() => [] as Subject[]);
    await celebrate();
    // 主役をきれいに切り出せた下絵だけ「うごかす」演出へ進む
    const subjects = await cutting;
    if (subjects.length > 0) await playSubjects(composite, subjects);
    showGallery();
  });
}

// ---------------------------------------------------------------- gallery

/** 升目のすき間 (px)。CSS の .gallery-grid gap と同じ値にすること */
const GALLERY_GAP = 20;
/** 升目 1 つの最小幅 (px)。これを下回らない範囲で列数を決める */
const GALLERY_MIN_W = 260;

/** 「○こ けしても いい？」の確認。けす を選んだら true */
function confirmDelete(count: number): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const box = document.createElement("div");
    box.className = "chooser confirm";

    const msg = document.createElement("p");
    msg.className = "confirm-msg";
    msg.textContent = `${count}こ けしても いい？`;

    const close = (ok: boolean) => {
      overlay.remove();
      resolve(ok);
    };

    const yesBtn = document.createElement("button");
    yesBtn.className = "chooser-btn";
    yesBtn.innerHTML = "🗑️<span>けす</span>";
    yesBtn.addEventListener("click", () => {
      blip(300);
      close(true);
    });

    const noBtn = document.createElement("button");
    noBtn.className = "chooser-btn";
    noBtn.innerHTML = "↩️<span>やめる</span>";
    noBtn.addEventListener("click", () => {
      blip(700);
      close(false);
    });

    const row = document.createElement("div");
    row.className = "confirm-row";
    row.append(yesBtn, noBtn);

    const closeBtn = document.createElement("button");
    closeBtn.className = "chooser-close";
    closeBtn.textContent = "✖️";
    closeBtn.addEventListener("click", () => close(false));

    box.append(msg, row, closeBtn);
    overlay.appendChild(box);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    app.appendChild(overlay);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("作品を読み込めませんでした"));
    img.src = src;
  });
}

async function showGallery() {
  stopBgm(); // ギャラリーでは BGM を止める
  let items = await store.getGallery().catch(() => []);
  // タップで「うごかす」を再生するため、作品の下絵を引けるようにしておく
  const artById = new Map<string, LineArt>();
  for (const a of (await collectArts().catch(() => ({ arts: [] }))).arts) {
    artById.set(a.art.id, a.art);
  }

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
  const selectBtn = document.createElement("button");
  selectBtn.className = "nav-btn";
  header.append(backBtn, title, selectBtn, makeMuteButton());
  screen.appendChild(header);

  const area = document.createElement("div");
  area.className = "gallery-area";
  const grid = document.createElement("div");
  grid.className = "gallery-grid";
  area.appendChild(grid);
  screen.appendChild(area);

  // ---- フッター: ページ送りと、選択中の操作 ----
  const footer = document.createElement("div");
  footer.className = "gallery-footer";
  const prevBtn = document.createElement("button");
  prevBtn.className = "nav-btn";
  prevBtn.textContent = "◀";
  const pageLabel = document.createElement("span");
  pageLabel.className = "gallery-page-label";
  const nextBtn = document.createElement("button");
  nextBtn.className = "nav-btn";
  nextBtn.textContent = "▶";
  const pager = document.createElement("div");
  pager.className = "gallery-pager";
  pager.append(prevBtn, pageLabel, nextBtn);
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "nav-btn danger-btn";
  footer.append(pager, deleteBtn);
  screen.appendChild(footer);

  app.appendChild(screen);

  /**
   * いま見ている先頭の作品の位置。ページ番号ではなく作品の位置で覚えるのは、
   * 向きを変えて 1 ページの枚数が変わっても同じあたりの作品に留まるため。
   * 表示できる範囲へ丸めるのは描画時だけで、この値自体は書き戻さない。一時的に
   * 全部が 1 ページに収まっても、元の大きさに戻れば元のページに帰ってこられる。
   */
  let anchor = 0;
  /** 直近の描画で使った先頭位置と 1 ページの枚数（送り幅の計算に使う） */
  let shownFrom = 0;
  let shownSize = 1;
  let selecting = false;
  const selected = new Set<number>();

  /** 表示領域から列数と 1 ページの枚数を出す */
  function layout(): { cols: number; size: number } {
    const w = grid.clientWidth;
    const h = grid.clientHeight;
    const cols = Math.max(1, Math.floor((w + GALLERY_GAP) / (GALLERY_MIN_W + GALLERY_GAP)));
    const cellW = (w - GALLERY_GAP * (cols - 1)) / cols;
    const cellH = (cellW * 3) / 4; // 下絵は 4:3
    const rows = Math.max(1, Math.floor((h + GALLERY_GAP) / (cellH + GALLERY_GAP)));
    return { cols, size: cols * rows };
  }

  function setSelecting(on: boolean) {
    selecting = on;
    selected.clear();
    render();
  }

  async function removeItems(ids: number[]) {
    await store.deleteGalleryItems(ids).catch(() => {});
    items = items.filter((it) => it.id === undefined || !ids.includes(it.id));
    selected.clear();
    render();
  }

  function makeCell(item: store.GalleryItem): HTMLElement {
    const cell = document.createElement("div");
    cell.className = "gallery-item";
    const inner = document.createElement("div");
    inner.className = "trash-inner";
    const img = document.createElement("img");
    img.src = item.dataUrl;
    img.draggable = false;
    inner.appendChild(img);
    cell.appendChild(inner);

    if (selecting) {
      cell.classList.add("selectable");
      const check = document.createElement("span");
      check.className = "gallery-check";
      const sel = item.id !== undefined && selected.has(item.id);
      if (sel) cell.classList.add("selected");
      check.textContent = sel ? "✓" : "";
      cell.appendChild(check);
      cell.addEventListener("click", () => {
        if (item.id === undefined) return;
        blip(selected.has(item.id) ? 480 : 720);
        if (selected.has(item.id)) selected.delete(item.id);
        else selected.add(item.id);
        render();
      });
      return cell;
    }

    // 普通モード: タップで「うごかす」、長押しでゴミ箱へ→確認ダイアログ
    cell.addEventListener("click", () => {
      blip(660);
      void playWork(item);
    });
    bindTrashLongPress(
      cell,
      3000,
      () => confirmDelete(1),
      () => {
        if (item.id !== undefined) void removeItems([item.id]);
      }
    );
    return cell;
  }

  /** 作品を「うごかす」画面で開く。主役を切り出せなければ大きい表示になる */
  async function playWork(item: store.GalleryItem) {
    const img = await loadImage(item.dataUrl).catch(() => null);
    if (!img) return;
    const art = artById.get(item.lineartId);
    // 下絵が消えている作品は動かしようがないので、そのまま大きく見せる
    const subjects = art ? await cutOutSubjects(art, img).catch(() => [] as Subject[]) : [];
    await playSubjects(img, subjects);
  }

  function render() {
    const { cols, size } = layout();
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

    const pages = Math.max(1, Math.ceil(items.length / size));
    const page = Math.min(Math.max(0, Math.floor(anchor / size)), pages - 1);
    const from = page * size;
    shownFrom = from;
    shownSize = size;

    grid.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "gallery-empty";
      empty.textContent = "まだ さくひんが ないよ 🎨";
      grid.appendChild(empty);
    }
    for (const item of items.slice(from, from + size)) {
      grid.appendChild(makeCell(item));
    }

    pageLabel.textContent = `${page + 1} / ${pages}`;
    prevBtn.disabled = page === 0;
    nextBtn.disabled = page >= pages - 1;
    pager.hidden = pages <= 1;

    selectBtn.textContent = selecting ? "↩️ やめる" : "🗑️ えらんで けす";
    selectBtn.hidden = items.length === 0;
    deleteBtn.textContent = `🗑️ ${selected.size}こ けす`;
    deleteBtn.hidden = !selecting;
    deleteBtn.disabled = selected.size === 0;
    footer.hidden = pager.hidden && !selecting;
  }

  prevBtn.addEventListener("click", () => {
    blip(520);
    anchor = Math.max(0, shownFrom - shownSize);
    render();
  });
  nextBtn.addEventListener("click", () => {
    blip(620);
    anchor = shownFrom + shownSize;
    render();
  });
  selectBtn.addEventListener("click", () => {
    blip(selecting ? 420 : 700);
    setSelecting(!selecting);
  });
  deleteBtn.addEventListener("click", async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!(await confirmDelete(ids.length))) return;
    await removeItems(ids);
    setSelecting(false);
  });

  // 向きの変更などで 1 ページの枚数が変わるため作り直す。window の resize ではなく
  // グリッド自身を見るのは、画面の作り替えを伴わないレイアウト変化も拾うため。
  // グリッドの大きさは flex で決まり中身に影響されないので、再描画がループすることはない。
  const observer = new ResizeObserver(() => {
    if (!document.body.contains(grid)) {
      observer.disconnect();
      return;
    }
    render();
  });
  observer.observe(grid);

  render();
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
