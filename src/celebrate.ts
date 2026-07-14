// 完成演出: 紙吹雪 + WebAudio 合成のファンファーレ（音声ファイル不要）

let audioCtx: AudioContext | null = null;

function getAudio(): AudioContext | null {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

function tone(ctx: AudioContext, freq: number, start: number, dur: number, gainMax = 0.18) {
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
  const ctx = getAudio();
  if (!ctx) return;
  tone(ctx, freq, 0, 0.12, 0.1);
}

export function fanfare() {
  const ctx = getAudio();
  if (!ctx) return;
  // C-E-G-C のアルペジオ + 和音
  tone(ctx, 523.25, 0.0, 0.25);
  tone(ctx, 659.25, 0.15, 0.25);
  tone(ctx, 783.99, 0.3, 0.25);
  tone(ctx, 1046.5, 0.45, 0.6);
  tone(ctx, 523.25, 0.45, 0.6, 0.08);
  tone(ctx, 659.25, 0.45, 0.6, 0.08);
}

const CONFETTI_COLORS = ["#e74c3c", "#f39c12", "#f7d51d", "#2ecc71", "#5bc8f5", "#9b59b6", "#f78fb3"];

/** 全画面紙吹雪。durationMs 後に自動で片付ける */
export function confetti(durationMs = 2600): Promise<void> {
  return new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.className = "confetti-overlay";
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d")!;

    interface P {
      x: number; y: number; vx: number; vy: number;
      size: number; color: string; rot: number; vrot: number;
    }
    const parts: P[] = [];
    for (let i = 0; i < 140; i++) {
      parts.push({
        x: Math.random() * canvas.width,
        y: -20 - Math.random() * canvas.height * 0.5,
        vx: (Math.random() - 0.5) * 2.5,
        vy: 2.5 + Math.random() * 3.5,
        size: 8 + Math.random() * 10,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        rot: Math.random() * Math.PI,
        vrot: (Math.random() - 0.5) * 0.25,
      });
    }

    const start = performance.now();
    function frame(now: number) {
      const elapsed = now - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of parts) {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vrot;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      }
      if (elapsed < durationMs) {
        requestAnimationFrame(frame);
      } else {
        canvas.remove();
        resolve();
      }
    }
    requestAnimationFrame(frame);
  });
}

export async function celebrate(): Promise<void> {
  fanfare();
  await confetti();
}
