# きょうりゅう ぬりえ (dino-coloring)

4歳児向けの恐竜ぬりえ Web アプリ（PWA）。iPad の Safari で開いて「ホーム画面に追加」すると、フルスクリーンのアプリとして使える。

## 使い方（開発）

```bash
npm install
npm run dev          # http://localhost:5173 （--host 付きで LAN 内の iPad からも見える）
npm run build        # 型チェック + dist/ に本番ビルド
npm run preview      # 本番ビルドの確認
```

iPad で試す: PC と同じ Wi-Fi に繋ぎ、`npm run dev` 起動時に表示される Network URL（例 `http://192.168.x.x:5173`）を Safari で開く。

## 機能（v1）

- **ぬりえライブラリー**: 同梱の線画 10 点（恐竜 6 + さかな/おはな/ロケット/ちょうちょ）。塗りかけには 🖍️ バッジが付き、開くと「つづきから / あたらしく」を選べる
- **ブラシ塗り**: 基本 12 色 + じぶんの色（カラーピッカー）+ 消しゴム、太さ 4 段階の大ボタン
- **重ね塗りモード**: 🖍️ うわがき（不透明）↔ 🌈 まぜまぜ（multiply 合成、色が混ざる）
- **輪郭線は常に前面**: 線画レイヤーを塗りレイヤーの上に重ねた 2 canvas 構成なので、構造的に塗りつぶせない
- **もとに戻す**: 1 ストロークずつ Undo（最大 12 段）
- **ぜんぶ消す**: 誤タップ防止のため 1.5 秒長押しで発動（進捗リング表示）。消した直後は Undo で戻せる
- **自動保存**: ストロークごとに IndexedDB へ保存（1.5s debounce）。リロードしても続きから
- **できた！**: 紙吹雪 + ファンファーレ（WebAudio 合成、音声ファイル不要）→ ギャラリーに保存
- **ギャラリー**: 完成作品の一覧。長押しで削除（おとな向け操作）
- **PWA**: manifest + Service Worker（cache-first）。一度読み込めばオフラインで動作

## 構成

```
index.html               エントリ（iPad Safari 向け meta 含む）
public/manifest.webmanifest, sw.js, icons/
src/main.ts              画面遷移（ライブラリー/ぬりえ/ギャラリー）
src/paint.ts             ブラシエンジン・Undo（ストロークバッファ方式）
src/tools.ts             ツールバー UI・長押しヘルパー
src/store.ts             IndexedDB 永続化（works / gallery）
src/lineart.ts           線画カタログ（SVG を ?raw インポート）
src/celebrate.ts         紙吹雪 + WebAudio 効果音
assets/lineart/*.svg     線画（viewBox 1024x768、透明背景、太い黒線）
```

### 設計メモ

- 塗りレイヤー（下）と線画レイヤー（上、`pointer-events: none`）の 2 canvas。塗りは下にしか乗らない
- ストローク描画は毎フレーム「ストローク全体を一時バッファに描き直して合成」する方式。multiply モードでもセグメント継ぎ目が濃くならない
- 線画 SVG は透明背景・黒線のみ（白背景を入れると塗りが隠れる）。領域は視覚的に閉じているが、v2 でバケツ塗りを入れる場合はピクセルレベルの閉領域チェックが必要
- マルチタッチは最初の 1 本のみ受け付け（簡易パーム対策）

## v2 候補（未実装）

- 画像アップロード → AI で可愛い線画に変換してライブラリーへ追加（API・中継サーバー要）
- タップで塗りつぶし（バケツ）モード
- アップロード・削除系のペアレンタルゲート

## デプロイ

`npm run build` の `dist/` を任意の静的ホスティング（GitHub Pages 等）に置くだけ。`vite.config.ts` の `base: "./"` によりサブパス配下でも動く。
