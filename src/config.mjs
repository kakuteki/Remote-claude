// config.mjs — .env 読込・検証・起動時ヘルスチェック（依存ゼロ）。
// SPEC v2.0 §7.1 / §7.2 準拠。

import { execFileSync } from "node:child_process";
import { readFileSync, accessSync, constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// --- 最小 .env パーサ（KEY=VALUE / # コメント / 余分な引用符除去）---
function loadDotEnv(file) {
  let txt = "";
  try { txt = readFileSync(file, "utf8"); } catch { return; }
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
loadDotEnv(path.join(ROOT, ".env"));

// --- claude 実行体の解決: RC_CLAUDE_PATH → OS別 native 既定 ---
function resolveClaude() {
  if (process.env.RC_CLAUDE_PATH) return process.env.RC_CLAUDE_PATH;
  const home = os.homedir();
  return process.platform === "win32"
    ? path.join(home, ".local", "bin", "claude.exe")
    : path.join(home, ".local", "bin", "claude");
}

export const cfg = {
  root: ROOT,
  signalNumber: process.env.SIGNAL_NUMBER || "",
  signalUuid: (process.env.SIGNAL_UUID || "").toLowerCase(),
  allowedUuids: new Set(
    (process.env.ALLOWED_UUIDS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
  ),
  signalApi: (process.env.SIGNAL_API || "http://127.0.0.1:8080").replace(/\/+$/, ""),
  signalWs: (process.env.SIGNAL_WS || "ws://127.0.0.1:8080").replace(/\/+$/, ""),
  claudeExe: resolveClaude(),
  workdir: process.env.RC_WORKDIR || path.join(os.homedir(), "rc-workspace"),
  triggerWords: (process.env.TRIGGER_WORDS || "リモコン,remote,rc")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
  urlWaitMs: Number(process.env.URL_WAIT_MS || 15000),
  hardIdleTimeoutMs: Number(process.env.HARD_IDLE_TIMEOUT_MS || 1800000),
  maxConcurrent: Number(process.env.MAX_CONCURRENT || 5),
  sendTimeoutMs: Number(process.env.SEND_TIMEOUT_MS || 10000),
  tmpDir: path.join(process.env.RC_WORKDIR || path.join(os.homedir(), "rc-workspace"), "tmp"),
};

// WORKDIR を ~/.claude.json の projects キー形式（スラッシュ）に正規化
export function workdirProjectKey() {
  return cfg.workdir.replace(/\\/g, "/").replace(/\/+$/, "");
}

// bridge-pointer.json のパス（dir-key は WORKDIR の \ / : をすべて - 置換）
export function bridgePointerPath() {
  const dirKey = cfg.workdir.replace(/[\\/:]/g, "-").replace(/-+$/, "");
  return path.join(os.homedir(), ".claude", "projects", dirKey, "bridge-pointer.json");
}

async function httpGet(url, timeoutMs = 4000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return r;
}

// 起動時ヘルスチェック（fail-fast / fail-closed）。問題リストを返す（空なら OK）。
export async function healthCheck() {
  const problems = [];

  // 1. claude 実体
  try { accessSync(cfg.claudeExe, constants.X_OK); }
  catch { problems.push(`claude 実行体が見つかりません: ${cfg.claudeExe}（RC_CLAUDE_PATH を確認）`); }

  // 2. claude.ai ログイン（firstParty）
  if (!problems.length) {
    try {
      const out = execFileSync(cfg.claudeExe, ["auth", "status", "--json"], { timeout: 15000, encoding: "utf8" });
      const j = JSON.parse(out);
      if (!(j.loggedIn === true && (j.apiProvider === "firstParty" || j.authMethod === "claude.ai"))) {
        problems.push("claude.ai にログインしていません（API キー不可）。ホストで `claude` → `/login`（claude.ai）。");
      }
    } catch (e) {
      problems.push(`claude auth status 失敗: ${e.message}`);
    }
  }

  // 3. WORKDIR trust 承認
  try {
    const cj = JSON.parse(readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    const key = workdirProjectKey();
    const proj = cj.projects && (cj.projects[key] || cj.projects[cfg.workdir]);
    if (!(proj && proj.hasTrustDialogAccepted === true)) {
      problems.push(`WORKDIR が未 trust: ${cfg.workdir}（その dir で一度 \`claude\` を起動し承認）`);
    }
  } catch (e) {
    problems.push(`~/.claude.json 読込失敗: ${e.message}`);
  }

  // 4. Signal 到達（最大3回×2秒）
  let signalOk = false;
  for (let i = 0; i < 3 && !signalOk; i++) {
    try {
      const h = await httpGet(`${cfg.signalApi}/v1/health`, 3000);
      if (h.status === 204 || h.ok) signalOk = true;
    } catch { /* retry */ }
    if (!signalOk && i < 2) await new Promise(r => setTimeout(r, 2000));
  }
  if (!signalOk) problems.push(`signal-cli-rest-api に到達できません: ${cfg.signalApi}（docker compose up を確認）`);

  // 5. 認可（fail-closed）
  if (cfg.allowedUuids.size === 0) {
    problems.push("ALLOWED_UUIDS が空です（全送信者許可になり危険なので起動を中止）。");
  }
  if (!cfg.signalNumber) problems.push("SIGNAL_NUMBER が未設定です。");

  return problems;
}
