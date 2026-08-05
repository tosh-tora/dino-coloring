// 完成したぬりえの主役を動かす画面。
//
// 最初は完成した絵をそのまま見せ、「うごかす」を押すと、背景（＝主役を抜いた完成画像）の
// 上で切り抜いた生き物が跳ね始める。動いている間にタップするとジャンプして吠える。
// 勝手に動き出さないのは、まず自分の作品をそのまま眺められるようにするため。
//
// 左右へ歩かせないのは、下絵がどちら向きに描かれているか判定できず、
// 反転すると後ろ歩きに見えてしまうため。その場で動くぶんには向きの問題が起きない。

import { CANVAS_W, CANVAS_H, type LineArt } from "./lineart";
import { roar, screech, splash, blip } from "./audio";
import type { Subject } from "./subject";

/** 動きの種類。はねる（既定）/ およぐ / とぶ */
export type MotionKind = "hop" | "swim" | "fly";

interface MotionParams {
  /** 1 秒あたりの往復回数 */
  rate: number;
  /** 上下に動く幅（キャンバス座標） */
  lift: number;
  /** 左右にゆれる幅 */
  sway: number;
  /** 着地時にどれだけ潰れるか（はねる時だけ） */
  squash: number;
  /** かたむく角度 (rad) */
  tilt: number;
  /** 羽ばたきに見せる横の縮み（0 = なし） */
  flap: number;
  /** タップされたときの鳴き声 */
  cry: (pitch: number) => void;
}

/**
 * 種類ごとの動きかた。はねる (hop) の数値はこの表に畳む前と同じで、
 * 動きを増やしても従来の見た目が変わらないようにしてある。
 */
const MOTION: Record<MotionKind, MotionParams> = {
  hop: { rate: 1.1, lift: 46, sway: 14, squash: 0.12, tilt: 0, flap: 0, cry: roar },
  swim: { rate: 0.45, lift: 18, sway: 26, squash: 0, tilt: 0.06, flap: 0, cry: splash },
  fly: { rate: 0.7, lift: 40, sway: 34, squash: 0, tilt: 0.1, flap: 0.06, cry: screech },
};

/** 羽ばたきの速さ (Hz)。跳ねる周期とは独立に速く動かす */
const FLAP_PER_SEC = 2.5;

// 「とぶ / およぐ」は絵そのものの性質なので、大人が変えられる分類より下絵の id を先に見る。
// ここに無い下絵（アップロード画像を含む）は、これまで通り はねる。
const FLY_IDS = new Set([
  "butterfly",
  "rocket",
  "shared-pteranodon",
  "shared-pteranodon-flying",
  "shared-quetzalcoatlus",
  "shared-quetzalcoatlus-titled",
  "shared-hornet",
]);

// みずのなかのいきもの (cat-sea) はカテゴリーで拾えるが、メガロドンなどは
// ぜつめつどうぶつに分類されているので id で挙げる
const SWIM_IDS = new Set([
  "fish",
  "shared-megalodon",
  "shared-megalodon-simple",
]);

/** 下絵から動きの種類を決める。category は大人の上書き後のものを渡してよい */
export function motionOf(art: LineArt, category?: string | null): MotionKind {
  if (FLY_IDS.has(art.id)) return "fly";
  if (SWIM_IDS.has(art.id)) return "swim";
  if ((category ?? art.category) === "cat-sea") return "swim";
  return "hop";
}

interface Actor {
  subject: Subject;
  /** 変形の支点。はねる時は足もと、およぐ/とぶ時はシルエットの中心 */
  pivotX: number;
  pivotY: number;
  /** 動きの位相。複数体がそろって動かないようずらす */
  phase: number;
  /** 鳴いている残り時間 (s) */
  roarLeft: number;
  /** 鳴き声の音程。大きい生き物ほど低い */
  pitch: number;
}

export interface PlayOptions {
  /**
   * 「もっとぬる」を押したときの続き。渡したときだけボタンが出る。
   * この画面を閉じてから呼ばれるので、そのまま次の画面へ進んでよい。
   */
  onMore?: () => void;
  /** 動きの種類。省略時は はねる */
  motion?: MotionKind;
}

export function playSubjects(
  finished: CanvasImageSource,
  subjects: Subject[] | Promise<Subject[]>,
  opts: PlayOptions = {}
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
    // 主役を切り出せるか分かるまでは隠す（切り抜きの完了を待たずに絵を先に見せるため）
    playBtn.hidden = true;

    const closeBtn = document.createElement("button");
    closeBtn.className = "nav-btn subject-close";
    closeBtn.textContent = "✅ おしまい";

    const buttons = document.createElement("div");
    buttons.className = "subject-buttons";
    buttons.append(playBtn);
    const onMore = opts.onMore;
    if (onMore) {
      const moreBtn = document.createElement("button");
      moreBtn.className = "nav-btn subject-more-btn";
      moreBtn.textContent = "🖍️ もっとぬる";
      moreBtn.addEventListener("click", () => {
        blip(700);
        close();
        onMore();
      });
      buttons.appendChild(moreBtn);
    }
    buttons.append(closeBtn);

    const hint = document.createElement("p");
    hint.className = "subject-hint";

    overlay.append(stage, hint, buttons);
    document.body.appendChild(overlay);

    const ctx = canvas.getContext("2d")!;

    /** 止まっている間は完成した絵をそのまま見せる（切り抜きの継ぎ目も出ない） */
    function drawStill() {
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.drawImage(finished, 0, 0, CANVAS_W, CANVAS_H);
    }
    // 切り抜き（主役の判定）が終わるのを待たず、まず完成した絵をそのまま見せる
    drawStill();

    const m = MOTION[opts.motion ?? "hop"];

    let raf = 0;
    let running = false;
    let start = 0;
    let prev = 0;
    let actors: Actor[] = [];
    // 主役を抜いた背景（切り抜きが終わるまでは無い）
    let bg: HTMLCanvasElement | null = null;
    let closed = false;

    /** この画面を片付けて呼び出し元へ返す */
    function close() {
      closed = true;
      cancelAnimationFrame(raf);
      overlay.remove();
      resolve();
    }

    /** その時刻での見た目の位置・拡大率・かたむき */
    function poseOf(a: Actor, t: number) {
      const cycle = t * m.rate + a.phase;
      const sway = Math.sin(cycle * Math.PI * 0.5) * m.sway;
      // 鳴いている間の反応（0→1→0）。ポーズへの効かせ方は動きの種類で変える
      const react = a.roarLeft > 0 ? Math.sin((1 - a.roarLeft / 0.6) * Math.PI) : 0;

      if (m.squash > 0) {
        // はねる: 0（着地）〜1（頂点）。着地しているときほど縦に潰れ、そのぶん横に広がる
        const hop = Math.abs(Math.sin(cycle * Math.PI));
        const sy = 1 - m.squash * (1 - hop) + 0.12 * react;
        return { dx: sway, dy: -hop * m.lift, sx: 1 / sy, sy, rot: 0 };
      }

      // およぐ / とぶ: 上下と左右で位相をずらし、その場で 8 の字を描くように漂わせる
      const dy = Math.sin(cycle * Math.PI * 2) * m.lift;
      // 進む向き（左右の速度）に合わせてかたむける
      const rot = Math.cos(cycle * Math.PI * 0.5) * m.tilt;
      // 羽ばたきは横に縮めて表す（シルエットは 1 枚きりなので翼を動かせない）
      const flap = m.flap * Math.abs(Math.sin(t * FLAP_PER_SEC * Math.PI));
      const scale = 1 + 0.1 * react;
      return { dx: sway, dy, sx: (1 - flap) * scale, sy: scale, rot };
    }

    function frame(now: number) {
      const t = (now - start) / 1000;
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;

      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.drawImage(bg!, 0, 0);

      for (const a of actors) {
        if (a.roarLeft > 0) a.roarLeft = Math.max(0, a.roarLeft - dt);
        const p = poseOf(a, t);
        ctx.save();
        ctx.translate(a.pivotX + p.dx, a.pivotY + p.dy);
        ctx.rotate(p.rot);
        ctx.scale(p.sx, p.sy);
        ctx.drawImage(a.subject.canvas, -a.pivotX, -a.pivotY);
        ctx.restore();
      }
      raf = requestAnimationFrame(frame);
    }

    function setRunning(on: boolean) {
      running = on;
      playBtn.textContent = on ? "✋ とめる" : "🦕 うごかす！";
      // 止まっている間は何も出さない（ボタンを見れば分かる）
      // さかな・虫でも通る言い方にする（動きの種類ごとに書き分けるほどの中身は無い）
      hint.textContent = on ? "タップしてみよう！" : "";
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

    // 切り抜き（主役の判定）は数百 ms かかることがあるので、待たずに絵を先に見せておき、
    // 終わり次第「動かせる」と分かった作品だけボタンを出す
    Promise.resolve(subjects).then((list) => {
      if (closed) return;
      actors = list.map((s, i) => ({
        subject: s,
        pivotX: s.x + s.w / 2,
        pivotY: m.squash > 0 ? s.y + s.h : s.y + s.h / 2,
        phase: i * 0.5,
        roarLeft: 0,
        // 画面いっぱいの恐竜 (h/CANVAS_H≒0.9) で 0.75、小さな虫 (≒0.2) で 1.3 あたり
        pitch: Math.min(1.35, Math.max(0.72, 1.45 - 0.78 * (s.h / CANVAS_H))),
      }));
      // 主役を切り出せなかった作品では動かしようがないので、ボタンを出さずに
      // 「作品を大きく見る画面」のままにする
      if (actors.length === 0) return;

      // 主役を抜いた背景を一度だけ作る（毎フレーム合成すると重い）
      bg = document.createElement("canvas");
      bg.width = CANVAS_W;
      bg.height = CANVAS_H;
      const bgCtx = bg.getContext("2d")!;
      bgCtx.drawImage(finished, 0, 0, CANVAS_W, CANVAS_H);
      // 主役のいた場所をくり抜いて、空いた穴を紙の白で埋める
      bgCtx.globalCompositeOperation = "destination-out";
      for (const s of list) bgCtx.drawImage(s.canvas, 0, 0);
      bgCtx.globalCompositeOperation = "destination-over";
      bgCtx.fillStyle = "#ffffff";
      bgCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);

      playBtn.hidden = false;
      playBtn.addEventListener("click", () => {
        blip(running ? 420 : 780);
        setRunning(!running);
      });
    });

    canvas.addEventListener("pointerdown", (e) => {
      if (!running) return;
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
      const y = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
      const t = (performance.now() - start) / 1000;

      for (const a of actors) {
        const p = poseOf(a, t);
        const s = a.subject;
        // いま描かれている位置での当たり判定（外接矩形で十分）。かたむきは最大 0.1rad
        // （約 6°）で、矩形とのずれは指のタップ精度より小さいので回転は見ない
        const left = a.pivotX + p.dx + (s.x - a.pivotX) * p.sx;
        const top = a.pivotY + p.dy + (s.y - a.pivotY) * p.sy;
        if (x >= left && x <= left + s.w * p.sx && y >= top && y <= top + s.h * p.sy) {
          a.roarLeft = 0.6;
          m.cry(a.pitch);
          return;
        }
      }
    });

    closeBtn.addEventListener("click", () => {
      blip(420);
      close();
    });
  });
}
