// サウンドエンジン: WebAudio 合成（音声ファイル不要）で
// ボタン音 blip / BGM / 継続ブラシ音 を鳴らし、消音状態を一元管理する。

import type { PaintMode } from "./paint";

let audioCtx: AudioContext | null = null;

/** 共有 AudioContext。suspended（ユーザー操作前）なら resume を試みる */
export function getAudio(): AudioContext | null {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 消音状態

const MUTE_KEY = "dino-coloring-muted";
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
})();
const muteListeners = new Set<(m: boolean) => void>();

export function isMuted(): boolean {
  return muted;
}

export function setMuted(v: boolean) {
  muted = v;
  try {
    localStorage.setItem(MUTE_KEY, v ? "1" : "0");
  } catch {
    // localStorage 不可でも動作は継続する
  }
  if (v) {
    // 鳴っている継続音を即座に止める
    stopBgm();
    stopBrush();
  } else if (bgmWanted) {
    // ミュート解除時、BGM を望む画面なら鳴らし直す
    startBgm();
  }
  for (const cb of muteListeners) cb(v);
}

export function toggleMute() {
  setMuted(!muted);
}

export function onMuteChange(cb: (m: boolean) => void): () => void {
  muteListeners.add(cb);
  return () => muteListeners.delete(cb);
}

// ---------------------------------------------------------------- 単発音

export function tone(ctx: AudioContext, freq: number, start: number, dur: number, gainMax = 0.18) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, ctx.currentTime + start);
  gain.gain.linearRampToValueAtTime(gainMax, ctx.currentTime + start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(ctx.currentTime + start);
  osc.stop(ctx.currentTime + start + dur + 0.05);
}

/** ボタンタップの軽いポン音 */
export function blip(freq = 660) {
  if (muted) return;
  const ctx = getAudio();
  if (!ctx) return;
  tone(ctx, freq, 0, 0.12, 0.1);
}

/** 恐竜の鳴き声。低い音を唸らせながら下げる */
export function roar() {
  if (muted) return;
  const ctx = getAudio();
  if (!ctx) return;
  const t = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(190, t);
  osc.frequency.exponentialRampToValueAtTime(70, t + 0.55);

  // 低めに絞って「ガオー」の丸みを出す
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(1000, t);
  filter.frequency.exponentialRampToValueAtTime(300, t + 0.55);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.22, t + 0.06);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);

  // 唸り（細かい音量の揺れ）
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 18;
  lfoGain.gain.value = 0.06;
  lfo.connect(lfoGain).connect(gain.gain);

  osc.connect(filter).connect(gain).connect(ctx.destination);
  osc.start(t);
  lfo.start(t);
  osc.stop(t + 0.65);
  lfo.stop(t + 0.65);
}

// ---------------------------------------------------------------- BGM

// ゆったりした童謡風メロディ（Hz, 拍数）。0 拍は休符扱い。
const BGM_NOTES: { f: number; beats: number }[] = [
  { f: 523.25, beats: 1 }, // ド
  { f: 587.33, beats: 1 }, // レ
  { f: 659.25, beats: 1 }, // ミ
  { f: 523.25, beats: 1 }, // ド
  { f: 659.25, beats: 1 }, // ミ
  { f: 523.25, beats: 1 }, // ド
  { f: 659.25, beats: 2 }, // ミー
  { f: 587.33, beats: 1 }, // レ
  { f: 659.25, beats: 1 }, // ミ
  { f: 698.46, beats: 1 }, // ファ
  { f: 587.33, beats: 1 }, // レ
  { f: 523.25, beats: 2 }, // ドー
  { f: 0, beats: 2 }, // 休符
];
const BGM_BEAT = 0.34; // 1 拍の秒数
const BGM_GAIN = 0.05; // 控えめ

let bgmWanted = false; // BGM を鳴らしたい画面か
let bgmTimer: number | null = null;
let bgmNextTime = 0; // 次に予約すべきノートの ctx 時刻
let bgmIndex = 0;
let bgmGestureBound = false;

/** BGM を開始（初期画面用）。suspended なら初回タップで鳴らし直す */
export function startBgm() {
  bgmWanted = true;
  if (muted) return;
  const ctx = getAudio();
  if (!ctx) return;

  if (ctx.state === "suspended") {
    // ユーザー操作前。一度きりのジェスチャで resume して開始する
    if (!bgmGestureBound) {
      bgmGestureBound = true;
      const onGesture = () => {
        document.removeEventListener("pointerdown", onGesture);
        bgmGestureBound = false;
        if (bgmWanted && !muted) startBgm();
      };
      document.addEventListener("pointerdown", onGesture, { once: true });
    }
    return;
  }

  if (bgmTimer !== null) return; // 既に再生中
  bgmIndex = 0;
  bgmNextTime = ctx.currentTime + 0.1;
  bgmTimer = window.setInterval(bgmSchedule, 60);
  bgmSchedule();
}

/** lookahead スケジューラ: 先の 0.5 秒分までノートを予約する */
function bgmSchedule() {
  const ctx = audioCtx;
  if (!ctx || muted) return;
  while (bgmNextTime < ctx.currentTime + 0.5) {
    const note = BGM_NOTES[bgmIndex];
    const dur = note.beats * BGM_BEAT;
    if (note.f > 0) {
      tone(ctx, note.f, bgmNextTime - ctx.currentTime, dur * 0.9, BGM_GAIN);
    }
    bgmNextTime += dur;
    bgmIndex = (bgmIndex + 1) % BGM_NOTES.length;
  }
}

export function stopBgm() {
  bgmWanted = false;
  if (bgmTimer !== null) {
    clearInterval(bgmTimer);
    bgmTimer = null;
  }
}

// ---------------------------------------------------------------- 継続ブラシ音

// ストローク中に鳴っている音源（消しゴム=ノイズ源、塗り=オシレータ群）
let brushNodes: AudioScheduledSourceNode[] = [];
let brushGain: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;

function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
  const len = ctx.sampleRate * 1.0; // 1 秒分のホワイトノイズをループ
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buf;
  return buf;
}

/** ドラッグ中ずっと鳴る継続音。消しゴムのカサカサ音のみ。
 *  塗り（色を塗っている時）は音を鳴らさない。 */
export function startBrush(mode: PaintMode) {
  if (muted) return;
  if (mode !== "erase") return; // 塗り音は無し
  const ctx = getAudio();
  if (!ctx || ctx.state === "suspended") return;
  stopBrush(); // 二重再生防止

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.connect(ctx.destination);

  // 消しゴム: バンドパスノイズの「カサカサ」
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuffer(ctx);
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 900;
  filter.Q.value = 0.8;
  src.connect(filter).connect(gain);
  src.start();
  gain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 0.04);
  brushNodes = [src];

  brushGain = gain;
}

export function stopBrush() {
  if (brushNodes.length === 0 || !brushGain) return;
  const ctx = audioCtx;
  const nodes = brushNodes;
  const gain = brushGain;
  brushNodes = [];
  brushGain = null;
  if (ctx) {
    // 短くフェードアウトしてブチッと切れないようにする
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.05);
    for (const n of nodes) {
      try {
        n.stop(ctx.currentTime + 0.06);
      } catch {
        // 既に停止済みでも問題ない
      }
    }
  } else {
    for (const n of nodes) {
      try {
        n.stop();
      } catch {
        // noop
      }
    }
  }
}

// ---------------------------------------------------------------- 消音ボタン

/** 各画面のトップバーに置ける音オン/オフボタンを生成する。
 *  画面ごとに 1 つだけ生成される想定なので、自分のアイコンだけ同期する。 */
export function makeMuteButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "nav-btn mute-btn";
  const render = () => {
    btn.textContent = muted ? "🔇" : "🔊";
    btn.title = muted ? "おとを だす" : "おとを けす";
  };
  render();
  btn.addEventListener("click", () => {
    toggleMute();
    render();
    // ミュート解除の合図に軽い音（ミュート化は無音）
    if (!muted) blip(600);
  });
  return btn;
}
