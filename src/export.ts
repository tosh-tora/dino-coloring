// 完成作品を端末の外（写真アプリ／ファイル）へ書き出す。
//
// iPad の PWA（ホーム画面追加・standalone）では navigator.share({ files }) が
// Photos/Files に届く唯一の経路。<a download> は standalone では効かないため、
// 開発機（macOS ブラウザや非 standalone の Safari タブ）向けのフォールバックにする。
//
// 重要な制約: WebKit は navigator.share() の呼び出しをユーザー操作の有効期限
// （transient activation）に厳しく紐付けている。呼び出し前に await を挟む
// （fetch(dataUrl)、FileReader、canvas.toBlob など）と NotAllowedError で弾かれる
// ことがある。GalleryItem.dataUrl は既にメモリ上の base64 文字列なので、
// atob() で完全に同期に File へ変換し、その場で navigator.share() を呼ぶ。
// このモジュールを呼ぶ側も、saveWorks() 呼び出しより前に await を挟んではいけない。

/** 1 回の共有シートに載せる最大枚数。多すぎるとメモリと共有先が保たない。 */
export const SHARE_BATCH_MAX = 20;

/** 書き出し 1 件ぶん。GalleryItem のうち id が確定したものから作る。 */
export interface ExportSource {
  id: number;
  dataUrl: string;
  lineartId: string;
  createdAt: number;
}

export type SaveOutcome =
  | { kind: "shared"; count: number }
  | { kind: "downloaded"; count: number }
  | { kind: "cancelled" }
  | { kind: "unsupported" }
  | { kind: "failed" };

export interface SaveResult {
  outcome: SaveOutcome;
  /** 実際に送り出せた作品の id（選択解除に使う） */
  savedIds: number[];
  /** data URL を解釈できず飛ばした件数 */
  skipped: number;
}

/** この環境でファイルの共有ができそうか（案内表示用のおおまかな判定）。 */
export function shareFilesSupported(): boolean {
  try {
    const probe = new File([new Uint8Array([0])], "probe.png", { type: "image/png" });
    return (
      typeof navigator.share === "function" &&
      typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [probe] })
    );
  } catch {
    return false;
  }
}

/** 共有シート／ダウンロードに出すファイル名。ASCII のみにして文字化けを避ける。 */
export function exportFileName(src: ExportSource, seq?: number): string {
  const d = new Date(src.createdAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const safeId = src.lineartId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "art";
  const suffix = seq && seq > 1 ? `-${seq}` : "";
  return `dino-${stamp}-${safeId}${suffix}.png`;
}

/**
 * data URL を同期的に File にする。fetch(dataUrl) や canvas.toBlob を使うと
 * await が挟まり、iPad Safari が navigator.share() を NotAllowedError で弾く。
 */
function dataUrlToFile(dataUrl: string, filename: string): File {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("bad data url");
  const header = dataUrl.slice(0, comma);
  if (!header.startsWith("data:") || !header.includes(";base64")) throw new Error("not base64");
  const mime = header.slice(5, header.indexOf(";")) || "image/png";
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], filename, { type: mime });
}

/** 連続ダウンロードはブラウザが抑制するので間隔を空ける。開発機向けの経路。 */
async function downloadFiles(files: File[]): Promise<void> {
  for (let i = 0; i < files.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 400));
    const url = URL.createObjectURL(files[i]);
    const a = document.createElement("a");
    a.href = url;
    a.download = files[i].name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/**
 * 選択した作品を書き出す。先頭 SHARE_BATCH_MAX 件だけを 1 回で扱う。
 * 【重要】呼び出し側はタップハンドラから await を挟まずにこれを呼ぶこと
 * （内部の File 生成と navigator.share() は同期に走る）。
 */
export async function saveWorks(sources: ExportSource[]): Promise<SaveResult> {
  // ---- ここから navigator.share() までは同期。await を入れてはいけない ----
  const batch = sources.slice(0, SHARE_BATCH_MAX);
  const files: File[] = [];
  const ids: number[] = [];
  let skipped = 0;
  const used = new Set<string>();
  for (const src of batch) {
    try {
      let name = exportFileName(src);
      for (let n = 2; used.has(name); n++) name = exportFileName(src, n);
      used.add(name);
      files.push(dataUrlToFile(src.dataUrl, name));
      ids.push(src.id);
    } catch {
      skipped++; // 壊れた data URL は飛ばして、残りは保存できるようにする
    }
  }
  if (files.length === 0) {
    return { outcome: { kind: "failed" }, savedIds: [], skipped };
  }

  if (
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files })
  ) {
    try {
      // files だけを渡す。iOS では text/url を混ぜると共有先(Photos等)が減ることがある
      await navigator.share({ files });
      return { outcome: { kind: "shared", count: files.length }, savedIds: ids, skipped };
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      return { outcome: aborted ? { kind: "cancelled" } : { kind: "failed" }, savedIds: [], skipped };
    }
  }

  // ---- ここから先はフォールバック（開発機向け）。await して構わない ----
  if (typeof URL.createObjectURL !== "function") {
    return { outcome: { kind: "unsupported" }, savedIds: [], skipped };
  }
  try {
    await downloadFiles(files);
    return { outcome: { kind: "downloaded", count: files.length }, savedIds: ids, skipped };
  } catch {
    return { outcome: { kind: "failed" }, savedIds: [], skipped };
  }
}
