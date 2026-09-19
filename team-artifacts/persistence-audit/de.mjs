import fs from "fs";
const f = "src/bridge/engine.ts";
let s = fs.readFileSync(f, "utf8");
const jobs = [
["      const toolSentPaths = new Set<string>();\r\n", ""],
["      const isToolSent = (p: string) => { try { return toolSentPaths.has(path.resolve(p).toLowerCase()); } catch { return false; } };\r\n", ""],
["if (/comfyui[\\\\/]runs|comfyui_temp|Krea2|文生图/i.test(p) && !pendingGenFiles.includes(p)", "if (/comfyui[\\\\/]runs|comfyui_temp|Krea2|文生图/i.test(p) && !p.includes(\"*\") && !pendingGenFiles.includes(p)"],
];
for (let [o, w] of jobs) {
  if (!s.includes(o)) { o = o.replace(/\r\n/g, "\n"); w = w.replace(/\r\n/g, "\n"); }
  const c = s.split(o).length - 1;
  if (c !== 1) { console.log("!!", c, o.slice(0, 40)); continue; }
  s = s.replace(o, w); console.log("ok", (o.slice(6, 34) || "(del)").trim());
}
fs.writeFileSync(f, s);
