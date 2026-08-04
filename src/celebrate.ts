// 完成演出: 紙吹雪 + WebAudio 合成のファンファーレ（音声ファイル不要）
// 音声プリミティブ（getAudio / tone / blip）は audio.ts に集約している。

import { getAudio, tone, isMuted } from "./audio";
export { blip } from "./audio";

export function fanfare() {
  if (isMuted()) return;
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

    let done = false;
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(safety);
      canvas.remove();
      resolve();
    }
    // メインスレッドが長時間ブロックされたりタブが裏に回ったりすると rAF が来ないので、
    // 「経過フレーム時間」の積み上げが止まったまま Promise が解決しないことがある。
    // その場合でも実時間の上限で必ず片付ける
    const safety = setTimeout(finish, durationMs * 4);

    let last = performance.now();
    let elapsed = 0;
    function frame(now: number) {
      if (done) return;
      // 直前のフレームが極端に離れていても（ブロック明け・タブ復帰など）紙吹雪の
      // 見た目の進み方には反映しない。1 フレーム分として丸めておく
      const dt = Math.min(now - last, 50);
      last = now;
      elapsed += dt;
      const scale = dt / 16.7; // 60fps 基準の移動量にそろえる（120Hz などで速くなりすぎないように）
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of parts) {
        p.x += p.vx * scale;
        p.y += p.vy * scale;
        p.rot += p.vrot * scale;
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
        finish();
      }
    }
    requestAnimationFrame(frame);
  });
}

export async function celebrate(): Promise<void> {
  fanfare();
  await confetti();
}
