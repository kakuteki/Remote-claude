// adapters/fake.mjs — テスト/デモ用アダプタ（SNS不要）。
// stdin に入力した各行を「受信メッセージ」として扱い、返信は標準出力に表示する。
// 動作確認手順: ALLOWED_SENDERS=fake-user CHAT_ADAPTER=fake node src/index.mjs
//   起動後ターミナルで「リモコン」と入力 → RC が起動し URL が表示される。
// 新しい SNS アダプタを書く際の最小実装例にもなる。

export const meta = { name: "fake", requiredEnv: [] };

export function createAdapter() {
  const senderId = (process.env.FAKE_SENDER_ID || "fake-user").toLowerCase();
  return {
    name: "fake",
    async healthCheck() { return []; },
    start(onMessage) {
      console.error(`[fake] stdin から行を入力するとメッセージとして処理します（senderId=${senderId}）。例: リモコン`);
      let buf = "";
      const onData = (chunk) => {
        buf += chunk.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) Promise.resolve(onMessage({ senderId, senderName: "fake", text: line })).catch(e => console.error(e));
        }
      };
      process.stdin.on("data", onData);
      process.stdin.resume();
      return () => { try { process.stdin.off("data", onData); } catch {} };
    },
    async send(to, text) {
      console.log(`\n[fake reply → ${to}]\n${text}\n`);
      return { ok: true };
    },
  };
}
