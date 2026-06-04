// signal.mjs — Signal アダプタ（受信WS / 送信HTTP / allowlist）。
// チャットアプリ依存はこのファイルだけ。SPEC v2.0 §3 / §6.1 準拠。
// 受信方式は既存 signal-cli-test/receiver.mjs（signal-cli-rest-api json-rpc WS）を踏襲。
// 依存ゼロ（Node22+ の global WebSocket / fetch）。

import { cfg } from "./config.mjs";

// --- 冪等化（再接続replay/重複の排除）: サイズ上限つき LRU ---
const SEEN_MAX = 1000;
const seen = new Set();
const seenOrder = [];
function markSeen(key) {
  if (seen.has(key)) return false;
  seen.add(key); seenOrder.push(key);
  if (seenOrder.length > SEEN_MAX) { const old = seenOrder.shift(); seen.delete(old); }
  return true;
}

// envelope を解釈し、処理対象（許可済み・個別宛・本文あり）なら正規化レコードを返す。それ以外は null。
function interpret(obj) {
  const env = obj && obj.envelope;
  if (!env) return null;

  const dm = env.dataMessage;
  if (!dm || typeof dm.message !== "string" || dm.message.trim() === "") return null; // sync/receipt/typing/call/edit を破棄
  if (dm.groupInfo) return null;                                  // §6.1: グループ経由は破棄（第三者同席による漏洩防止）

  const sourceUuid = (env.sourceUuid || env.source || "").toLowerCase();
  if (!sourceUuid) return null;
  if (!cfg.allowedUuids.has(sourceUuid)) return null;             // allowlist 不一致は無言破棄

  const ts = env.timestamp;
  if (ts != null && !markSeen(`${sourceUuid}:${ts}:data`)) return null;  // 重複

  return {
    sourceUuid,
    sourceNumber: env.sourceNumber || env.source || null,
    sourceName: env.sourceName || "",
    text: dm.message.trim(),
    ts,
  };
}

// 受信WS購読。許可済みレコードごとに onMessage(rec) を呼ぶ。戻り値は購読停止関数。
export function connect(onMessage) {
  const url = `${cfg.signalWs}/v1/receive/${encodeURIComponent(cfg.signalNumber)}`;
  let sock = null;
  let closedByUser = false;
  let attempt = 0;
  let reconnectTimer = null;

  const backoffMs = () => {
    const base = Math.min(30000, 1000 * Math.pow(2, attempt)); // 1s,2s,4s,...,30s
    const jitter = base * (0.8 + Math.random() * 0.4);          // ±20%
    return Math.round(jitter);
  };

  const scheduleReconnect = () => {
    if (closedByUser || reconnectTimer) return;
    const wait = backoffMs();
    attempt++;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; open(); }, wait);
  };

  const open = () => {
    try { sock = new WebSocket(url); }
    catch (e) { console.error("[signal] WS 作成失敗:", e.message); return scheduleReconnect(); }

    sock.addEventListener("open", () => { attempt = 0; console.error("[signal] LISTENING", url); });
    sock.addEventListener("error", (e) => console.error("[signal] WS_ERR", e?.message || e?.type || "error"));
    sock.addEventListener("close", () => { console.error("[signal] WS_CLOSED"); scheduleReconnect(); });
    sock.addEventListener("message", (ev) => {
      let obj;
      try { obj = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); }
      catch { return; }
      let rec;
      try { rec = interpret(obj); } catch (e) { console.error("[signal] interpret err", e.message); return; }
      if (rec && onMessage) Promise.resolve(onMessage(rec)).catch(e => console.error("[signal] handler err", e.message));
    });
  };

  open();
  return () => {
    closedByUser = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try { sock && sock.close(); } catch {}
  };
}

// 任意テキストを送信（/v2/send）。成功で {ok:true, ts}、失敗で {ok:false, error}。
export async function send(recipient, text) {
  const payload = JSON.stringify({
    message: String(text),
    number: cfg.signalNumber,
    recipients: [recipient],
    text_mode: "normal",
  });
  let r;
  try {
    r = await fetch(`${cfg.signalApi}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: Buffer.from(payload, "utf8"),
      signal: AbortSignal.timeout(cfg.sendTimeoutMs),
    });
  } catch (e) {
    const why = e?.name === "TimeoutError" ? `timeout(${cfg.sendTimeoutMs}ms)` : (e?.message || String(e));
    return { ok: false, error: `network/${why}` };
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return { ok: false, error: `${r.status}: ${t.slice(0, 200)}` };
  }
  const data = await r.json().catch(() => ({}));
  return { ok: true, ts: data.timestamp || "" };
}
