// ブラシエンジン: 2 レイヤーのうち「塗りレイヤー」への描画を担当する。
// 線画レイヤーは別 canvas を前面に重ねるので、ここでは一切触らない。

export type PaintMode = "normal" | "mix" | "erase";

const UNDO_DEPTH = 12;

/** まぜまぜ（水彩）で新しい色が占める割合。0.5 = 下の色と半々に混ざる */
const MIX_RATIO = 0.5;

// ---- はみだしガード ----
/** この alpha 以上の線画ピクセルを「線」（塗りの障壁）とみなす */
const LINE_ALPHA = 48;
/** 線の内側へ塗り込みを許す深さ (px)。線と塗りの間に白い隙間ができるのを防ぐ */
const LINE_OVERLAP = 20;
/** ストローク開始点が線の上だったとき、近くの空きピクセルを探す半径 (px) */
const SEED_SEARCH = 24;

/** バケツで塗ってからこの時間内に cancelStroke() が来たら、その 1 発を取り消す (ms)。
 *  ピンチの 1 本目の指が置かれた瞬間に塗りつぶしが起きてしまうため */
const FILL_UNDO_GRACE = 400;

export class PaintEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** ストローク中の一時バッファ。ストローク全体を毎フレーム描き直すことで
   *  まぜまぜ / 低アルファ時のセグメント継ぎ目の濃さムラを防ぐ。
   *  （1 ストロークが自分自身と重なっても、混色は一度しか起きない） */
  private strokeBuf: HTMLCanvasElement;
  private strokeCtx: CanvasRenderingContext2D;
  /** ストローク開始時点のスナップショット（= undo 1 段分） */
  private preStroke: HTMLCanvasElement | null = null;
  private undoStack: HTMLCanvasElement[] = [];

  private color = "#e74c3c";
  private size = 26;
  private mode: PaintMode = "normal";
  /** バケツ（ぬりつぶし）ツールが有効か。mode とは独立の軸で、
   *  消しゴムと組み合わせると「領域まるごと消し」になる */
  private fillTool = false;

  private activePointer: number | null = null;
  private points: { x: number; y: number }[] = [];
  /** ピンチ操作中は塗らない。activePointer を消すだけだと、ピンチ中に指を 1 本残したまま
   *  動かしたときに新しいストロークが始まってしまうので、全部の指が離れるまで止める */
  private suspended = false;
  /** バケツで最後に塗りつぶした時刻。ピンチ開始時にその 1 発を取り消すために見る */
  private lastFillAt = 0;

  // はみだしガード: 線画から作る障壁マップと、ストローク中の塗り許可マスク
  /** 1 = 線 (障壁)。setLineart で線画レイヤーから作る */
  private barrier: Uint8Array | null = null;
  /** 線を越えて塗るのに必要なドラッグ距離 (px)。0 = ガードなし */
  private guardThreshold = 0;
  /** ストローク中の塗り許可マスク (1 = 塗ってよい)。いまいる領域だけを表し、
   *  閾値を超えて別領域へ抜けると作り直される。null = このストロークはガードなし */
  private mask: Uint8Array | null = null;
  /** mask と同内容の alpha 画像。destination-in でストロークをクリップするのに使う */
  private maskData: ImageData | null = null;
  private maskCanvas: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D;
  private maskBuf: Uint8Array | null = null;
  private floodQueue: Int32Array | null = null;
  /** 最後にマスク内にいた位置。ここからの距離が閾値を超えたら領域を切り替える */
  private lastInside: { x: number; y: number } | null = null;
  /** 領域を切り替えるとき、旧領域ぶんの描画を確定させておくバッファ。
   *  これにより越えた先で塗った分を残したまま、マスクをいまの領域だけに戻せる */
  private strokeAccum: HTMLCanvasElement;
  private accumCtx: CanvasRenderingContext2D;
  private hasAccum = false;

  onStrokeStart: (() => void) | null = null;
  onStrokeEnd: (() => void) | null = null;
  /** バケツで実際に塗りつぶせたときに呼ぶ（効果音は呼び元にまかせる） */
  onFill: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.strokeBuf = document.createElement("canvas");
    this.strokeBuf.width = canvas.width;
    this.strokeBuf.height = canvas.height;
    this.strokeCtx = this.strokeBuf.getContext("2d")!;
    this.maskCanvas = document.createElement("canvas");
    this.maskCanvas.width = canvas.width;
    this.maskCanvas.height = canvas.height;
    this.maskCtx = this.maskCanvas.getContext("2d")!;
    this.strokeAccum = document.createElement("canvas");
    this.strokeAccum.width = canvas.width;
    this.strokeAccum.height = canvas.height;
    this.accumCtx = this.strokeAccum.getContext("2d")!;

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
  /** バケツ（ぬりつぶし）ツールの ON/OFF */
  setFillTool(on: boolean) {
    this.fillTool = on;
  }
  /** 線画レイヤーを渡すと、はみだしガード用の障壁マップを作る（塗りと同サイズ前提） */
  setLineart(lineartCanvas: HTMLCanvasElement) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const data = lineartCanvas.getContext("2d")!.getImageData(0, 0, w, h).data;
    const barrier = new Uint8Array(w * h);
    for (let i = 0; i < barrier.length; i++) {
      if (data[i * 4 + 3] >= LINE_ALPHA) barrier[i] = 1;
    }
    this.barrier = barrier;
  }
  /** はみだしガードの閾値 (px)。0 でガードなし */
  setGuardThreshold(px: number) {
    this.guardThreshold = px;
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
    if (this.suspended) return; // ピンチ中
    // 2 本目以降の指は無視（簡易パーム対策）
    if (this.activePointer !== null) return;

    // バケツ: タップした瞬間に閉領域を塗りつぶす。ストローク状態は一切持たない
    if (this.fillTool) {
      if (!this.fillRegion(this.toCanvasPos(e))) return;
      this.onFill?.();
      this.onStrokeEnd?.();
      return;
    }

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

    const pos = this.toCanvasPos(e);
    this.points = [pos];
    this.accumCtx.clearRect(0, 0, this.strokeAccum.width, this.strokeAccum.height);
    this.hasAccum = false;
    this.beginMask(pos);
    this.renderStroke();
    this.onStrokeStart?.();
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerId !== this.activePointer) return;
    const events = "getCoalescedEvents" in e ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const pos = this.toCanvasPos(ev);
      this.points.push(pos);
      this.guardPoint(pos);
    }
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
    this.mask = null;
    this.lastInside = null;
    this.onStrokeEnd?.();
  };

  // ---------------------------------------------------------------- pinch

  /** ピンチが始まったときに呼ぶ。2 本目の指が触れる前に 1 本目が引いてしまった線を
   *  なかったことにして、指が全部離れるまで塗りを止める（→ resumeStrokes）。 */
  cancelStroke() {
    this.suspended = true;

    if (this.activePointer !== null) {
      try {
        this.canvas.releasePointerCapture(this.activePointer);
      } catch {
        // capture が外れていても状態のリセットは続ける
      }
      this.activePointer = null;
      // ストローク開始時のスナップショットに戻す（undo は積まない = 取り消しではなく無かったこと）
      if (this.preStroke) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(this.preStroke, 0, 0);
        this.preStroke = null;
      }
      this.points = [];
      this.mask = null;
      this.lastInside = null;
      this.hasAccum = false;
      this.onStrokeEnd?.(); // 塗り音を止め、ツールバーを更新する
      return;
    }

    // バケツは触れた瞬間に塗り終わっているので、ストロークのように巻き戻せない。
    // 直前の 1 発だけ undo で戻す
    if (this.fillTool && Date.now() - this.lastFillAt < FILL_UNDO_GRACE) {
      this.lastFillAt = 0;
      this.undo();
    }
  }

  /** 指がすべて離れたら塗りを再開する */
  resumeStrokes() {
    this.suspended = false;
  }

  // ---------------------------------------------------------------- guard

  /** pos を含む閉領域をフラッドフィルして mask / maskCanvas を作る。
   *  作れたら seed の index、周囲がすべて線などで作れなければ -1 を返す。 */
  private buildRegionMask(pos: { x: number; y: number }): number {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const seed = this.findFreeSeed(Math.round(pos.x), Math.round(pos.y));
    if (seed < 0) return -1;
    if (!this.maskBuf) this.maskBuf = new Uint8Array(w * h);
    else this.maskBuf.fill(0);
    if (!this.maskData) this.maskData = this.maskCtx.createImageData(w, h);
    else this.maskData.data.fill(0);
    this.mask = this.maskBuf;
    this.flood(seed);
    this.maskCtx.putImageData(this.maskData, 0, 0);
    return seed;
  }

  /** ストローク開始: 開始位置を含む閉領域をフラッドフィルして塗り許可マスクにする */
  private beginMask(pos: { x: number; y: number }) {
    this.mask = null;
    this.lastInside = null;
    if (this.guardThreshold <= 0 || !this.barrier || this.mode === "erase") return;
    const seed = this.buildRegionMask(pos);
    if (seed < 0) return; // 周囲がすべて線: このストロークはガードなしで塗る
    const w = this.canvas.width;
    this.lastInside = { x: seed % w, y: Math.floor(seed / w) };
  }

  /** バケツ: pos を含む閉領域を一発で塗りつぶす（消しゴム中なら一発で消す）。
   *  ガード設定とは無関係に、線画の barrier があるときだけ効く。 */
  private fillRegion(pos: { x: number; y: number }): boolean {
    if (!this.barrier) return false; // 線画が読めていない: 塗りつぶす境界がない
    if (this.buildRegionMask(pos) < 0) return false;
    this.mask = null; // ストローク用の状態としては持ち越さない

    const w = this.canvas.width;
    const h = this.canvas.height;

    // undo 用に現状態を退避
    const snap = document.createElement("canvas");
    snap.width = w;
    snap.height = h;
    snap.getContext("2d")!.drawImage(this.canvas, 0, 0);

    // 領域ぶんのベタ塗りを strokeBuf に作る
    const s = this.strokeCtx;
    s.clearRect(0, 0, this.strokeBuf.width, this.strokeBuf.height);
    s.fillStyle = this.mode === "erase" ? "#000" : this.color;
    s.fillRect(0, 0, w, h);
    s.globalCompositeOperation = "destination-in";
    s.drawImage(this.maskCanvas, 0, 0);
    s.globalCompositeOperation = "source-over";

    this.compositeStroke();

    this.pushUndo(snap);
    this.lastFillAt = Date.now();
    return true;
  }

  /** strokeBuf をいまのモードで本 canvas に合成する（なぞり描きとバケツで共通） */
  private compositeStroke() {
    const ctx = this.ctx;
    if (this.mode === "mix") {
      // 水彩の上塗り: 下の色と新しい色を MIX_RATIO で混ぜる。
      // 1) 半透明で重ねる = すでに色がある所は加重平均になる（白を塗れば白へ寄る）
      ctx.globalAlpha = MIX_RATIO;
      ctx.drawImage(this.strokeBuf, 0, 0);
      ctx.globalAlpha = 1;
      // 2) 同じ色を destination-over で裏に敷き、まだ塗っていない所だけ不透明に埋める
      //    （すでに不透明な所には効かないので 1) の混色はそのまま残る）
      ctx.globalCompositeOperation = "destination-over";
      ctx.drawImage(this.strokeBuf, 0, 0);
    } else {
      ctx.globalCompositeOperation = this.mode === "erase" ? "destination-out" : "source-over";
      ctx.drawImage(this.strokeBuf, 0, 0);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  /** ガード中の点を処理: マスク内なら基準点を更新。閾値を超えて別領域へ抜けたら
   *  マスクをその領域に切り替える。元の領域に戻るときも同じ扱いなので、戻れば
   *  またガードが効く。 */
  private guardPoint(pos: { x: number; y: number }) {
    if (!this.mask || !this.lastInside) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const x = Math.min(w - 1, Math.max(0, Math.round(pos.x)));
    const y = Math.min(h - 1, Math.max(0, Math.round(pos.y)));
    const idx = y * w + x;
    if (this.mask[idx]) {
      this.lastInside = { x, y };
      return;
    }
    const dx = x - this.lastInside.x;
    const dy = y - this.lastInside.y;
    if (dx * dx + dy * dy <= this.guardThreshold * this.guardThreshold) return;
    if (this.barrier![idx]) return; // まだ線の上。線を抜けるまでは切り替えない
    this.switchRegion(idx);
    this.lastInside = { x, y };
  }

  /** ここまでのセグメントを strokeAccum に確定させ、マスクを seed の領域に作り直す */
  private switchRegion(seed: number) {
    // いまのマスクに入っていた最後の点までが旧領域のセグメント
    let cut = this.points.length - 1;
    while (cut > 0 && !this.insideMask(this.points[cut])) cut--;
    const s = this.strokeCtx;
    s.clearRect(0, 0, this.strokeBuf.width, this.strokeBuf.height);
    this.drawPath(this.points.slice(0, cut + 1));
    s.globalCompositeOperation = "destination-in";
    s.drawImage(this.maskCanvas, 0, 0);
    s.globalCompositeOperation = "source-over";
    this.accumCtx.drawImage(this.strokeBuf, 0, 0);
    this.hasAccum = true;
    // 境界の点を共有して新セグメントを始める（線のところで描画がつながる）
    this.points = this.points.slice(cut);
    this.mask!.fill(0);
    this.maskData!.data.fill(0);
    this.flood(seed);
    this.maskCtx.putImageData(this.maskData!, 0, 0);
  }

  private insideMask(p: { x: number; y: number }): boolean {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const x = Math.min(w - 1, Math.max(0, Math.round(p.x)));
    const y = Math.min(h - 1, Math.max(0, Math.round(p.y)));
    return this.mask![y * w + x] === 1;
  }

  /** (x,y) の近くで線でないピクセルを探す。見つからなければ -1 */
  private findFreeSeed(x: number, y: number): number {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const barrier = this.barrier!;
    for (let r = 0; r <= SEED_SEARCH; r++) {
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue; // リングの外周のみ
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const idx = ny * w + nx;
          if (!barrier[idx]) return idx;
        }
      }
    }
    return -1;
  }

  /** seed（線でないピクセル）から 4 近傍フラッドフィルで mask / maskData を広げる。
   *  線ピクセルも深さ LINE_OVERLAP まで許可に含める（線の下まで塗って白い隙間を防ぐ）が、
   *  線を突き抜けた先の領域へは広がらない。 */
  private flood(seed: number) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const barrier = this.barrier!;
    const mask = this.mask!;
    const alpha = this.maskData!.data;
    if (!this.floodQueue) this.floodQueue = new Int32Array(w * h);
    const queue = this.floodQueue;
    let head = 0;
    let tail = 0;
    // queue の各要素は idx + depth * 0x100000（idx < 2^20, depth <= LINE_OVERLAP）
    const push = (idx: number, depth: number) => {
      mask[idx] = 1;
      alpha[idx * 4 + 3] = 255;
      queue[tail++] = idx + depth * 0x100000;
    };
    const step = (idx: number, depth: number) => {
      if (mask[idx]) return;
      if (barrier[idx]) {
        if (depth + 1 <= LINE_OVERLAP) push(idx, depth + 1);
      } else if (depth === 0) {
        push(idx, 0); // 線の中から線でないピクセルへは戻らない（隣の領域に漏れない）
      }
    };
    push(seed, 0);
    while (head < tail) {
      const v = queue[head++];
      const idx = v & 0xfffff;
      const depth = v >>> 20;
      const x = idx % w;
      if (x > 0) step(idx - 1, depth);
      if (x < w - 1) step(idx + 1, depth);
      if (idx >= w) step(idx - w, depth);
      if (idx < w * (h - 1)) step(idx + w, depth);
    }
  }

  private pushUndo(snap: HTMLCanvasElement) {
    this.undoStack.push(snap);
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
  }

  /** pts をストロークバッファに不透明で描く */
  private drawPath(pts: { x: number; y: number }[]) {
    const s = this.strokeCtx;
    s.lineCap = "round";
    s.lineJoin = "round";
    s.lineWidth = this.size;
    // 消しゴムは destination-out で合成するので色は何でもよい
    s.strokeStyle = this.mode === "erase" ? "#000" : this.color;
    s.fillStyle = s.strokeStyle;

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
  }

  /** points をストロークバッファに描き、preStroke + モード合成で本 canvas に反映 */
  private renderStroke() {
    const s = this.strokeCtx;
    s.clearRect(0, 0, this.strokeBuf.width, this.strokeBuf.height);
    this.drawPath(this.points);

    // はみだしガード: いまのセグメントを許可領域でクリップし、確定済みセグメントを重ねる。
    // どちらも不透明の同色なので、重なっても後段のモード合成で継ぎ目は出ない
    if (this.mask && this.mode !== "erase") {
      s.globalCompositeOperation = "destination-in";
      s.drawImage(this.maskCanvas, 0, 0);
      s.globalCompositeOperation = "source-over";
    }
    if (this.hasAccum) s.drawImage(this.strokeAccum, 0, 0);

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.preStroke) ctx.drawImage(this.preStroke, 0, 0);
    this.compositeStroke();
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

  /** 塗りをまるごと差し替える。undo は積まないので、ここまでは戻れない */
  loadSource(src: CanvasImageSource): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(src, 0, 0, this.canvas.width, this.canvas.height);
  }

  /** 保存済みの塗りを復元する */
  loadDataUrl(dataUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.loadSource(img);
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
