# AI旅のおとも ver2 (sanpo-ai-v2)

## プロジェクト概要

スマホカメラを使った「AI散歩コンパニオン」アプリ。撮影した写真をAIが認識し、友達のように会話したり、対象物をスキャンしてコレクション化＆3Dモデル生成ができる。

## 技術スタック

- **サーバー**: Node.js + Express 5（ESM）、HTTPS（自己署名証明書）
- **フロントエンド**: バニラJS + Tailwind CSS（CDN）、SPA（index.html 1ファイル + camera.js）
- **AI/API**: OpenAI GPT-4o-mini（会話・画像認識・物体識別）、OpenAI Whisper（音声認識）、OpenAI TTS（音声合成、voice: nova, format: opus）、Tripo3D API（画像→3Dモデル変換）
- **3Dビューア**: `<model-viewer>`（Google、unpkg CDN）
- **データ保存**: インメモリ（sessions/store.js）— サーバー再起動で全消失

## 起動方法

```bash
node server.js
# → https://0.0.0.0:3000 で起動
# スマホからは https://<PCのIP>:3000 にアクセス
```

HTTPS必須（カメラAPI利用のため）。`key.pem` / `cert.pem` が必要。

## 環境変数（.env）

| 変数名 | 用途 |
|--------|------|
| `OPENAI_API_KEY` | OpenAI API（会話・画像認識・STT・TTS） |
| `TRIPO_API_KEY` | Tripo3D API（3Dモデル生成） |

## ファイル構成

```
server.js              # Expressサーバー、ルーティング、GLBプロキシ
index.html             # フロントエンドUI（モード切替、コレクション画面、チャット表示）
camera.js              # クライアントロジック（カメラ制御、AI通信、スキャン、3D管理、音声）
sessions/store.js      # インメモリセッションストア（履歴、画像、コレクション）
api/unified.js         # 統合会話API（GPT-4o-mini、画像認識含む）
api/speech-to-text.js  # 音声認識API（Whisper）
api/tts.js             # 音声合成API（OpenAI TTS → Opus/Base64）
api/collection.js      # コレクション管理（物体識別→登録、一覧取得、個別取得）
api/generate-3d.js     # 3Dモデル生成（Tripo3D連携、アップロード→タスク作成→ステータス確認）
api/reset-session.js   # セッションリセット
```

## APIエンドポイント

| メソッド | パス | 説明 |
|----------|------|------|
| POST | `/api/unified` | 会話AI（テキスト＋任意で画像） |
| POST | `/api/speech-to-text` | 音声→テキスト変換（Whisper） |
| POST | `/api/tts` | テキスト→音声変換（Base64 Opus返却） |
| POST | `/api/collection` | コレクション操作（スキャン登録 / 個別取得） |
| GET  | `/api/collection?sessionId=xxx` | コレクション一覧取得 |
| POST | `/api/generate-3d` | 3Dモデル生成開始 / ステータス確認 |
| GET  | `/api/proxy-glb?url=xxx` | GLBファイルのCORSプロキシ（Tripo CDN用） |
| POST | `/api/reset-session` | セッションリセット |

## 2つのモード

### おしゃべりモード（chat）— デフォルト
- シャッターボタン → `captureAndSendToAI()` → 画像付きで統合AIに送信 → 会話応答＋TTS読み上げ
- 友達感覚のAI会話（旅のおとも）

### スキャンモード（scan）
- シャッターボタン → `scanAndCollect()` → 物体識別（GPT-4o-mini）→ コレクション登録 → 3Dモデル生成（Tripo3D）
- レアリティ判定: コモン / レア / スーパーレア / レジェンド
- スキャン結果カードが一時表示される

## 3Dモデル生成フロー

1. `scanAndCollect()` でコレクション登録後、`start3DGeneration(itemId)` を呼出
2. サーバー側: 画像をTripo3Dにアップロード → image_token取得 → `image_to_model` タスク作成
3. クライアント側: 10秒後から5秒間隔でポーリング（`poll3DStatus`、最大60回=5分）
4. 完了時: `glbUrl` をストアに保存、トースト通知
5. 表示時: `<model-viewer>` で `/api/proxy-glb?url=...` 経由で読み込み（CORS回避）

**Tripo APIのレスポンス構造に注意**:
- GLB URLは `statusData.data.output.pbr_model` にある（`output.model` ではない）
- フォールバック: `statusData.data.result.pbr_model.url`

## 音声処理

- **TTS**: OpenAI TTS API → Opus形式 → Base64でクライアントに返却 → `<audio>` で再生
- **STT**: ブラウザで録音（WebM）→ Base64化 → Whisper API
- **フォールバック**: TTS失敗時は Web Speech API（ブラウザ内蔵）を使用
- **モバイル対策**: AudioContext解禁、Audio要素のプリウォーム（初回タップ時）

## セッション管理

- `SESSION_ID`: ブラウザ側でlocalStorageに生成・保持（`ss-` プレフィックス）
- サーバー側: `sessions/store.js` でインメモリ管理
  - `history[]`: 会話履歴（最大5ターン=10メッセージ）
  - `images[]`: 撮影画像（最大5枚、Base64）
  - `descriptions[]`: AI応答の画像説明（最大5件）
  - `collection[]`: スキャンしたコレクションアイテム

## UIの特徴

- フルスクリーンカメラプレビュー
- タップでUIオーバーレイの表示/非表示切替
- チャットは右上に最新2件のみ表示（古いものはフェードアウト）
- ボトムシートに詳細コントロール（カメラ選択、ズーム、画像送信、録音）
- コレクション画面（グリッド表示 → 詳細表示 → 3Dモデルビューア）
- スキャン結果カードは5秒後に自動非表示

## 既知の制約・注意点

- **データ永続化なし**: サーバー再起動でセッション・コレクション全消失
- **Tripo3D無料枠**: クレジット制限あり。キュー待ちが長い場合がある
- **3D品質**: 無料プランは標準品質（v2.5）。有料で `geometry_quality: "high"` 可能
- **HTTPS自己署名証明書**: スマホブラウザで初回アクセス時に警告が出る
- **body sizeリミット**: `express.json({ limit: '50mb' })` — 画像・音声の大きなペイロード対応
