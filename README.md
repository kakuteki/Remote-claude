# remote-claude

チャットアプリで「リモコン開いて」と送ると、手元の PC で `claude remote-control` を起動し、
セッション URL（`https://claude.ai/code/session_...`）を返すだけの bot。依存ゼロ Node.js（Node22+）。

**コア（RC起動→URL発行）はチャットアプリ非依存**で、Signal / Telegram / Discord などは
`adapters/<name>.mjs` を差し替えるだけで対応できます。

## 何ができる？
- スマホ等のチャットから一言送る → PC で Remote Control セッションが起動 → 返ってきた URL を開けば、
  どこからでもその PC の Claude Code を操作できる。
- リンク発行の中核は claude CLI の実機挙動に基づく実装（詳細は [SPEC.md](./SPEC.md)）。

## アーキテクチャ
```
チャットアプリ ──(adapter)──▶ コア ──▶ claude remote-control ──▶ session URL ──(adapter)──▶ 返信
  src/adapters/<name>.mjs       src/core/ (チャットアプリ非依存)
```
- `src/core/rc.mjs` … RC 起動・URL 抽出・kill・後始末（**転用の核**）
- `src/core/rc-link-bot.mjs` … 受信→allowlist→トリガ→RC起動→返信、寿命管理・監査
- `src/adapters/<name>.mjs` … チャットアプリ固有（受信・送信・送信者ID）
- `src/index.mjs` … `CHAT_ADAPTER` でアダプタを動的選択して起動

## 対応アダプタ
| adapter | 用途 | ポート開放 |
|---|---|---|
| `signal` | 実運用（signal-cli-rest-api 経由） | 不要 |
| `fake` | テスト/デモ（stdin 入力） | - |
| （自作） | [docs/ADAPTERS.md](./docs/ADAPTERS.md) 参照 | SNS次第 |

## 前提
- claude（native install）導入済み・**claude.ai でログイン済み**・`RC_WORKDIR` を **trust 承認済み**。
- Node.js 22+。

## クイックスタート（fake アダプタ・SNS不要で30秒動作確認）
```bash
cp .env.example .env
# .env を編集: CHAT_ADAPTER=fake / ALLOWED_SENDERS=fake-user / RC_CLAUDE_PATH / RC_WORKDIR
npm run check                 # 構文チェック
npm run rc-once               # コア単体: RCを1回起動→URL表示→自動kill
echo リモコン | node src/index.mjs   # 受信→RC起動→URLが標準出力に返る
```

## Signal で使う
1. 設定: `.env` で `CHAT_ADAPTER=signal`、`SIGNAL_NUMBER`、`ALLOWED_SENDERS`（操作する側のUUID）。
2. bot 専用アカウント（推奨）: 個人利用と分けるため、bot 専用の電話番号で Signal を用意。
   - 公式 Signal アプリでその番号を登録 → signal-cli を **linked device** としてリンクするのが確実
     （captcha 直接 register は signal 側の都合で失敗することがある）。
3. 受信基盤: `docker compose up -d`（`signal-cli-rest-api` を 127.0.0.1:8081 で起動）。
   - リンク: `GET http://127.0.0.1:8081/v1/qrcodelink?device_name=remote-claude` のQRを bot 端末の Signal でスキャン。
4. 送信者UUID確認: bot 起動後に bot へ1通送ると受信ログに `sourceUuid` が出る → `ALLOWED_SENDERS` へ。
5. 起動: `npm start` → チャットから「リモコン開いて」→ URL が返れば成功。

詳細・既知の注意は [SPEC.md](./SPEC.md)。

## 常駐（Windows）
```powershell
# 電源（管理者）
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off
```
- `supervisor.ps1`（`node src/index.mjs` を while 監視で再起動）を Task Scheduler の
  **ログオン時トリガ（30〜60秒遅延・InteractiveToken・ExecutionTimeLimit=PT0S）** で登録。
- サービス化（NSSM 等）は不可（Session 0 では claude.ai ログイン・trust に到達できない）。

## 新しいSNSに対応する
`adapters/<name>.mjs` を1つ追加して `createAdapter(cfg)` を実装し、`.env` の `CHAT_ADAPTER=<name>` にするだけ。
コアは変更不要。規約・最小実装例は [docs/ADAPTERS.md](./docs/ADAPTERS.md)。
- 受信が outbound のSNS（Telegram/Discord/Slack/Signal）はローカルで完結・ポート開放不要。
- webhook 必須のSNS（LINE/WhatsApp）はトンネル（cloudflared/ngrok）が要る。

## セキュリティ
- **allowlist**: `ALLOWED_SENDERS` の完全一致のみ許可。不一致は無言破棄（fail-closed）。
- RC の session URL は実質 bearer（URLを持つ相手はマシンを操作可能）。返信先・取り扱いに注意。
- debug ファイル等の機微は URL 抽出直後に 0x00 上書き削除（`core/rc.mjs`）。
- `.env`・`signal-cli-config/`（認証）はコミットしない（`.gitignore` 済み）。ACL を本人のみ読取に。

## 構成
```
src/
  index.mjs              エントリ（アダプタ動的選択）
  config.mjs             コア設定 + 汎用allowlist + コアhealthCheck
  core/rc.mjs            RC起動・URL発行（非依存・転用の核）
  core/rc-link-bot.mjs   汎用オーケストレータ
  adapters/signal.mjs    Signalアダプタ
  adapters/fake.mjs      テスト用アダプタ
docs/ADAPTERS.md         アダプタの作り方
SPEC.md                  設計・実機検証の根拠
supervisor.ps1           常駐ラッパ
docker-compose.yml       signal-cli-rest-api
```

## ライセンス
MIT
