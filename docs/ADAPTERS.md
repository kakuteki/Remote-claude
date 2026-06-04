# アダプタの作り方（他SNSへの転用）

このプロジェクトは **コア**（`claude remote-control` を起動して URL を発行する部分）と
**チャットアプリ連携（アダプタ）** を分離しています。

- コア: `src/core/`（`rc.mjs` = RC起動/URL抽出、`rc-link-bot.mjs` = オーケストレータ）。**チャットアプリ非依存**。
- アダプタ: `src/adapters/<name>.mjs`。**チャットアプリ固有はここだけ**。

新しい SNS に対応するには `adapters/<name>.mjs` を1つ追加し、`.env` の `CHAT_ADAPTER=<name>` にするだけです。
コア（allowlist・トリガ判定・RC起動・寿命管理・監査・後始末）は一切変更不要です。

## ChatAdapter 規約

`adapters/<name>.mjs` は `createAdapter(cfg)` を export し、次を返します:

```js
createAdapter(cfg) => {
  name: string,
  async healthCheck(): Promise<string[]>,    // 接続前提の検証。問題があれば文字列配列、無ければ []
  start(onMessage): stopFn,                   // 受信購読を開始。各メッセージで onMessage(msg) を呼ぶ
  async send(senderId, text): { ok, error? }, // senderId 宛にテキストを送信
}
```

`onMessage` に渡す `msg`:
```js
{ senderId, senderName, text }
```
- `senderId`: 送信者の安定ID（**allowlist 照合キー**）。小文字に正規化して渡す。
  - 例: Signal=`sourceUuid` / Telegram=`from.id` / Discord=`author.id` / Slack=`user`
- `text`: 本文。**トリガ判定はコアが行う**ので、アダプタは本文をそのまま渡す。

## 責務分担
- **アダプタ**: 受信購読 / 送信者IDの正規化 / 返信。グループ・非テキスト等の対象外はアダプタで弾き `onMessage` を呼ばない。
- **コア**: allowlist 照合（`ALLOWED_SENDERS`）/ トリガ判定（`TRIGGER_WORDS`）/ `claude remote-control` 起動 / URL抽出 / 寿命管理 / 監査 / 機微ファイル後始末。

## 受信モデルの注意（SNS選定の唯一の軸）
- **outbound 型**（ローカルPCで完結・ポート開放不要）: Telegram(getUpdates), Discord(Gateway WS), Slack(Socket Mode), Signal(signal-cli) → アダプタ化が容易。
- **webhook 必須型**（公開HTTPSが要る）: LINE / WhatsApp / Messenger → ローカル運用にはトンネル(cloudflared/ngrok)が必要。アダプタの `start` でローカルHTTPサーバ＋トンネル前提になる。

## 最小実装例
- `adapters/fake.mjs` … stdin 入力で受信を模擬し、返信は標準出力。**SNSなしで全体を動作確認できる**。
- `adapters/signal.mjs` … signal-cli-rest-api(json-rpc) 経由の実運用アダプタ。

## 新規アダプタ チェックリスト
1. `createAdapter(cfg)` を export
2. `healthCheck` で必須env・到達性・トークンを検証（fail-closed）
3. `start` で受信購読（**再接続・冪等化**を推奨）
4. `send(senderId, text)` で返信
5. `.env.example` に必要env を追記、README の対応アダプタ表に追記
