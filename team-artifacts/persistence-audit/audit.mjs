import { execFileSync } from "node:child_process";
import fs from "fs";
const CLI = "C:/Users/oadan/AppData/Roaming/npm/lark-cli.cmd";
const run = (a) => { try { return execFileSync(CLI, a, { encoding: "utf8", maxBuffer: 3e7, shell: true }); } catch (e) { return String(e.stdout || "") + String(e.stderr || ""); } };
const nssm = (a2) => { try { return execFileSync("C:/D/opt/nssm/nssm.exe", a2, { encoding: "utf8" }); } catch { return ""; } };
const chats = JSON.parse(fs.readFileSync("logs/chats-map.json", "utf8"));
chats.dsh = "oc_bb907084f5d95404e29d3f0bde5a768b";
delete chats.mimo; // 已定 A 类（三连杀全记得）
const kill = { openakita: ["openakita-serve"] };
const lastApp = (chat, afterMs) => {
  const raw = run(["im", "+chat-messages-list", "--chat-id", chat, "--order", "desc", "--page-size", "4", "--as", "user"]);
  if (!raw.includes("create_time")) return { err: raw.slice(raw.indexOf("message") + 9, raw.indexOf("message") + 70) };
  const blocks = [...raw.matchAll(/"content":\s*"((?:[^"\\]|\\.)*?)"[\s\S]{0,900}?"create_time":\s*"([^"]+)"[\s\S]{0,600}?"sender_type":\s*"app"/g)];
  for (const b of blocks) { const t = Date.parse(b[2].replace(" ", "T") + "+08:00"); if (t > afterMs) return { text: JSON.parse('"' + b[1] + '"') }; }
  return null;
};
const wait = async (chat, t0, maxS) => { for (let i = 0; i < maxS / 5; i++) { await new Promise(s => setTimeout(s, 5000)); const r = lastApp(chat, t0); if (r && r.text) return r; if (r && r.err) return { err: r.err }; } return null; };
const out = {};
const save = () => fs.writeFileSync("team-artifacts/persistence-audit/result.json", JSON.stringify(out, null, 2));
for (const [bot, chat] of Object.entries(chats)) {
  const word = "暗号" + bot.toUpperCase();
  try {
    const t0 = Date.now() - 3000;
    run(["im", "+messages-send", "--chat-id", chat, "--text", `记住暗号：${word}。只回四个字以内确认`, "--as", "user"]);
    const r1 = await wait(chat, t0, 110);
    if (!r1 || r1.err) { out[bot] = "FAIL埋雷 " + (r1?.err || "无回复"); save(); continue; }
    nssm(["restart", bot]); for (const e of (kill[bot] || [])) nssm(["restart", e]);
    await new Promise(s => setTimeout(s, 22000));
    const t1 = Date.now() - 3000;
    run(["im", "+messages-send", "--chat-id", chat, "--text", "暗号是什么？只回暗号本身", "--as", "user"]);
    const r2 = await wait(chat, t1, 130);
    if (!r2 || r2.err) { out[bot] = "FAIL追问 " + (r2?.err || "无回复(疑卡死)"); save(); continue; }
    out[bot] = r2.text.includes(word) ? "A 原生持久化：杀桥后仍记得" : /自动新建|会话丢失|🆕/.test(r2.text) ? "B 合规：忘但有自动/new卡" : "C 违规：忘且装死不发卡";
    console.log("RESULT", bot, out[bot]); save();
  } catch (e) { out[bot] = "ERR " + String(e.message).slice(0, 70); save(); }
}
console.log("ALLDONE", JSON.stringify(out));
