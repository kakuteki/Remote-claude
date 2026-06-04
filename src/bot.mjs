// bot.mjs — 統合エントリ。受信→allowlist(signal側)→トリガ→RC起動→URL返信。
// 寿命管理・多重起動防止・監査ログ。SPEC v2.0 §5 / §6.4-6.5 準拠。依存ゼロ。

import { mkdirSync, appendFileSync, openSync, writeSync, closeSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { cfg, healthCheck } from "./config.mjs";
import { connect, send } from "./signal.mjs";
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
    const fd = openSync(lockPath, "wx");                       // O_CREAT|O_EXCL
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    closeSync(fd);
    return lockPath;
  } catch (e) {
    if (e.code === "EEXIST") {
      try {
        const old = JSON.parse(readFileSync(lockPath, "utf8"));
        try { process.kill(old.pid, 0); console.error(`既に起動中です pid=${old.pid}。終了します。`); process.exit(1); }
        catch { rmSync(lockPath, { force: true }); return acquireLock(); }   // 残骸→再取得
      } catch { rmSync(lockPath, { force: true }); return acquireLock(); }
    }
    throw e;
  }
}

// ---- 監査ログ（機密を残さない）----
const reqId = (uuid) => `${uuid.slice(0, 8)}/${createHash("sha256").update(uuid).digest("hex").slice(0, 8)}`;
function audit(rec, outcome, reason, pid, elapsedMs) {
  try {
    mkdirSync(cfg.tmpDir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(), requester: reqId(rec.sourceUuid), trigger: "rc",
      outcome, reason: reason || "", pid: pid || null, elapsed_ms: elapsedMs ?? null,
    });
    appendFileSync(path.join(cfg.tmpDir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`), line + "\n");
  } catch { /* best-effort */ }
}

// ---- RC セッション・レジストリ（寿命管理）----
const registry = new Map(); // pid -> { pid, sessionId, startedAt, lastActivity }

function gc() {
  const now = Date.now();
  for (const [pid, e] of registry) {
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }      // 消滅検出
    if (!alive) { registry.delete(pid); continue; }
    if (now - e.lastActivity > cfg.hardIdleTimeoutMs) {         // アイドル超過→kill
      killSession(pid); registry.delete(pid);
      console.error(`[gc] idle timeout kill pid=${pid}`);
    }
  }
}

// 返信先: 許可済み操作者へ返す（案A=bot専用アカウント。allowlistで担保）。番号→無ければUUID宛。
function replyTarget(rec) { return rec.sourceNumber || rec.sourceUuid; }

function isTrigger(text) {
  const t = text.toLowerCase();
  return cfg.triggerWords.some(w => t.includes(w));
}

async function handle(rec) {
  if (!isTrigger(rec.text)) return;                            // RC専用bot: トリガ以外は無視
  const target = replyTarget(rec);
  const t0 = Date.now();

  if (registry.size >= cfg.maxConcurrent) {
    await send(target, "起動中のセッションが上限に達しています。少し待って再度お試しください。");
    audit(rec, "ng", "limit", null, Date.now() - t0);
    return;
  }

  const res = await startSession();
  if (res.ok) {
    registry.set(res.pid, { pid: res.pid, sessionId: res.sessionId, startedAt: Date.now(), lastActivity: Date.now() });
    const s = await send(target, res.url);                     // 成功返信は URL 1行のみ
    audit(rec, s.ok ? "ok" : "ng", s.ok ? "" : "send", res.pid, Date.now() - t0);
    if (!s.ok) console.error("[bot] URL送信失敗:", s.error);   // 送信失敗はユーザーに返せずログのみ
  } else {
    await send(target, res.message || "起動に失敗しました。PC側のログを確認してください。");
    audit(rec, "ng", res.reason, null, Date.now() - t0);
  }
}

// ---- 起動 ----
const healthOnly = process.argv.includes("--health-only");

const problems = await healthCheck();
if (problems.length) {
  console.error("ヘルスチェック失敗:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.error("ヘルスチェック OK");
if (healthOnly) process.exit(0);

const lockPath = acquireLock();
const gcTimer = setInterval(gc, 30000);
const stop = connect(handle);
console.error(`signal-rc-bot 起動完了 (number=${cfg.signalNumber}, allow=${cfg.allowedUuids.size}件, workdir=${cfg.workdir})`);

function shutdown() {
  try { clearInterval(gcTimer); } catch {}
  try { stop && stop(); } catch {}
  for (const e of registry.values()) killSession(e.pid);       // 孤児ゾンビ防止
  try { rmSync(lockPath, { force: true }); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (e) => { console.error("uncaughtException:", e); shutdown(); });
