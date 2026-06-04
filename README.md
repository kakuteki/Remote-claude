# signal-rc-bot

Signal で「リモコン開いて」と送ると、このPCで `claude remote-control` を起動し、
セッション URL（`https://claude.ai/code/session_xxx`）を Signal に返すだけの bot。
依存ゼロ Node.js（Node22+）。仕様の根拠は [SPEC.md](./SPEC.md)、調査記録は `research-*`。

## 構成
- `src/config.mjs` … .env 読込・5項目ヘルスチェック
- `src/signal.mjs` … Signal アダプタ（受信WS / 送信HTTP / allowlist）※チャットアプリ依存はここだけ
- `src/rc.mjs` … RC 起動・URL抽出・kill・後始末（チャットアプリ非依存のコア）
- `src/bot.mjs` … 統合・寿命管理・多重起動防止・監査
- `docker-compose.yml` … signal-cli-rest-api（受信/送信基盤）
- `supervisor.ps1` … 常駐ラッパ（Task Scheduler から起動）

## 前提
- claude（native install）導入済み・**claude.ai でログイン済み**・`RC_WORKDIR` を **trust 承認済み**。
- Signal アカウントを signal-cli に **linked device** 登録済み（既存 `signal-cli-test` の `signal-cli-config` を流用可）。
- Node.js 22+ / Docker。

## セットアップ
1. 設定:
   ```
   cp .env.example .env
   ```
   `.env` の `SIGNAL_NUMBER`（自分の番号）, `ALLOWED_UUIDS`（自分のUUID）, `RC_CLAUDE_PATH`, `RC_WORKDIR` を確認。
   （番号・UUID はあなたがリンクした Signal アカウントの値）

2. bot専用アカウント作成（案A・別番号で完全分離。port 8081 / 既存8080とは別コンテナ）:
   - `docker compose up -d`（signal-rc-api を 127.0.0.1:8081 で起動。volume=./signal-cli-config は空のbot専用）。
   - captcha 取得: ブラウザで https://signalcaptchas.org/registration/generate.html を開き、完了後の `signalcaptcha://...` トークンをコピー。
   - 登録: `curl -X POST http://127.0.0.1:8081/v1/register/<BOT番号> -H "Content-Type: application/json" -d '{"captcha":"<token>"}'`
   - SMSの6桁で verify: `curl -X POST http://127.0.0.1:8081/v1/register/<BOT番号>/verify/<コード>`
   - `.env` に `SIGNAL_NUMBER=<BOT番号>` を設定（SIGNAL_API/WS は既に :8081）。

3. allowlist（=操作者＝あなたの個人アカウント）:
   - `.env` の `ALLOWED_UUIDS` にあなたの個人UUID（操作する側のアカウント）。
   - bot自身の `SIGNAL_UUID` は登録後 `GET http://127.0.0.1:8081/v1/identities/<BOT番号>` 等で確認し設定（エコー無視用・任意）。
   - 運用: あなたの個人Signalから **bot番号宛** に「リモコン開いて」を送る → bot が URL を返信。

4. trust 承認（未済なら）:
   ```
   ! claude   （RC_WORKDIR で一度起動して trust を承認）
   ```

5. 動作確認:
   ```
   node --check src/config.mjs   # 構文
   npm run rc-once               # RC を1回起動→URL表示→5秒後kill（Signal不要のコア確認）
   npm run health                # ヘルスチェックのみ（signal-cli-rest-api 到達確認込み）
   npm start                     # 本起動
   ```

6. スマホから「リモコン開いて」→ URL が返れば成功。

## 常駐（Windows）
1. 電源（管理者）:
   ```
   powercfg /change standby-timeout-ac 0
   powercfg /change hibernate-timeout-ac 0
   powercfg /hibernate off
   ```
2. Task Scheduler に `supervisor.ps1` を登録:
   - トリガ: ログオン時（**30〜60秒遅延**）
   - 操作: `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <絶対パス>\supervisor.ps1`
   - 設定: 「ユーザーがログオンしているときのみ実行」/ `InteractiveToken` / `ExecutionTimeLimit=PT0S`(無期限) / 多重起動=新しいインスタンスを開始しない / バッテリ条件オフ
   - ※サービス化(NSSM 等)は不可（Session 0 では claude.ai ログイン・trust に到達できない）。

## セキュリティ要点（詳細は SPEC §6）
- allowlist は `sourceUuid` 完全一致のみ。グループ経由・許可外は無言破棄。
- 返信先は自分宛(Note to Self)を主防御。RC URL は実質 bearer なので扱い注意。
- debug-file 等の機微ファイルは URL 抽出直後に 0x00 上書き削除（`rc.mjs`）。
- `.env` / `signal-cli-config/` は `.gitignore` 済み。ACL を本人のみ読取に。

## 既知の未確定点
`SPEC.md §12` を参照（no-console 起動、linked device 実機確認、`JSON_RPC_RECEIVE_MODE=manual` 等）。
本実装は既存 signal-cli-test と同じ「WS接続=受信」方式（on-start 相当）を踏襲している。
