// 完成したぬりえの主役を動かす画面。
//
// 最初は完成した絵をそのまま見せ、「うごかす」を押すと、背景（＝主役を抜いた完成画像）の
// 上で切り抜いた生き物が跳ね始める。動いている間にタップするとジャンプして吠える。
// 勝手に動き出さないのは、まず自分の作品をそのまま眺められるようにするため。
//
// 左右へ歩かせないのは、下絵がどちら向きに描かれているか判定できず、
// 反転すると後ろ歩きに見えてしまうため。その場で跳ねるぶんには向きの問題が起きない。

import { CANVAS_W, CANVAS_H } from "./lineart";
import { roar, blip } from "./audio";
import type { Subject } from "./subject";

/** 1 秒あたりの跳ねる回数 */
const HOPS_PER_SEC = 1.1;
/** 跳ねる高さ（キャンバス座標） */
const HOP_HEIGHT = 46;
/** 着地時にどれだけ潰れるか */
const SQUASH = 0.12;
/** 左右にゆれる幅 */
const SWAY = 14;

interface Actor {
  subject: Subject;
  /** 足元中央（変形の支点） */
  pivotX: number;
  pivotY: number;
  /** 跳ねる位相。複数体がそろって跳ねないようずらす */
  phase: number;
  /** 吠えている残り時間 (s) */
  roarLeft: number;
}

export function playSubjects(
  finished: CanvasImageSource,
  subjects: Subject[]
): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "subject-play";

    const stage = document.createElement("div");
    stage.className = "subject-stage";
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    stage.appendChild(canvas);

    const playBtn = document.createElement("button");
    playBtn.className = "nav-btn subject-play-btn";
    playBtn.textContent = "🦕 うごかす！";

    const closeBtn = document.createElement("button");
    closeBtn.className = "nav-btn subject-close";
    closeBtn.textContent = "✅ おしまい";

    const buttons = document.createElement("div");
    buttons.className = "subject-buttons";
    buttons.append(playBtn, closeBtn);

    const hint = document.createElement("p");
    hint.className = "subject-hint";

    overlay.append(stage, hint, buttons);
    document.body.appendChild(overlay);

    const ctx = canvas.getContext("2d")!;

    // 主役を抜いた背景を一度だけ作る（毎フレーム合成すると重い）
    const bg = document.createElement("canvas");
    bg.width = CANVAS_W;
    bg.height = CANVAS_H;
    const bgCtx = bg.getContext("2d")!;
    bgCtx.drawImage(finished, 0, 0, CANVAS_W, CANVAS_H);
    // 主役のいた場所をくり抜いて、空いた穴を紙の白で埋める
    bgCtx.globalCompositeOperation = "destination-out";
    for (const s of subjects) bgCtx.drawImage(s.canvas, 0, 0);
    bgCtx.globalCompositeOperation = "destination-over";
    bgCtx.fillStyle = "#ffffff";
    bgCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    const actors: Actor[] = subjects.map((s, i) => ({
      subject: s,
      pivotX: s.x + s.w / 2,
      pivotY: s.y + s.h,
      phase: i * 0.5,
      roarLeft: 0,
    }));

    let raf = 0;
    let running = false;
    let start = 0;
    let prev = 0;

    /** その時刻での見た目の位置と拡大率 */
    function poseOf(a: Actor, t: number) {
      const cycle = t * HOPS_PER_SEC + a.phase;
      // 0（着地）〜1（頂点）
      const hop = Math.abs(Math.sin(cycle * Math.PI));
      const lift = hop * HOP_HEIGHT;
      const sway = Math.sin(cycle * Math.PI * 0.5) * SWAY;
      // 着地しているときほど縦に潰れ、そのぶん横に広がる
      let sy = 1 - SQUASH * (1 - hop);
      if (a.roarLeft > 0) sy += 0.12 * Math.sin((1 - a.roarLeft / 0.6) * Math.PI);
      return { dx: sway, dy: -lift, sx: 1 / sy, sy };
    }

    function frame(now: number) {
      const t = (now - start) / 1000;
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;

      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.drawImage(bg, 0, 0);

      for (const a of actors) {
        if (a.roarLeft > 0) a.roarLeft = Math.max(0, a.roarLeft - dt);
        const p = poseOf(a, t);
        ctx.save();
        ctx.translate(a.pivotX + p.dx, a.pivotY + p.dy);
        ctx.scale(p.sx, p.sy);
        ctx.drawImage(a.subject.canvas, -a.pivotX, -a.pivotY);
        ctx.restore();
      }
      raf = requestAnimationFrame(frame);
    }

    /** 止まっている間は完成した絵をそのまま見せる（切り抜きの継ぎ目も出ない） */
    function drawStill() {
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.drawImage(finished, 0, 0, CANVAS_W, CANVAS_H);
    }

    function setRunning(on: boolean) {
      running = on;
      playBtn.textContent = on ? "✋ とめる" : "🦕 うごかす！";
      hint.textContent = on ? "きょうりゅうを タップしてみよう！" : "ボタンを おすと うごくよ";
      if (on) {
        start = performance.now();
        prev = start;
        for (const a of actors) a.roarLeft = 0;
        raf = requestAnimationFrame(frame);
      } else {
        cancelAnimationFrame(raf);
        drawStill();
      }
    }

    // 主役を切り出せなかった作品では動かしようがないので、ボタンを出さずに
    // 「作品を大きく見る画面」として使う
    if (actors.length === 0) {
      playBtn.remove();
      hint.textContent = "";
      drawStill();
    } else {
      setRunning(false);
      playBtn.addEventListener("click", () => {
        blip(running ? 420 : 780);
        setRunning(!running);
      });
    }

    canvas.addEventListener("pointerdown", (e) => {
      if (!running) return;
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
      const y = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
      const t = (performance.now() - start) / 1000;

      for (const a of actors) {
        const p = poseOf(a, t);
        const s = a.subject;
        // いま描かれている位置での当たり判定（外接矩形で十分）
        const left = a.pivotX + p.dx + (s.x - a.pivotX) * p.sx;
        const top = a.pivotY + p.dy + (s.y - a.pivotY) * p.sy;
        if (x >= left && x <= left + s.w * p.sx && y >= top && y <= top + s.h * p.sy) {
          a.roarLeft = 0.6;
          roar();
          return;
        }
      }
    });

    closeBtn.addEventListener("click", () => {
      blip(420);
      cancelAnimationFrame(raf);
      overlay.remove();
      resolve();
    });
  });
}
