// rc.mjs — claude remote-control を起動し session URL を抽出して返すコア（チャットアプリ非依存）。
// SPEC v2.0 §4 / §6.3 準拠。実機検証(v2.1.158)に基づく。
//
// API:
//   startSession() -> { ok:true, url, sessionId, pid } | { ok:false, reason, message, detail }
//   killSession(pid)
//   cleanupArtifacts(name)         // 機微ファイル4種の後始末

import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync, statSync, writeFileSync, rmSync, readdirSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { cfg, bridgePointerPath } from "./config.mjs";

const RE_STDOUT = /https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+)/;
const RE_DBG_PRIMARY = /\[bridge:init\] Created initial session (session_[A-Za-z0-9]+)/;
const RE_DBG_FB1 = /\[bridge\] Fetching session (session_[A-Za-z0-9]+)/;
const RE_DBG_FB2 = /server title for (session_[A-Za-z0-9]+)/;

// 異常系判別テーブル（stdout+stderr マージへの部分一致）。SPEC §4.7。
const ERROR_RULES = [
  { reason: "apikey", re: /ANTHROPIC_API_KEY is set|Remote Control (requires|is disabled).*(subscription|organization's policy)/i,
    message: "APIキー認証になっています。ANTHROPIC_API_KEY 等を外し、ホストで `claude`→`/login`（claude.ai）で再ログインして再起動してください。" },
  { reason: "token", re: /requires a full-scope login token/i,
    message: "setup-token/長命トークンでは不可です。ホストで `claude`→`/login`（claude.ai）で再ログインしてください。" },
  { reason: "auth", re: /Authentication failed \(401\)|Remote Control session expired|Access denied/i,
    message: "ログインが切れています。ホストで `claude auth login`（失敗時は logout 後に login）してから再送してください。" },
  { reason: "login", re: /requires a claude\.ai subscription|Unable to determine your organization/i,
    message: "claude.ai に未ログインです。ホストで `claude`→`/login`（claude.ai）してください。" },
  { reason: "network", re: /Remote credentials fetch failed|Session creation failed/i,
    message: "ネットワークか認証取得に失敗しました。Anthropic API(443) への接続を確認して再送してください。" },
  { reason: "trust", re: /Workspace not trusted/i,
    message: "作業ディレクトリが未承認です。ホストで対象 dir で一度 `claude` を実行し trust を承認してください。" },
  { reason: "eligibility", re: /not yet enabled for your account/i,
    message: "このアカウントでは Remote Control が未有効です（環境変数や組織設定を確認）。" },
];

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const RC_ENV_STRIP = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

function secureDelete(file) {
  try {
    if (!existsSync(file)) return;
    const sz = statSync(file).size;
    if (sz > 0) { try { writeFileSync(file, Buffer.alloc(sz, 0)); } catch {} }
    rmSync(file, { force: true });
  } catch {}
}

// 機微ファイル4種を後始末。親debugから子debug/transcriptの実パスを拾い、glob保険も走らせる。
export function cleanupArtifacts(name, debugFile) {
  // 親debug から Debug log: / Transcript log: の実パスを取得
  try {
    if (debugFile && existsSync(debugFile)) {
      const txt = (() => { try { return readFileSync(debugFile, "utf8"); } catch { return ""; } })();
      for (const re of [/Debug log:\s*(.+)/i, /Transcript log:\s*(.+)/i]) {
        const m = txt.match(re);
        if (m) secureDelete(m[1].trim());
      }
    }
  } catch {}
  // 親debug
  if (debugFile) secureDelete(debugFile);
  // glob 保険: tmp\rc-<name>-cse_*.log
  try {
    for (const f of readdirSync(cfg.tmpDir)) {
      if (name && f.startsWith(`rc-${name}`) && f.endsWith(".log")) secureDelete(path.join(cfg.tmpDir, f));
    }
  } catch {}
  // glob 保険: HOME 直下の bridge-transcript-cse_*.jsonl（単発運用前提で全消し）
  try {
    const home = os.homedir();
    for (const f of readdirSync(home)) {
      if (/^bridge-transcript-cse_.*\.jsonl$/.test(f)) secureDelete(path.join(home, f));
    }
  } catch {}
  // bridge-pointer.json（stale 残置）
  secureDelete(bridgePointerPath());
}

// 残存子孫の掃除（taskkill /T の補強）。本体pid を親に持つ claude.exe/conhost.exe を個別kill。
function sweepDescendants(rootPid) {
  if (process.platform !== "win32") return;
  try {
    const ps = `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${rootPid} -and ($_.Name -eq 'claude.exe' -or $_.Name -eq 'conhost.exe') } | ForEach-Object { taskkill /PID $_.ProcessId /F 2>$null }`;
    spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { timeout: 8000 });
  } catch {}
}

export function killSession(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 8000 });
      sweepDescendants(pid);
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  } catch {}
}

export async function startSession() {
  mkdirSync(cfg.tmpDir, { recursive: true });

  // §4.4 フレッシュ起動の強制: bridge-pointer.json を削除
  secureDelete(bridgePointerPath());

  const name = `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const debugFile = path.join(cfg.tmpDir, `rc-${name}.log`);

  const env = { ...process.env };
  for (const k of RC_ENV_STRIP) delete env[k];

  const args = ["remote-control", "--spawn", "session", "--name", name, "--debug-file", debugFile];
  let proc;
  try {
    proc = spawn(cfg.claudeExe, args, {
      cwd: cfg.workdir, env, shell: false, windowsHide: true, detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    cleanupArtifacts(name, debugFile);
    return { ok: false, reason: "spawn", message: "claude を起動できませんでした。PC側のログイン状態を確認してください。", detail: e.message };
  }
  if (!proc.pid) {
    cleanupArtifacts(name, debugFile);
    return { ok: false, reason: "spawn", message: "claude を起動できませんでした。", detail: "no pid" };
  }
  const pid = proc.pid;

  let stdoutBuf = "", stderrBuf = "";
  proc.stdout.on("data", d => { stdoutBuf += d.toString("utf8"); });
  proc.stderr.on("data", d => { stderrBuf += d.toString("utf8"); });

  const startedAt = Date.now();

  return await new Promise((resolve) => {
    let done = false;
    const finishOk = (sessionId) => {
      if (done) return; done = true;
      clearInterval(timer);
      cleanupArtifacts(name, debugFile);              // 成功でも debug は消す（プロセスは生かす）
      resolve({ ok: true, url: `https://claude.ai/code/${sessionId}`, sessionId, pid });
    };
    const finishErr = (reason, message, detail) => {
      if (done) return; done = true;
      clearInterval(timer);
      killSession(pid);
      cleanupArtifacts(name, debugFile);
      resolve({ ok: false, reason, message, detail });
    };
    const classifyError = (extra) => {
      const hay = stdoutBuf + "\n" + stderrBuf;
      for (const rule of ERROR_RULES) if (rule.re.test(hay)) return finishErr(rule.reason, rule.message, extra);
      return null;
    };

    proc.on("error", (e) => finishErr("spawn", "claude を起動できませんでした。PC側のログイン状態を確認してください。", e.message));
    proc.on("exit", (code) => {
      // URL 未検出のままプロセス終了 → trust/認証等の即時失敗
      if (done) return;
      if (classifyError(`exit ${code}`)) return;
      finishErr("error", "RC起動に失敗しました。PC側のログを確認してください。", `exit ${code}; ${(stderrBuf || stdoutBuf).slice(-400)}`);
    });

    const timer = setInterval(async () => {
      // §4.3 抽出優先1: stdout（ANSI除去後）
      let m = stripAnsi(stdoutBuf).match(RE_STDOUT);
      // 優先2-4: debug-file
      if (!m) {
        try {
          const dbg = await readFile(debugFile, "utf8");
          m = dbg.match(RE_DBG_PRIMARY) || dbg.match(RE_DBG_FB1) || dbg.match(RE_DBG_FB2);
        } catch { /* ENOENT 等は無視 */ }
      }
      if (m) return finishOk(m[1]);

      // 異常系
      if (classifyError("polling")) return;

      // ハードタイムアウト
      if (Date.now() - startedAt > cfg.urlWaitMs) {
        return finishErr("timeout", "起動がタイムアウトしました。もう一度お試しください。", `>${cfg.urlWaitMs}ms`);
      }
    }, 100);
  });
}

// --- CLI: node src/rc.mjs で1回起動→URL表示→即kill（PoC/動作確認用）---
const isCLI = process.argv[1] && path.resolve(process.argv[1]).replace(/\\/g, "/").endsWith("/src/rc.mjs");
if (isCLI) {
  const res = await startSession();
  if (res.ok) {
    console.log("OK url=", res.url, "pid=", res.pid);
    console.log("(動作確認のため5秒後に kill します)");
    setTimeout(() => { killSession(res.pid); console.log("killed", res.pid); process.exit(0); }, 5000);
  } else {
    console.error("NG reason=", res.reason, "msg=", res.message, "detail=", res.detail);
    process.exit(1);
  }
}
