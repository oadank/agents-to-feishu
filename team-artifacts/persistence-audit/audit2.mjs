import { execFileSync } from "node:child_process";
import fs from "fs";
const CLI = "C:/Users/oadan/AppData/Roaming/npm/lark-cli.cmd";
const nssm = (a2) => { try { return execFileSync("C:/D/opt/nssm/nssm.exe", a2, { encoding: "utf8" }); } catch { return ""; } };
const run = (a) => { try { return execFileSync(CLI, a, { encoding: "utf8", maxBuffer: 3e7, shell: true }); } catch (e) { return String(e.stdout || ""); } };
const chats = JSON.parse(fs.readFileSync("logs/chats-map.json", "utf8"));
chats.dsh = "oc_bb907084f5d95404e29d3f0bde5a768b";
delete chats.mimo; // 已定A
const kill = { openakita: ["openakita-serve"] };
const ts = (s) => Date.parse(s.replace(" ", "T") + "+08:00");
const lastApp = (chat, afterMs) => {
  const raw = run(["im", "+chat-messages-list", "--chat-id", chat, "--order", "desc", "--page-size", "4", "--as", "user"]);
  let j; try { j = JSON.parse(raw.slice(raw.indexOf("{"))); } catch { return null; }
  for (const m of j.data?.messages || []) if (m.sender?.sender_type === "app" && ts(m.create_time) > afterMs) return (m.content || "").replace(/\\u003c/g, "<").replace(/\\n/g, " ");
  return null;
};
const wait = async (chat, t0, maxS) => { for (let i = 0; i < maxS / 5; i++) { await new Promise(s => setTimeout(s, 5000)); const t = lastApp(chat, t0); if (t) return t; } return null; };
const out = {};
const save = () => fs.writeFileSync("team-artifacts/persistence-audit/result.json", JSON.stringify(out, null, 2));
for (const [bot, chat] of Object.entries(chats)) {
  const word = "暗号" + bot.toUpperCase();
  try {
    const t0 = Date.now() - 3000;
    run(["im", "+messages-send", "--chat-id", chat, "--text", `记住暗号：${word}。只回四个字以内确认`, "--as", "user"]);
    const r1 = await wait(chat, t0, 110);
    if (!r1) { out[bot] = "FAIL 埋雷无回复(真哑巴)"; save(); continue; }
    nssm(["restart", bot]); for (const e of (kill[bot] || [])) nssm(["restart", e]);
    await new Promise(s => setTimeout(s, 22000));
    const t1 = Date.now() - 3000;
    run(["im", "+messages-send", "--chat-id", chat, "--text", "暗号是什么？只回暗号本身", "--as", "user"]);
    const r2 = await wait(chat, t1, 130);
    if (!r2) { out[bot] = "FAIL 追问无回复"; save(); continue; }
    out[bot] = r2.includes(word) ? "A 原生持久化：杀桥仍记得" : /自动新建|会话丢失|🆕/.test(r2.text || r2) ? "B 合规：忘但有自动/new卡" : "C 违规：忘且装死 [" + r2.slice(0, 60) + "]";
    console.log("RESULT", bot, out[bot]); save();
  } catch (e) { out[bot] = "ERR " + String(e.message).slice(0, 60); save(); }
}
console.log("ALLDONE");
