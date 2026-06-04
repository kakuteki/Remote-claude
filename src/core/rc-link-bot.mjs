// core/rc-link-bot.mjs — 汎用オーケストレータ（チャットアプリ非依存）。
// 任意の ChatAdapter を注入して動く: 受信→allowlist→トリガ→RC起動→URL返信。
// 寿命管理・多重起動防止・監査ログ。SPEC v2.0 §5/§6 準拠。

import { mkdirSync, appendFileSync, openSync, writeSync, closeSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { cfg, coreHealthCheck } from "../config.mjs";
import { startSession, killSession } from "./rc.mjs";

// ---- 多重起動防止（O_EXCL ロック）----
function lockDir() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "signal-rc-bot");
}
function acquireLock() {
  const dir = lockDir();
  mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, "bot.lock");
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    closeSync(fd);
    return lockPath;
  } catch (e) {
    if (e.code === "EEXIST") {
      try {
        const old = JSON.parse(readFileSync(lockPath, "utf8"));
        try { process.kill(old.pid, 0); console.error(`既に起動中です pid=${old.pid}。終了します。`); process.exit(1); }
        catch { rmSync(lockPath, { force: true }); return acquireLock(); }
      } catch { rmSync(lockPath, { force: true }); return acquireLock(); }
    }
    throw e;
  }
}

// ---- 監査ログ（機密を残さない）----
const reqId = (id) => {
  const s = String(id);
  return `${s.slice(0, 8)}/${createHash("sha256").update(s).digest("hex").slice(0, 8)}`;
};
function audit(adapterName, msg, outcome, reason, pid, elapsedMs) {
  try {
    mkdirSync(cfg.tmpDir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(), adapter: adapterName, requester: reqId(msg.senderId), trigger: "rc",
      outcome, reason: reason || "", pid: pid || null, elapsed_ms: elapsedMs ?? null,
    });
    appendFileSync(path.join(cfg.tmpDir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`), line + "\n");
  } catch { /* best-effort */ }
}

function isTrigger(text) {
  const t = String(text || "").toLowerCase();
  return cfg.triggerWords.some(w => t.includes(w));
}
function isAllowed(senderId) {
  return cfg.allowedSenders.has(String(senderId).toLowerCase());
}

// adapter: { name, healthCheck(), start(onMessage)->stopFn, send(senderId, text) }
export async function run(adapter, { healthOnly = false } = {}) {
  // ヘルスチェック（コア + アダプタ固有）
  const problems = [...coreHealthCheck(), ...(await adapter.healthCheck().catch(e => [`adapter healthCheck 例外: ${e.message}`]))];
  if (problems.length) {
    console.error("ヘルスチェック失敗:");
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }
  console.error(`ヘルスチェック OK (adapter=${adapter.name})`);
  if (healthOnly) process.exit(0);

  const lockPath = acquireLock();
  const registry = new Map(); // pid -> { pid, sessionId, startedAt, lastActivity }

  const gc = () => {
    const now = Date.now();
    for (const [pid, e] of registry) {
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      if (!alive) { registry.delete(pid); continue; }
      if (now - e.lastActivity > cfg.hardIdleTimeoutMs) {
        killSession(pid); registry.delete(pid);
        console.error(`[gc] idle timeout kill pid=${pid}`);
      }
    }
  };
  const gcTimer = setInterval(gc, 30000);

  async function handle(msg) {
    if (!msg || !isTrigger(msg.text)) return;
    if (!isAllowed(msg.senderId)) return;             // allowlist 不一致は無言破棄
    const t0 = Date.now();

    if (registry.size >= cfg.maxConcurrent) {
      await adapter.send(msg.senderId, "起動中のセッションが上限に達しています。少し待って再度お試しください。");
      audit(adapter.name, msg, "ng", "limit", null, Date.now() - t0);
      return;
    }

    const res = await startSession();
    if (res.ok) {
      registry.set(res.pid, { pid: res.pid, sessionId: res.sessionId, startedAt: Date.now(), lastActivity: Date.now() });
      const s = await adapter.send(msg.senderId, res.url);   // 成功返信は URL 1行のみ
      audit(adapter.name, msg, s.ok ? "ok" : "ng", s.ok ? "" : "send", res.pid, Date.now() - t0);
      if (!s.ok) console.error("[bot] URL送信失敗:", s.error);
    } else {
      await adapter.send(msg.senderId, res.message || "起動に失敗しました。ログを確認してください。");
      audit(adapter.name, msg, "ng", res.reason, null, Date.now() - t0);
    }
  }

  const stop = await adapter.start(handle);
  console.error(`signal-rc-bot 起動完了 (adapter=${adapter.name}, allow=${cfg.allowedSenders.size}件, workdir=${cfg.workdir})`);

  function shutdown() {
    try { clearInterval(gcTimer); } catch {}
    try { stop && stop(); } catch {}
    for (const e of registry.values()) killSession(e.pid);   // 孤児ゾンビ防止
    try { rmSync(lockPath, { force: true }); } catch {}
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (e) => { console.error("uncaughtException:", e); shutdown(); });
}
