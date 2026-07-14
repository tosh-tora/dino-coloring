// ブラシエンジン: 2 レイヤーのうち「塗りレイヤー」への描画を担当する。
// 線画レイヤーは別 canvas を前面に重ねるので、ここでは一切触らない。

export type PaintMode = "normal" | "mix" | "erase";

const UNDO_DEPTH = 12;

export class PaintEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** ストローク中の一時バッファ。ストローク全体を毎フレーム描き直すことで
   *  multiply / 低アルファ時のセグメント継ぎ目の濃さムラを防ぐ。 */
  private strokeBuf: HTMLCanvasElement;
  private strokeCtx: CanvasRenderingContext2D;
  /** ストローク開始時点のスナップショット（= undo 1 段分） */
  private preStroke: HTMLCanvasElement | null = null;
  private undoStack: HTMLCanvasElement[] = [];

  private color = "#e74c3c";
  private size = 26;
  private mode: PaintMode = "normal";

  private activePointer: number | null = null;
  private points: { x: number; y: number }[] = [];

  onStrokeEnd: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.strokeBuf = document.createElement("canvas");
    this.strokeBuf.width = canvas.width;
    this.strokeBuf.height = canvas.height;
    this.strokeCtx = this.strokeBuf.getContext("2d")!;

    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointercancel", this.onUp);
  }

  setColor(color: string) {
    this.color = color;
    if (this.mode === "erase") this.mode = "normal";
  }
  setSize(size: number) {
    this.size = size;
  }
  setMode(mode: PaintMode) {
    this.mode = mode;
  }
  getMode(): PaintMode {
    return this.mode;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  private toCanvasPos(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * this.canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * this.canvas.height) / rect.height,
    };
  }

  private onDown = (e: PointerEvent) => {
    // 2 本目以降の指は無視（簡易パーム対策）
    if (this.activePointer !== null) return;
    this.activePointer = e.pointerId;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // capture できなくても描画は続行できる
    }

    const snap = document.createElement("canvas");
    snap.width = this.canvas.width;
    snap.height = this.canvas.height;
    snap.getContext("2d")!.drawImage(this.canvas, 0, 0);
    this.preStroke = snap;

    this.points = [this.toCanvasPos(e)];
    this.renderStroke();
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerId !== this.activePointer) return;
    const events = "getCoalescedEvents" in e ? e.getCoalescedEvents() : [e];
    for (const ev of events) this.points.push(this.toCanvasPos(ev));
    this.renderStroke();
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    if (this.preStroke) {
      this.pushUndo(this.preStroke);
      this.preStroke = null;
    }
    this.points = [];
    this.onStrokeEnd?.();
  };

  private pushUndo(snap: HTMLCanvasElement) {
    this.undoStack.push(snap);
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
  }

  /** points をストロークバッファに不透明で描き、preStroke + モード合成で本 canvas に反映 */
  private renderStroke() {
    const s = this.strokeCtx;
    s.clearRect(0, 0, this.strokeBuf.width, this.strokeBuf.height);
    s.lineCap = "round";
    s.lineJoin = "round";
    s.lineWidth = this.size;
    // 消しゴムは destination-out で合成するので色は何でもよい
    s.strokeStyle = this.mode === "erase" ? "#000" : this.color;
    s.fillStyle = s.strokeStyle;

    const pts = this.points;
    if (pts.length === 0) return;
    if (pts.length < 3) {
      s.beginPath();
      s.arc(pts[0].x, pts[0].y, this.size / 2, 0, Math.PI * 2);
      s.fill();
    } else {
      s.beginPath();
      s.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        s.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      s.stroke();
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.preStroke) ctx.drawImage(this.preStroke, 0, 0);
    ctx.globalCompositeOperation =
      this.mode === "erase" ? "destination-out" : this.mode === "mix" ? "multiply" : "source-over";
    ctx.drawImage(this.strokeBuf, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }

  undo() {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(snap, 0, 0);
    this.onStrokeEnd?.();
  }

  /** 全消し。undo で戻れるように現状態をスタックに積んでから消す */
  clearAll() {
    const snap = document.createElement("canvas");
    snap.width = this.canvas.width;
    snap.height = this.canvas.height;
    snap.getContext("2d")!.drawImage(this.canvas, 0, 0);
    this.pushUndo(snap);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.onStrokeEnd?.();
  }

  /** 保存済みの塗りを復元する */
  loadDataUrl(dataUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
        resolve();
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  toDataUrl(): string {
    return this.canvas.toDataURL("image/png");
  }
}
