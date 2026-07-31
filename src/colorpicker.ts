// 自作のカラーピッカー。
//
// `<input type="color">` を非表示にして showPicker() で開く実装は iPad の Safari
// (WebKit) では反応しないことがあり、「じぶんのいろ」の枠をタップしても何も
// 起きない不具合の原因になっていた。ネイティブの色ピッカーには頼らず、色相・
// 彩度・明度の3本のスライダー + プレビューだけで完結する自作の UI に置き換える。
//
// 既存の他オーバーレイ（main.ts の makeOverlay）と見た目・構造を揃えるため、
// クラス名は .overlay / .chooser-close をそのまま使う。ただし tools.ts は
// アプリのルート要素を持っていないため、document.body に直接 append する
// （.overlay は position:fixed; inset:0 なので見え方は変わらない）。

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** h: 0-360, s/l: 0-100 → "#rrggbb" */
function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = lN - c / 2;
  const toByte = (v: number) => clamp(Math.round((v + m) * 255), 0, 255);
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${hex(toByte(r))}${hex(toByte(g))}${hex(toByte(b))}`;
}

/** "#rrggbb" → h: 0-360, s/l: 0-100 */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  const r = (m ? parseInt(m[1], 16) : 0) / 255;
  const g = (m ? parseInt(m[2], 16) : 0) / 255;
  const b = (m ? parseInt(m[3], 16) : 0) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: Math.round(l * 100) };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function makeRow(labelText: string, min: number, max: number, value: number) {
  const row = document.createElement("div");
  row.className = "picker-row";
  const label = document.createElement("span");
  label.className = "picker-label";
  label.textContent = labelText;
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(min);
  slider.max = String(max);
  slider.step = "1";
  slider.value = String(value);
  slider.className = "picker-slider";
  row.append(label, slider);
  return { row, slider };
}

/**
 * カラーピッカーを開き、選んだ色 (hex) を Promise で返す。
 * ✖️ または背景タップでキャンセルすると null を返す。
 */
export function openColorPicker(initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const { h: h0, s: s0, l: l0 } = hexToHsl(initial);
    let h = h0;
    let s = s0;
    let l = l0;

    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const box = document.createElement("div");
    box.className = "color-picker";

    const closeBtn = document.createElement("button");
    closeBtn.className = "chooser-close";
    closeBtn.textContent = "✖️";

    const preview = document.createElement("div");
    preview.className = "picker-preview";

    const hueRow = makeRow("いろ", 0, 360, h);
    hueRow.row.classList.add("picker-row-hue");
    const satRow = makeRow("あざやかさ", 0, 100, s);
    const lightRow = makeRow("あかるさ", 0, 100, l);

    const decideBtn = document.createElement("button");
    decideBtn.className = "tm-btn picker-decide";
    decideBtn.textContent = "けってい";

    const render = () => {
      const hex = hslToHex(h, s, l);
      preview.style.setProperty("--c", hex);
    };
    render();

    const bind = (slider: HTMLInputElement, onChange: (v: number) => void) => {
      slider.addEventListener("input", () => {
        onChange(Number(slider.value));
        render();
      });
    };
    bind(hueRow.slider, (v) => (h = v));
    bind(satRow.slider, (v) => (s = v));
    bind(lightRow.slider, (v) => (l = v));

    let settled = false;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(result);
    };

    closeBtn.addEventListener("click", () => finish(null));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    decideBtn.addEventListener("click", () => finish(hslToHex(h, s, l)));

    box.append(
      closeBtn,
      preview,
      hueRow.row,
      satRow.row,
      lightRow.row,
      decideBtn
    );
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}
