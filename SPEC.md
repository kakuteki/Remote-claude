# signal-rc-bot 仕様書 v2.0（確定版）

Signal に「リモコン開いて」と送ると、ホスト PC(Windows 11 Pro)で `claude remote-control --spawn session` を
起動し、stdout/debug-file から `session_xxx` を抽出して `https://claude.ai/code/<id>` を Signal に返す、
依存ゼロ Node.js(Node22+) アプリの確定仕様。

- 版: 2.0（31項目をサブエージェントで深掘り調査し、敵対的検証で補正した版）
- 最終更新: 2026-05-31
- 検証状況: コア（RC 起動／kill／抽出／異常系）は Windows 実機(v2.1.158)で実証済み。本書は実測と一次情報に基づく。
- 補助資料: `research-synthesis.md`（統合元）/ `research-decisions.json`（35決定）/ `research-verdicts.json`（19検証）。

---

## 1. 目的とスコープ

### 目的
Signal で特定ユーザーからトリガ語を受けたら、そのマシンで `claude remote-control` セッションを起動し、
**操作用 URL を Signal に返信する**。それだけ。

### スコープ内
- Signal メッセージの受信（特定送信者のみ）／トリガ語判定／RC 起動と session URL 抽出／URL 返信／
  起動失敗時のエラー返信／token を含む副産物の削除。

### スコープ外（このアプリの責務でない）
- RC 接続後の操作（RC 本体／Claude アプリの役割）／汎用 AI 返答／セッションの長期運用（依頼ごと使い捨て）。

### 設計原則
- **再現性**: リポジトリを clone すれば他環境で再構築可（Docker 必須ではないが Signal 受信層は Docker で再現）。
- **チャットアプリ分離**: Signal 依存は `signal.mjs`（アダプタ）に隔離、コア `rc.mjs` は完全非依存（将来 Discord 等に差替可）。
- **決定的動作**: AI に判断させない。トリガ語 → RC 起動 → URL 返信、を確定的に実行。

---

## 2. アーキテクチャ

```
┌── スマホ Signal ──┐  「リモコン開いて」
└─────────┬─────────┘
          │ Signal network（送信者=自分のみ allowlist）
          ▼
┌─────────────────────────────────────┐  Docker（再現性のため）
│ signal-cli-rest-api  MODE=json-rpc    │  linked device(secondary)
│  WS  ws://127.0.0.1:8080/v1/receive   │  JSON_RPC_RECEIVE_MODE=manual
│  HTTP http://127.0.0.1:8080/v2/send   │
└─────────┬───────────────────────────┘
          │ WebSocket(受信) / HTTP(送信)  ※localhost のみ
          ▼
┌─────────────────────────────────────┐  ホスト native node（依存ゼロ）
│ signal-rc-bot                         │  ※claude を spawn するため
│  signal.mjs  受信WS/送信/allowlist    │     コンテナでなくホストで常駐
│  rc.mjs      RC起動/抽出/kill/後始末  │
│  bot.mjs     束ね・寿命管理・監査     │
└─────────┬───────────────────────────┘
          │ child_process.spawn(detached:false, windowsHide:true,
          │   stdio:['ignore','pipe','pipe'], env からAPIキー除去)
          ▼
┌─────────────────────────────────────┐  ホスト native（claude.ai ログイン済）
│ claude remote-control --spawn session │  C:\Users\kaga\.local\bin\claude.exe v2.1.158
│  --debug-file tmp\rc-<name>.log       │  → stdout/debug-file から session_xxx
└─────────────────────────────────────┘
```

### bot がホスト native node である理由（確定）
`claude remote-control` は claude.ai ログイン(API キー不可)が必須でその認証はホストの `~/.claude` にある。
Docker(Linux) コンテナからホストの `claude.exe` は起動できない。よって RC を起動する bot 本体はホストで動かす。
Signal 受信層(signal-cli-rest-api)はコンテナのままで `127.0.0.1:8080` で繋がる。
別環境(別PC/Linux/mac)へは、その環境に claude を入れてログイン＋本リポジトリ配置で再現（§8）。

---

## 3. Signalアダプタ（受信・送信・登録・認可）

### 3.1 受信フォーマット（signal-cli-rest-api, MODE=json-rpc）
受信は WebSocket `ws://127.0.0.1:8080/v1/receive/<E164番号>`。json-rpc モードでは WS（HTTP GET ではない）。
WS フレームは「1メッセージ=1テキストフレーム=1JSON」。bbernhard は signal-cli の `params` 中身のみ転送するため
**jsonrpc/method/params ラッパは付かない**。トップレベルは `{ "envelope": {...}, "account": "<自番号>" }`。

```json
{ "envelope": {
    "source": "+8190...", "sourceNumber": "+8190...",
    "sourceUuid": "xxxxxxxx-....", "sourceName": "表示名", "sourceDevice": 1,
    "timestamp": 1631458508784,
    "dataMessage": { "timestamp": 1631458508784, "message": "リモコン開いて",
      "expiresInSeconds": 0, "viewOnce": false, "mentions": [], "attachments": [],
      "groupInfo": { "groupId": "...", "type": "DELIVER" } } },
  "account": "+81<自番号>" }
```
本文なしイベント(typing/既読/配信レシート/sync)は `dataMessage` を持たず
`typingMessage`/`receiptMessage`/`syncMessage` 等のキーを持つ。

### 3.2 受信パーサ抽出ロジック（確定）
1. WS TEXT フレームを `JSON.parse` し `obj.envelope` 取得。
2. `env.dataMessage?.message` が非空文字列のときのみ処理対象（sync/receipt/typing/call/edit は破棄）。
3. `text = env.dataMessage.message.trim()`（@メンションで U+FFFC `￼` 混入があり得るので trim/包含で吸収）。
4. 送信者識別は `env.sourceUuid`（主キー）。表示は `env.sourceName`。
5. 返信宛先: 個別は `recipients=[env.source]`。グループは `groupInfo.groupId`（internal_id）を `"group."+groupId` に変換（本bot はグループ破棄＝§6.1）。
6. `env.timestamp`(ms) をイベント時刻に。

### 3.3 送信 API（POST /v2/send）
- `POST http://127.0.0.1:8080/v2/send`、`Content-Type: application/json`、fetch タイムアウト 10s 明示。
- ボディ `{ "number":"<自番号E164>", "recipients":["<宛先>"], "message":"<本文>", "text_mode":"normal" }`。
  - 宛先は **自分の登録番号1件のみ**（Note to Self 相当）。`text_mode:"normal"`（styled は `* _ ~ | \`` が URL を壊す。サーバ既定 styled 対策で明示）。
- 成功 HTTP **201**、ボディ `{"timestamp":"<ms>"}` を **保持**（事後削除§3.7で使用）。
- エラー: 400/429/413(`challenge_token` 同梱)/500、ボディ `{"error":"..."}`。失敗はログのみ、自動再送は §3.6 のバックオフのみ。

### 3.4 アカウント登録（linked device 方式）
signal-cli-rest-api を既存スマホアカウントの **リンク済みデバイス(secondary)** として登録（primary 新規=captcha+SMS は不採用）。
- 永続化 volume `-v <host_dir>:/home/.local/share/signal-cli`、`MODE=json-rpc`、`-p 8080:8080`。
- リンク: ブラウザで `http://localhost:8080/v1/qrcodelink?device_name=signal-rc-bot`(PNG)、または `GET /v1/devices/{number}/link` の `device_link_uri` を QR 化 → スマホ Signal → 設定 → リンク済みデバイス → スキャン承認。
- `SIGNAL_NUMBER` には **スマホ(primary)の E.164 番号**を設定（リンクで新番号は出ない）。
- 制約: linked 最大5台／同一マシンで複数 signal-cli 同時起動不可／履歴非同期。既知リスク #651(新しめ Android で qrcodelink 拒否)→ latest イメージ＆signal-cli 最新化で再試行。

### 3.5 操作者 UUID(ACI) 確認と allowlist
allowlist は **UUID(ACI)** で行う（番号は使わない）。照合キー `envelope.sourceUuid`。
- 推奨: WS を購読し自分から bot 宛に1通送り、受信 JSON の `sourceUuid` を `ALLOWED_UUIDS` に登録。
- 補助: `GET /v1/contacts/<SIGNAL_NUMBER>` / `/v1/identities/<SIGNAL_NUMBER>` の自番号エントリ `uuid`。
- bot 自身のエコー無視用に `SIGNAL_UUID` も控える。

### 3.6 受信信頼性・冪等化・レート制限
- signal-cli は受信時に自動 ack（アプリ ack 不要）。bbernhard WS 既定(on-start)は購読者不在中の到着を破棄する(#834)ため **`JSON_RPC_RECEIVE_MODE=manual` で起動し接続後に `subscribeReceive` で明示購読**（マージ状況は §12 要確認）。
- WS 無限自動再接続: 指数バックオフ(初回1s,×2,上限30s,±20%ジッタ)、接続成功でリセット。30s ping/pong 死活監視、pong 不達2連続で能動再接続。再接続後は必ず `subscribeReceive` 再発行。
- 冪等キー = `sourceUuid(無ければsourceNumber)` + `timestamp` + `種別`。TTL 10分・最大1000件の in-memory LRU。副作用(RC起動/返信)は dataMessage の初出1回のみ。
- レート制限: 「受信への単一返信のみ・自発発信なし」を不変条件とし通常抵触せず。送信失敗は 2s→8s→30s 最大3回で再送、超過はログのみ（無限再送禁止）。429/413+`challenge_token` は自動再送せず `POST /v1/accounts/{number}/rate-limit-challenge` の CAPTCHA 手動解決をエスカレーション。

### 3.7 返信本文と事後削除
- 成功返信は **URL 1行のみ**（前置き・絵文字・装飾・escape なし。Signal が自動リンク化）。
- 送信成功後、可能なら `DELETE /v1/remote-delete/{number}`(body `{recipient:<自番号>, timestamp:<送信応答timestamp>}`)で delete-for-everyone（Note-to-Self は自端末既配信のため**補助層**。主防御は返信先限定とファイル削除）。

---

## 4. RCコア（起動・抽出・モード・異常系）

### 4.1 起動モード（確定）
`claude remote-control --spawn session --debug-file <tmp>`（Signal依頼1件 = RCプロセス1本）。
- `--spawn session` は起動時にちょうど1セッションを確定生成し固有 `session_xxx` 直リンクを先出しできる（"single-session mode. Serves exactly one session and rejects additional connections" v2.1.158 実機確認）。
- server(same-dir/worktree) は環境スコープ URL(毎回同一 `?environment=env_xxx`)で先出し不適のため不採用。`--capacity` は session と併用不可なので指定しない。
- 複数同時依頼は独立 RC を複数本起動（上限はリソースで運用クリップ §5）。

### 4.2 起動方法（child_process.spawn 確定オプション）
claude.exe は実 PE(console サブシステム, 約225MiB)。shell を介さず直接 spawn。
```js
const env = { ...process.env };
for (const k of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN',
                 'CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY']) delete env[k];
const args = ['remote-control','--spawn','session','--debug-file', debugFile];
const rcProc = spawn(CLAUDE_EXE, args, {
  cwd: WORKDIR, env, shell:false, windowsHide:true, detached:false,
  stdio:['ignore','pipe','pipe'],   // stdout=URL第1優先, stderr=異常系判別
});
rcProc.on('error', ()=>{}); rcProc.on('exit', ()=>{});
```
- `shell:false`（引数は配列）/`windowsHide:true`/`detached:false`（参照保持して kill。`detached:true` は node#21825 で windowsHide が無効化されコマンドプロンプトが出るため使わない。`unref()` も呼ばない）。
- `child.pid` がそのまま claude.exe 本体PID（中間ラッパ無し）。spawn 直後に永続化。
- env は浅いコピーから RC 拒否要因(API キー/トークン/Bedrock・Vertex・Foundry 系)を delete。PATH/USERPROFILE 等は継承必須。spawn 失敗時 pid は undefined になるので kill 前にガード。

> **no-console 制約（補正）**: 完全 no-console(Task Scheduler S4U 等)では stdin が TTY にならず Ink の `setRawMode()` が `Raw mode is not supported` で即死する。本bot は **ログオン中ユーザーセッション内で起動（実コンソール/conhost が割り当たる）構成を前提**とする。完全 no-console 化が要る場合のみ ConPTY(node-pty) を検討（依存ゼロと衝突するため次善、§12 要確認）。

### 4.3 session_id / URL 抽出戦略（補正: stdout 第1優先）
session_id 形式 `session_[A-Za-z0-9]+`（`cse_xxx`/内部UUID/`env_xxx` とは別物）。多段フォールバック:
1. **stdout を ANSI 除去後** `/https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+)/`（再利用・新規いずれでも常に出力。最優先）
2. debug-file `/\[bridge:init\] Created initial session (session_[A-Za-z0-9]+)/`（**新規環境登録時のみ**。再利用時は出ない＝補助）
3. (回帰監視用) debug-file `/\[bridge\] Fetching session (session_[A-Za-z0-9]+)/`
4. (回帰監視用) debug-file `/server title for (session_[A-Za-z0-9]+)/`

理由: 同一 WORKDIR を頻繁再起動する本bot では bridge-pointer.json による**環境再利用**が日常的に起き、その場合
`Created initial session` 行は出ない。stdout の URL 行は両パスで常に出て session_xxx に ANSI 混入なし。
採用しない: `--output-format`/`--json`(remote-control に無い)、session 一覧 API(短命 secret 必須)、debug-file JSON パース。

### 4.4 フレッシュ起動の強制
起動直前に `C:\Users\<user>\.claude\projects\<dir-key>\bridge-pointer.json`
(dir-key=WORKDIR 絶対パスの全区切り〈ドライブのコロン含む〉を `-` 置換、例 `C--Users-kaga-rc-workspace`)を削除して
環境再利用を防ぐ。怠ると `source:"standalone"` の pointer で既存環境が再利用され debug-file アンカーが消える。
pointer JSON=`{ sessionId, environmentId, source, pid, procStart }`（`sessionId` はフォールバック抽出にも使える）。
※同一 WORKDIR で複数 RC を同時起動する運用に変える場合は pid 照合してから削除（本bot単発運用では無条件削除でよい）。

### 4.5 URL 出現待機ロジック
- `setInterval` **100ms 間隔**で debug-file を毎回全文読み(`readFile utf8`)て正規表現 `.match()`（不完全行を構造的に回避）。同時に捕捉した stdout バッファも §4.3 優先1で走査。
- ENOENT は無視して継続。子の `exit`/`error` も監視し、URL 未検出で子終了したら即エラー（タイムアウト待ちしない）。
- ハードタイムアウト **`URL_WAIT_MS = 15000`**（実測起動 約2.1〜2.2秒。これは余裕でなく**必須の暴走防止**: API 登録が回線不調でスタックすると無音で最長約10分生存しうる）。満了/エラーは `taskkill /T /F` で終了し失敗扱い。
- 成功・失敗・タイムアウトいずれでも必ず `clearInterval` し機微ファイル削除（§6.3）。

### 4.6 プロセスツリーと kill
- 構造: 【bridge 親】`remote-control --spawn session`(常駐) →【セッション子】`claude.exe --print --sdk-url …/cse_xxx --session-id cse_xxx`(bridge起動後に spawn)。各プロセス直下に conhost.exe が付くことあり（実機: 親26844 → {conhost3384, 子24096 → conhost36612}）。
- 停止は **必ず** `taskkill /PID <bridge親pid> /T /F`（`/T` で生存中の親子ツリーを再帰終了）。`child.kill()`/`process.kill()`/`Stop-Process` は子が孤児化するため不可。
- **孤児補強**: `/T` は中間プロセスが kill 時点で生存している前提。kill 直後に `Win32_Process` を本体pidから `ParentProcessId` で辿り、残存子孫(claude.exe/conhost.exe で本体起動時刻以降生成)があれば個別 `taskkill /PID <pid> /F` で掃除。
- 無差別kill(全 claude.exe)は bot 自身/他 RC を巻き込むため禁止。

### 4.7 異常系ハンドリング（補正）
判別は **stdout+stderr マージバッファへの部分一致**（行頭 `Error:` 前提にしない。`Session creation failed` は `●` 始まり）。
**認証・trust 系の本文は debug-file に書かれない**ため debug-file は session_id 抽出専用。ヒット時は固定日本語を返信し必ず kill＋削除。

| 事象 | 判別正規表現(/i) | Signal返信 |
|---|---|---|
| API key混入 | `ANTHROPIC_API_KEY is set` / `Remote Control (requires\|is disabled).*(subscription\|organization's policy)` | APIキー認証になっています。ANTHROPIC_API_KEY 等を外し、ホストで `claude`→`/login`(claude.ai)で再ログインして再起動してください |
| full-scope以外トークン | `requires a full-scope login token` | setup-token/長命トークンでは不可です。ホストで `claude`→`/login`(claude.ai)で再ログインしてください |
| 401/失効/接続切れ | `Authentication failed \(401\)` / `Remote Control session expired` / `Access denied` | ログインが切れています。ホストで `claude auth login`(失敗時 logout 後 login)してから再送してください |
| 未ログイン/サブスク無 | `requires a claude.ai subscription` / `Unable to determine your organization` | claude.ai 未ログインです。ホストで `claude`→`/login`(claude.ai)してください |
| ネット断/認証取得失敗 | `Remote credentials fetch failed` / `Session creation failed` | ネットワークか認証取得に失敗。Anthropic API:443 への接続を確認して再送してください |
| workspace未trust | `Workspace not trusted` | 作業ディレクトリが未承認です。ホストで対象 dir で一度 `claude` を実行し trust を承認してください |
| 適格性無効 | `not yet enabled for your account` | このアカウントでは Remote Control が未有効です(環境変数/組織設定を確認) |
| 上記以外 | (フォールバック) | RC起動に失敗しました（生ログ末尾添付）＋ stdout/stderr 末尾20行 |

補足:
- 401 は二系統。**Registration phase 401**(起動時, #61551, valid Max でも誤発火)は起動時捕捉可。**Poll phase 401**(#30102, URL返信後の接続時)は同期パスで捕捉不能→ユーザー再送運用。正規表現 `Authentication failed \(401\)` で両 verbatim を被覆。
- trust 未承認は exit code 1 で即終了し stderr に `Error: Workspace not trusted. Please run \`claude\` in <dir> first …`（stdout 空・debug-file に bridge:init 無し）。`stdio:['ignore','pipe','pipe']` の stderr を `/Workspace not trusted/` で判別。
- ネット断約10分の session timeout(exit) は認証失効と区別しユーザー再送運用。capacity 超過・同名は session モードでは実害なくフォールバック任せ。

### 4.8 RC session URL の寿命・再接続
- URL は「動作中ローカル RC への ポインタ」。開いた先で同一アカウント/組織ログイン必須。bearer ではないが docs が「URL 漏洩時は誰でもローカルへコマンド送信可」と明記するため**実質 bearer** 扱い(§6)。
- 失効条件: (1)プロセス終了 (2)ネット到達不能 約10分超 timeout/exit (3)ultraplan 起動で切断 (4)claude.ai OAuth 失効(約2日、再ログインはホストのブラウザ #36807)。加えて #53563: 失効/サーバ側ローテで remote-control がリフレッシュせず致命終了し全セッション道連れの既知バグ。
- 自動再接続は不具合多発(#34255 無言切断, #28402 Win11 で一覧に出ず再接続不可)。**Bot は再接続前提にせず、要求ごとに新規起動→新URL**。

### 4.9 permission-mode（無人運用時の権限）
RC起動時に `--permission-mode` を**明示しない(=default=Ask)**。bypassPermissions/auto/dontAsk は使わない。
- RC の web/mobile UI で選べるのは Ask / Auto accept edits / Plan のみ。default(Ask) は読取以外を毎回承認要求で最も権限が狭く、prompt がホスト側のみ/hang しても破壊的自動実行は起きず安全側。

---

## 5. 常駐運用（電源・常駐起動・watchdog・寿命管理・多重起動防止）

### 5.1 電源/スリープ/ネットワーク（管理者で一度）
```
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off            # fast startup 起因の NIC 不整合回避
powercfg /change monitor-timeout-ac 10   # 任意（ディスプレイのみ）
```
確認: `powercfg /a` `/requests` `/lastwake` `/waketimers`。S0 Modern Standby 機も timeout 0 で到達性担保。

### 5.2 常駐コンポーネント（二層）
(a) signal-cli-rest-api コンテナ(`restart: unless-stopped`) と (b) bot 本体(Node native) のみ常駐。
RC(`--spawn session`)は要求ごと都度起動し URL 抽出後に終了する短命プロセス（ネット断10分の自然消滅に依存しない）。

### 5.3 watchdog（supervisor.ps1 + ログオン時起動）
bot は Task Scheduler に直接登録せず PowerShell 常駐ラッパでラップ（Task Scheduler の「失敗時再起動」は起動失敗時のみ発火し clean exit を拾えないため）。
```powershell
# supervisor.ps1
while ($true) {
  $p = Start-Process node.exe -ArgumentList 'src\bot.mjs' -PassThru -WindowStyle Hidden
  $p.WaitForExit()
  Start-Sleep -Seconds 5
}
```
- Start-Process に `-RedirectStandard*`/`-NoNewWindow` を付けない（ExitCode が壊れる PS#5421。`-WindowStyle Hidden` のみ）。ログは bot.mjs 自身がファイル追記。
- supervisor は exit code を見ず無条件5秒待って再起動。`WaitForExit()` は直接子(node)のみ待つ＝bot 終了検出に十分。RC 個別セッションは bot 配下の使い捨てで supervisor の待機対象外。
- Task Scheduler 登録対象は supervisor.ps1。トリガ「ログオン時」に **30〜60秒遅延**（シェル/NW/プロファイル未初期化での即落ち→フラップ防止）。実行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <supervisor.ps1>`。
- 禁止: bot 直接登録＋失敗時再起動依存、NSSM 等サービス化(SYSTEM/非対話で claude.ai ログイン・trust に到達不可。S4U は DPAPI を破壊しうる)、遅延ゼロのログオントリガ。

### 5.4 Task Scheduler 設定（XML インポート）
`LogonType=InteractiveToken`(当該ユーザの trust/claude.ai 資格情報を解決) + `RunLevel=LeastPrivilege` +
**`ExecutionTimeLimit=PT0S`(無期限必須。既定 PT72H だと72時間で強制終了)** + `StartWhenAvailable=true` +
`MultipleInstancesPolicy=IgnoreNew` + バッテリ系 false。`schtasks /Create /TN "signal-rc-bot" /XML <xml> /F`。
`KAGA-PC\kaga`・node.exe パス・bot パスは実機値(`whoami`,`(Get-Command node).Source`)に置換。自動ログオン(netplwiz/Autologon)はヘッドレス無人起動が要る場合のみ。

### 5.5 RC プロセス寿命管理
- in-memory レジストリ: `{ pid, session_id, 起動時刻, last_activity, debugパス, transcriptパス }`（Signal返信成功を起点）。
- `HARD_IDLE_TIMEOUT=30分`: サーバ側 TTL 後も Windows では claude.exe がゾンビ化し約1GB/MCPポート/CloseWait を占有(#41024,#32982)するため bot が `taskkill /T /F`。
- `MAX_CONCURRENT=5`(約1GB/プロセスの保守値)。到達時は新規拒否し「上限到達」返信（最古kill優先は設定で切替）。
- 30秒 GC: PID 消滅/アイドル超過を除去し機微ファイル削除。bot 終了/再起動時は全 RC を taskkill してから exit。新規起動直前に前回 pid があれば taskkill(失敗無視)。

### 5.6 bot 多重起動防止
- ロック `%LOCALAPPDATA%\signal-rc-bot\bot.lock`。`fs.openSync(lock,'wx')`(O_EXCL, レース窓なし)で pid＋起動時刻(ISO8601)を JSON 書込み。
- EEXIST 時: 既存 pid を `process.kill(pid,0)` で生存判定。生存→「既起動」ログ＋exit 1。ESRCH→残骸とみなし削除後1回だけ再取得。
- 解放: 正常終了/SIGINT/SIGTERM/uncaughtException で WS を閉じてロック削除。WS購読・RC spawn はロック取得プロセスのみ。

### 5.7 認証ヘルスチェック / 失効監視
- 前提: `~/.claude/.credentials.json` の `claudeAiOauth={accessToken,refreshToken,expiresAt(ms),scopes[],subscriptionType}`。RC は `scopes` に `user:sessions:claude_code` を含む full-scope 必須。実測 TTL 約8時間。`claude auth status` はローカル読みのみで proactive refresh しない。
- 起動前(RC spawn 直前に毎回): (1)`claude auth status --json` で `loggedIn===true && authMethod==="claude.ai" && apiProvider==="firstParty"`。(2)`expiresAt - now < 15分` なら失効間近として起動せず通知(JSON パース失敗も失効扱い)。
- 通知(固定文): 「claude.ai のログインが失効(または失効間近)です。ホストPCのターミナルで `claude auth login` を実行し claude.ai アカウントで再ログインしてください。失敗時は `claude auth logout` 後に再ログイン。」
- 自動リフレッシュは不安定(#34306 等)なため依存せず人手再ログイン。bot 環境に API キー/トークン系を設定しない。

---

## 6. セキュリティ

### 6.1 allowlist（確定）
- 許可キーは **`sourceUuid`(ACI) 完全一致のみ**。`ALLOWED_UUIDS` を UUID 文字列 Set。sourceNumber/top-level `source` は使わない。
- 処理順序（いずれか不一致なら**無言で破棄**＝返信もエラーも返さない）:
  1. `dataMessage` 存在＋非 dataMessage 型(sync/receipt/typing/call/edit)でない。
  2. `dataMessage.groupInfo` があれば破棄（グループ経由は ACI 許可済みでも拒否＝第三者同席による URL 漏えい防止）。
  3. `sourceUuid` の非 null・非空を検証し `ALLOWED_UUIDS` 完全一致。null/不一致は破棄。
  4. `dataMessage.message` のコマンド一致。
- 受信は WS 専用・127.0.0.1 バインドで外部偽 receive 注入を遮断(トランスポート真正性)。送信者真正性は sealed sender 検証済みの sourceUuid で担保(二層防御)。

### 6.2 RC session URL 漏洩対策（多層防御）
URL は **実質 bearer**(docs: 漏洩時「anyone with that URL can send commands to your local machine」, full access=file r/w・terminal・MCP)。オンライン放置で最長約24時間生存しうる。優先 1>3>4>5>6>2:
1. 返信先限定(主防御): 自分宛(Note to Self)のみ。グループ・第三者へ絶対送らない。
2. 履歴削除(補助): §3.7 の remote-delete（Note-to-Self は実効限定）。
3. 機微ファイル削除(必須): debug-file/bridge-transcript を抽出直後に削除(§6.3)。
4. URL 短寿命化(必須): 公式の約10分はネット断継続時のみ発火し放置では発火しないため bot 側アイドルタイムアウト(§5.5)で kill。
5. 発行通知(漏洩検知): RC 起動・URL 発行のたび発行時刻/WORKDIR/PID を自分宛通知（RC に接続監査ログが無いため実質唯一の検知手段）。
6. 被害面限定: `--spawn session`(追加接続拒否)で1セッションに閉じる。
- 注: RC は Anthropic リレーに text/tool result のみ流し code/files/credentials は流さない（環境変数・API キーはマシンに留まる）。これはリレー内容の話でローカル操作権とは別。

### 6.3 機微ファイルの棚卸しと後始末（v2.1.158 実機準拠）
**補正**: v2.1.158 では debug-file の `accessToken`/`secret`/`environment_secret`/`sessionId` は出力時点で `[REDACTED]`（JWT・sk-ant は出ない。旧「平文」は非該当）。それでも全体を機微として即削除。平文で残る要保護: **素の session_id(発行URLの鍵・最重要)**, `env_xxx`, `cse_xxx`, `organization_uuid`, 絶対パス・machine名。

RC 1回で生成される機微ファイル4種（**すべて --debug-file を置いたディレクトリ＝`tmp\` に生成。WORKDIR ではない**）:
1. 親 debug-file `tmp\rc-<name>.log`
2. 子 debug-file `tmp\rc-<name>-cse_<id>.log`（親ログ `Debug log:` 行に明示）
3. `tmp\bridge-transcript-cse_<id>.jsonl`（親ログ `Transcript log:` 行に明示。未送信時 0byte だが存在。**補正: WORKDIR 直下ではない**）
4. `…\.claude\projects\C--Users-kaga-rc-workspace\bridge-pointer.json`（project 単位の単一ファイル。終了後も stale 残置）

後始末:
- `--debug-file` は専用一時ディレクトリ `C:\Users\kaga\rc-workspace\tmp\` に固定(命名 `rc-<name>.log`)。stdout 捕捉に依存し ANSI ターミナル出力に依存しない。
- session_id 抽出の成否直後、次を「ファイル長ぶん 0x00 上書き → `Remove-Item -Force`」で削除: `tmp\rc-<name>.log`, `tmp\rc-<name>-cse_*.log`, `tmp\bridge-transcript-cse_*.jsonl`, bridge-pointer.json（単発運用前提。同時複数なら pid 照合）。transcript の正確パスは親ログ `Transcript log:` 行から取得すると堅牢。
- bot 起動時・各依頼後に同 glob で再掃除（クラッシュ取り残し回収）。WORKDIR 直下にも保険 glob 可。
- 抽出失敗時の終了は `taskkill /PID <親pid> /T /F`（親 kill だけでは子 worker が残る）。

### 6.4 bot ログに残さない項目
session_id・発行URL・token/secret・env_xxx・cse_xxx・organization_uuid・accessToken・Signal 本文(トリガ語以外)・完全な送信者UUID/番号。bot ログは timestamp と「起動成功/失敗/タイムアウト」のみ。

### 6.5 監査ログ（JSONL・1イベント1行）
`tmp/audit-YYYY-MM-DD.jsonl` に追記。項目: `ts`(ISO8601) / `requester`(UUID先頭8 + SHA256先頭8, 例 `a1b2c3d4/9f8e7d6c`) / `trigger` / `outcome`(ok|ng) / `reason`(trust|timeout|spawn|error|send) / `pid` / `elapsed_ms`。session_id・URL全文・token・secret・本文・完全UUID/番号は禁止。日次ローテ・14日削除・ACL 本人のみ。書込失敗は best-effort。

エラー時返信(reason 対応の固定日本語):
- `trust`→「起動できませんでした（作業ディレクトリが未承認）。PC側で承認してください。」
- `timeout`→「起動がタイムアウトしました。もう一度お試しください。」
- `spawn`→「claude を起動できませんでした。PC側のログイン状態を確認してください。」
- `error`→「起動に失敗しました。PC側のログを確認してください。」
- 送信失敗(send)はユーザーに返せずログのみ。

### 6.6 WORKDIR 隔離
- WORKDIR=`C:\Users\kaga\rc-workspace` は機密を一切置かない専用の空 git リポジトリ。ホーム/他プロジェクト/資格情報フォルダへの symlink/junction を置かない（読取が全ディスクに及ぶ）。
- Windows ネイティブは OS サンドボックス非対応(v2.1.158 に `--sandbox` 無し)。隔離は (a)専用フォルダ (b)permission-mode 承認 (c)機密への非リンク で担保。
- 書込は WORKDIR 配下のみ（親は明示承認要）。**読取は全ディスク（~/.ssh, ~/.aws/credentials も既定で読める）＝非リンクが唯一の実効策**。worktree モードは作業分離でありセキュリティ境界ではない。

### 6.7 .env / signal-cli認証 / 一時ファイル保護
- `.gitignore`: `.env`, `.env.*`, `signal-cli-config/`, `tmp/`, `*.log`, `bridge-transcript-*.jsonl`。
- NTFS ACL(本人のみ): `icacls "<.env>" /inheritance:r /grant:r "$($env:USERNAME):(F)"`、dir は `/grant:r "$($env:USERNAME):(OI)(CI)F" /T`。
- Docker は **named volume** 既定（signal-cli-config をホスト bind しない＝WSL2 VM 内に閉じる）。bind 必須時は icacls。コンテナ UID/GID 1000, `SIGNAL_CLI_CHOWN_ON_STARTUP=true`。
- ローテ: signal に REST トークンは無い。`signal-cli setPin`(登録ロック)。漏洩時は別端末でリンク解除→config 破棄→再リンク→PIN 再設定。

---

## 7. 実装詳細（環境変数・パス・依存ゼロ）

### 7.1 設定（.env / config.mjs）
```
SIGNAL_NUMBER=+8190XXXXXXXX        # linked した primary(スマホ)の番号
SIGNAL_API=http://127.0.0.1:8080
SIGNAL_WS=ws://127.0.0.1:8080
SIGNAL_UUID=<bot自身のUUID>        # エコー無視用
ALLOWED_UUIDS=<操作者UUID>[,<UUID2>...]
RC_CLAUDE_PATH=C:\Users\kaga\.local\bin\claude.exe
RC_WORKDIR=C:\Users\kaga\rc-workspace
TRIGGER_WORDS=リモコン,remote,rc,open
URL_WAIT_MS=15000
HARD_IDLE_TIMEOUT_MS=1800000
MAX_CONCURRENT=5
```

### 7.2 起動時ヘルスチェック（5項目 fail-fast / fail-closed）
1. claude.exe 実体: `fs.accessSync(RC_CLAUDE_PATH, X_OK)`。失敗→exit 1。
2. ログイン: `execFileSync(claude,['auth','status','--json'],{timeout:15000})` → `loggedIn===true && apiProvider==='firstParty'`(約300ms)。
3. trust: `~/.claude.json` の `projects[<WORKDIRをスラッシュ正規化 例 'C:/Users/kaga/rc-workspace'>].hasTrustDialogAccepted===true`（projects キーはスラッシュ格納のため `\`→`/`）。
4. Signal 到達: `GET /v1/health`=204 ＋ `GET /v1/about`=200 かつ `mode==='json-rpc'`（この項目のみ最大3回×2秒リトライ）。
5. 認可: `ALLOWED_UUIDS` 非空。空なら全許可の危険があるため exit 1(fail-closed)。
全通過後に受信ループ開始。検査ログに機密を出さない。

### 7.3 OS差分吸収（移植性）
- 二層: Signal 受信層(Docker)は全OS共通、bot 本体(native node)のみ OS 依存。
- claude 実行パス解決: (1)`RC_CLAUDE_PATH` → (2)OS別 native 既定。Win `path.join(os.homedir(),'.local','bin','claude.exe')`、mac/Linux/WSL `…/claude`。Homebrew/winget/npm 経路は `RC_CLAUDE_PATH` 明示必須。
- パス組立は `path.join`/`os.tmpdir()` で区切りをハードコードしない。WORKDIR は `RC_WORKDIR`(既定 `~/rc-workspace`)。
- trust(`~/.claude.json` 絶対パス単位)・claude.ai ログイン・signal-cli アカウントはマシン固有で非可搬→各環境で再取得/再リンク。

### 7.4 依存ゼロ方針
ネイティブ依存(windows-mutex/proper-lockfile/node-pty 等)は使わない。ロックは `fs.openSync(...,'wx')`、WS再接続・冪等化・ポーリング・監査ログ(JSON.stringify)はすべて標準モジュール。

### 7.5 モジュール構成
```
signal-rc-bot/
├ SPEC.md / README.md / research-*.md|json
├ package.json            # type:module, engines node>=22, dependencies なし
├ .env.example / .gitignore
├ docker-compose.yml      # signal-cli-rest-api(json-rpc) のみ
├ supervisor.ps1          # watchdog ラッパ
├ tasks/signal-rc-bot.xml # Task Scheduler 定義
└ src/
   ├ bot.mjs    # 束ね・ヘルスチェック・寿命管理・監査
   ├ signal.mjs # 受信WS/送信HTTP/allowlist（アダプタ：チャットアプリ依存はここだけ）
   ├ rc.mjs     # RC起動/抽出/kill/後始末（コア：チャットアプリ非依存）
   └ config.mjs # .env 読込・検証
```
主要 I/F:
```js
// signal.mjs
export function connect(onMessage)  // onMessage({sourceUuid, sourceNumber, text, ts})
export async function send(recipient, text)
// rc.mjs
export async function startSession(opts)  // → {ok:true,url,sessionId,pid} | {ok:false,reason,detail}
export function killSession(pid)
```

### 7.6 docker-compose.yml（signal 受信層のみ）
```yaml
services:
  signal-cli-rest-api:
    image: bbernhard/signal-cli-rest-api:latest
    container_name: signal-rc-api
    environment:
      - MODE=json-rpc
      - JSON_RPC_RECEIVE_MODE=manual
    ports: ["127.0.0.1:8080:8080"]
    volumes: ["signal-cli-config:/home/.local/share/signal-cli"]
    restart: unless-stopped
volumes:
  signal-cli-config:
```
> bot 本体は compose に含めない（claude を叩くためホスト native で動かす）。完全 Docker 化は §8 の将来オプション。

---

## 8. 再現性（バージョン回帰監視・将来の完全Docker化）

- claude 更新ごとに `remote-control --debug-file <tmp>` を短時間(例8秒) **2パターン**起動して回帰確認:
  (a)環境再利用状態、(b)bridge-pointer.json 削除の新規登録状態。両パターンで stdout からの URL 抽出(§4.3 優先1)が成立するか、新規登録時に debug-file アンカー(優先2)が出るか。
- 優先1(stdout)が両パターンで不一致になった場合のみクリティカルアラート（debug-file アンカーは補助）。
- 副生成物の生成先(tmp\ / WORKDIR / %TEMP%)変化、`--help` 実フラグ(`--sandbox` 有無等)、debug-file の redaction 維持も回帰確認。
- **完全 Docker 化（現時点非採用・将来オプション）** 採用時の必須前提: (1)pty 確保(tmux/`script -qfc` でラップ。生 exec 不可) (2)認証持込(`~/.claude/.credentials.json` ＋最小 `~/.claude.json`〈onboarding+trust〉、API キー/トークン系 env 除去) (3)操作対象=コンテナ内FS (4)Linux でも `Created initial session` 行を抽出（要実機検証）。

---

## 9. 前提条件

- claude(native install) 導入済み・**claude.ai でログイン済(firstParty)**・`WORKDIR` を trust 済み。
- Signal アカウントを signal-cli に **linked device** 登録済(番号=`SIGNAL_NUMBER`、captcha/専用SIM 不要)。
- Node.js 22+ がホストにある。Docker(signal-cli-rest-api 用)。
- 当面 Windows 11。Linux/mac へ再現する場合は `RC_CLAUDE_PATH` 等を差し替え。

---

## 10. 受け入れテスト

- [ ] 許可 UUID から「リモコン開いて」→ 15s 以内に `https://claude.ai/code/session_...` が返る。
- [ ] その URL をスマホで開くと当該マシンの RC セッションに接続でき操作できる。
- [ ] 許可外 UUID／グループ経由は完全に無反応。
- [ ] 返信後、tmp\ の debug-file・子 debug・bridge-transcript・bridge-pointer.json が残っていない。
- [ ] 連続依頼で旧 RC プロセスがリークしない（GC・上限・bot再起動時の一掃が機能）。
- [ ] bot を kill → supervisor が再起動 → 再び依頼が通る。
- [ ] signal-cli-rest-api コンテナ再起動後も受信が復帰する（subscribeReceive 再発行）。
- [ ] claude ログイン失効間近を検出して通知し、起動を抑止する。

---

## 11. 確定した主要パラメータ（早見表）

| 項目 | 値 |
|---|---|
| 起動 | `claude remote-control --spawn session --debug-file tmp\rc-<name>.log` |
| spawn | `{cwd:WORKDIR, shell:false, windowsHide:true, detached:false, stdio:['ignore','pipe','pipe']}` + env から API キー/トークン系 delete |
| 抽出優先1 | stdout(ANSI除去) `/https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+)/` |
| 抽出優先2 | debug `/\[bridge:init\] Created initial session (session_[A-Za-z0-9]+)/` |
| フレッシュ起動 | 起動前に `…\.claude\projects\<dir-key>\bridge-pointer.json` 削除 |
| 待機 | 100ms ポーリング / `URL_WAIT_MS=15000` |
| kill | `taskkill /PID <親pid> /T /F` ＋残存子孫掃除 |
| 寿命 | `HARD_IDLE_TIMEOUT=30分` / `MAX_CONCURRENT=5` / 30秒GC |
| allowlist | `sourceUuid` 完全一致のみ・グループ破棄・不一致は無言破棄 |
| 常駐 | supervisor.ps1(while) + Task Scheduler(ログオン時/遅延/InteractiveToken/ExecutionTimeLimit=PT0S) |
| permission | `--permission-mode` 明示せず(default=Ask) |

---

## 12. 未解決（要追加検証）

confidence=medium 以下・open_questions が残る項目。実装時/運用前に潰す。

- **no-console 起動方式**: 完全 no-console(S4U)で ConPTY(node-pty) が要るか、ログオンユーザーセッション内の実コンソール割当で済むか。生 spawn では stdin 非TTY で Ink 即死は確定。host 実機チェックリスト(S4U時 isatty、node-pty 起動可否/所要、conhost 窓非表示、孤児無し)で最終確定。依存ゼロと ConPTY が衝突する点が論点。
- **detached/windowsHide の窓フラッシュ**: 本SPECは detached:false で回避するが、当該 Node 版・当該 PC で窓が出ないことの実機確認が採用条件。
- **bridge-pointer 再利用の ageMs 上限**: 毎回削除方針なら影響しないが未確認。
- **linked device 登録の実機確認**: #651 再現有無、device_link_uri の正確パス、MODE=json-rpc のままリンク完了可否、失効条件。
- **JSON_RPC_RECEIVE_MODE=manual のマージ状況**: 現行リリースに正式マージ済みか。未マージなら on-start＋常駐で WS 切断最小化の代替。未配信保持期間・flush 順序も未確定。
- **レート制限の linked vs primary 差・閾値**: アカウント単位の振る舞いベースと推定するが未確証。429 でも配信済みケースの再現。
- **グループ groupId の base64 形式整合**: 受信 internal_id と送信 `group.` 形式の突合。mentions 欠落(#805)、WS接続直後バックログ挙動。
- **RC URL の bearer 性の最終確証**: 別アカウント/匿名ブラウザで session_xxx を開いた挙動、OAuth 正確な失効時間(約2日は issue ベース)、delete-for-everyone の対象範囲。
- **permission prompt のリモート伝播確実性**: #52084/#35637 が v2.1.158 Win native で再現するか、default 時の prompt 伝播確実性。
- **ゾンビ問題の修正状況**: #41024/#32982 が v2.1.158 で修正済みか。HARD_IDLE_TIMEOUT/MAX_CONCURRENT/サーバ側TTL の実測調整。
- **Task Scheduler 実機値**: ドメイン/ユーザ名・node.exe 実パス、InteractiveToken/LeastPrivilege で trust/ログイン資格情報が解決されるか、`ExecutionTimeLimit=PT0S` が Win11 26200 で無期限扱いか。
- **supervisor 二重保険**: supervisor 自身のクラッシュ復帰(繰返しトリガ＋IgnoreNew で十分か)、RC が10分ネット断で毎回 exit0 か、RDP切断/ロック時の継続。
- **ロックファイル stale 判定の異常終了テスト**: 強制kill時の残ロック回収、設置先(%LOCALAPPDATA% vs WORKDIR)。
- **トークン proactive リフレッシュ挙動**: 稼働中 access token を自前更新するか(>8h 観測で確定要)、オフライン時 auth status 挙動。
- **transcript の機微充填条件**: 会話進行時に token/secret が JSONL に平文で入るか(未送信時 0byte で未採取)、redaction が恒久仕様か版依存か、bridge-pointer 削除が --resume 再接続性に影響するか。
- **Docker化の Linux 実機検証**: Linux native の debug-file が同形式を出すか、script/tmux ラップで debug 出力正常か、v2.1.158 相当 Linux ビルド入手性。
- **運用パラメータ**: 監査ログ保持14日/日次ローテの妥当性、elapsed_ms 起点、send 失敗リトライ要否。
- **setup-token 系の除去対象 env 名の網羅**: RC を拒否させる正確なキー一覧。
