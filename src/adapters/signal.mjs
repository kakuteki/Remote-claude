// adapters/signal.mjs — Signal アダプタ（ChatAdapter 規約の実装）。
// signal-cli-rest-api（json-rpc, WS受信 / HTTP送信）を使う。依存ゼロ。
// チャットアプリ固有はこのファイルに閉じる（コアは src/core/ で非依存）。
//
// 必要 env: SIGNAL_NUMBER（必須）, SIGNAL_API, SIGNAL_WS, SEND_TIMEOUT_MS（任意）
// senderId = envelope.sourceUuid（小文字UUID）。allowlist 照合はコア側で行う。

export const meta = { name: "signal", requiredEnv: ["SIGNAL_NUMBER"] };

export function createAdapter() {
  const NUMBER = process.env.SIGNAL_NUMBER || "";
  const API = (process.env.SIGNAL_API || "http://127.0.0.1:8081").replace(/\/+$/, "");
  const WS = (process.env.SIGNAL_WS || "ws://127.0.0.1:8081").replace(/\/+$/, "");
  const SEND_TIMEOUT = Number(process.env.SEND_TIMEOUT_MS || 10000);

  // 冪等化（再接続replay/重複の排除）
  const SEEN_MAX = 1000;
  const seen = new Set();
  const seenOrder = [];
  const markSeen = (key) => {
    if (seen.has(key)) return false;
    seen.add(key); seenOrder.push(key);
    if (seenOrder.length > SEEN_MAX) seen.delete(seenOrder.shift());
    return true;
  };

  // envelope → 正規化メッセージ or null（非dataMessage/グループは破棄）
  const interpret = (obj) => {
    const env = obj && obj.envelope;
    if (!env) return null;
    const dm = env.dataMessage;
    if (!dm || typeof dm.message !== "string" || dm.message.trim() === "") return null;
    if (dm.groupInfo) return null;                       // グループ経由は破棄（第三者同席防止）
    const senderId = (env.sourceUuid || env.source || "").toLowerCase();
    if (!senderId) return null;
    if (env.timestamp != null && !markSeen(`${senderId}:${env.timestamp}`)) return null;
    return { senderId, senderName: env.sourceName || "", text: dm.message.trim() };
  };

  return {
    name: "signal",

    async healthCheck() {
      const problems = [];
      if (!NUMBER) problems.push("SIGNAL_NUMBER が未設定です。");
      try {
        const r = await fetch(`${API}/v1/about`, { signal: AbortSignal.timeout(4000) });
        const j = await r.json();
        if (j.mode !== "json-rpc") problems.push(`signal-cli-rest-api が json-rpc モードではありません (mode=${j.mode})。`);
      } catch (e) {
        problems.push(`signal-cli-rest-api に到達できません: ${API}（${e.message}）`);
      }
      return problems;
    },

    // 受信WS購読。許可前の全本文メッセージを onMessage に渡す（allowlistはコア）。戻り値=停止関数。
    start(onMessage) {
      const url = `${WS}/v1/receive/${encodeURIComponent(NUMBER)}`;
      let sock = null, closedByUser = false, attempt = 0, reconnectTimer = null;

      const backoffMs = () => Math.round(Math.min(30000, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4));
      const scheduleReconnect = () => {
        if (closedByUser || reconnectTimer) return;
        const wait = backoffMs(); attempt++;
        reconnectTimer = setTimeout(() => { reconnectTimer = null; open(); }, wait);
      };
      const open = () => {
        try { sock = new WebSocket(url); }
        catch (e) { console.error("[signal] WS作成失敗:", e.message); return scheduleReconnect(); }
        sock.addEventListener("open", () => { attempt = 0; console.error("[signal] LISTENING", url); });
        sock.addEventListener("error", (e) => console.error("[signal] WS_ERR", e?.message || e?.type || "error"));
        sock.addEventListener("close", () => { console.error("[signal] WS_CLOSED"); scheduleReconnect(); });
        sock.addEventListener("message", (ev) => {
          let obj; try { obj = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); } catch { return; }
          let msg; try { msg = interpret(obj); } catch (e) { console.error("[signal] interpret err", e.message); return; }
          if (msg && onMessage) Promise.resolve(onMessage(msg)).catch(e => console.error("[signal] handler err", e.message));
        });
      };
      open();
      return () => {
        closedByUser = true;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        try { sock && sock.close(); } catch {}
      };
    },

    // senderId（sourceUuid or 番号）宛にテキスト送信。
    async send(senderId, text) {
      const payload = JSON.stringify({ message: String(text), number: NUMBER, recipients: [senderId], text_mode: "normal" });
      let r;
      try {
        r = await fetch(`${API}/v2/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: Buffer.from(payload, "utf8"),
          signal: AbortSignal.timeout(SEND_TIMEOUT),
        });
      } catch (e) {
        const why = e?.name === "TimeoutError" ? `timeout(${SEND_TIMEOUT}ms)` : (e?.message || String(e));
        return { ok: false, error: `network/${why}` };
      }
      if (!r.ok) { const t = await r.text().catch(() => ""); return { ok: false, error: `${r.status}: ${t.slice(0, 200)}` }; }
      const data = await r.json().catch(() => ({}));
      return { ok: true, ts: data.timestamp || "" };
    },
  };
}
