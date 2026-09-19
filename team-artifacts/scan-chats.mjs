import fs from "fs";
const store = JSON.parse(fs.readFileSync("C:/Users/oadan/.agents-to-feishu/config-store.json", "utf8"));
const mapFile = "logs/chats-map.json";
const map = JSON.parse(fs.readFileSync(mapFile, "utf8"));
const report = {};
for (const a of store.agents) {
  try {
    const t = await (await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: a.appId, app_secret: a.appSecret }) })).json();
    if (t.code !== 0) { report[a.id] = "token-fail"; continue; }
    let items = [], pt = "";
    do {
      const j = await (await fetch(`https://open.feishu.cn/open-apis/im/v1/chats?page_size=100${pt ? "&page_token=" + encodeURIComponent(pt) : ""}`, { headers: { Authorization: `Bearer ${t.tenant_access_token}` } })).json();
      if (j.code !== 0) { report[a.id] = "list-fail " + j.code; break; }
      items.push(...(j.data?.items || [])); pt = j.data?.has_more ? j.data.page_token : "";
    } while (pt);
    const p2ps = items.filter(c => c.chat_mode === "p2p");
    report[a.id] = { chats: items.length, p2p: p2ps.map(c => `${c.chat_id}|${c.name || "?"}`) };
    if (p2ps.length && !map[a.id]) { map[a.id] = p2ps[0].chat_id; report[a.id].autoAdded = true; }
  } catch (e) { report[a.id] = "ERR " + e.message.slice(0, 50); }
}
fs.writeFileSync(mapFile, JSON.stringify(map, null, 0));
console.log(JSON.stringify(report, null, 1).slice(0, 2200));
