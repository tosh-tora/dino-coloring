// 主役抽出をメインスレッドから追い出すための Worker。
//
// extractSubjectMasks は 1024x768 のモルフォロジーを半径の組み合わせぶん総当たりするため、
// 1 下絵あたり数秒かかる。メインスレッドで走らせると「できた！」の紙吹雪が 1 フレームも
// 描かれないまま終わったり、お絵かき中の操作が固まったりする。
//
// 判定そのものは cutout.ts をそのまま使う。しきい値や手順はここに複製しないこと。

import { extractSubjectMasks, type SubjectMask } from "./cutout";

export interface CutoutRequest {
  /** 呼び出し側が結果を突き合わせるための通し番号 */
  id: number;
  /** 線画のアルファ値。長さ w*h（転送されてくるので呼び出し側では使えなくなる） */
  alpha: ArrayBuffer;
  w: number;
  h: number;
}

export interface CutoutResponse {
  id: number;
  masks: SubjectMask[];
}

self.onmessage = (e: MessageEvent<CutoutRequest>) => {
  const { id, alpha, w, h } = e.data;
  const masks = extractSubjectMasks(new Uint8Array(alpha), w, h);
  // masks は転送せず構造化複製で返す。マスク同士が同じ ArrayBuffer を指していた場合に
  // 転送リストが例外になるため。1 枚 786KB のコピーは数秒の抽出に比べれば無視できる
  const res: CutoutResponse = { id, masks };
  self.postMessage(res);
};
