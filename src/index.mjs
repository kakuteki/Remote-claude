// index.mjs — エントリ。CHAT_ADAPTER で adapters/<name>.mjs を選び、コアに注入して起動する。
// 使い方:
//   node src/index.mjs                 # .env の CHAT_ADAPTER（既定 signal）で起動
//   node src/index.mjs --health-only   # ヘルスチェックのみ
//   CHAT_ADAPTER=fake node src/index.mjs   # SNS不要のテスト

import { cfg } from "./config.mjs";
import { run } from "./core/rc-link-bot.mjs";

const healthOnly = process.argv.includes("--health-only");

let mod;
try {
  mod = await import(`./adapters/${cfg.adapter}.mjs`);
} catch (e) {
  console.error(`アダプタ '${cfg.adapter}' を読み込めません（src/adapters/${cfg.adapter}.mjs）: ${e.message}`);
  process.exit(1);
}
if (typeof mod.createAdapter !== "function") {
  console.error(`アダプタ '${cfg.adapter}' が createAdapter(cfg) を export していません。`);
  process.exit(1);
}

const adapter = mod.createAdapter(cfg);
await run(adapter, { healthOnly });
