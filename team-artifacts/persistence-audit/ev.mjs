import fs from "fs";
const f = "src/bridge/engine.ts";
let s = fs.readFileSync(f, "utf8");
const jobs = [
[`    const pendingImageIds: string[] = [];`,
 `    const pendingImageIds: string[] = [];\r\n    // 🔴 老大令 2026-09-19（双发二案）：事件层 send_image 输入路径台账——卡片文本会被渲染截断\r\n    // （"imagePath" 缺闭引号即漏判 Krea2_00014 双发），必须从 ev.input 原始 JSON 在截断前登记。\r\n    const toolSentPaths = new Set<string>();\r\n    const isToolSent = (p: string) => { try { return toolSentPaths.has(path.resolve(p).toLowerCase()); } catch { return false; } };`],
[`                console.log(\`[engine] send_image 捕获 attachmentId=\${im[1].slice(0, 26)}… 待投递\`);\r\n              }`,
 `                console.log(\`[engine] send_image 捕获 attachmentId=\${im[1].slice(0, 26)}… 待投递\`);\r\n              }\r\n              if (/send_image/i.test(ev.tool)) {\r\n                try {\r\n                  const ip = JSON.parse(String(ev.input || "{}")).imagePath;\r\n                  if (typeof ip === "string" && ip.trim()) { toolSentPaths.add(path.resolve(ip).toLowerCase()); console.log(\`[engine] 台账登记 send_image 输入 \${path.resolve(ip).slice(0, 60)}\`); }\r\n                } catch { /* 非 JSON 输入忽略 */ }\r\n              }`],
[`        for (const p of this.parseGeneratedImagePaths(turnBlob)) {
          if (/comfyui[\\/]runs|comfyui_temp|Krea2|文生图/i.test(p) && !pendingGenFiles.includes(p) && !isToolSent(p)) {`,
 `        for (const p of this.parseGeneratedImagePaths(turnBlob)) {
          if (/comfyui[\\/]runs|comfyui_temp|Krea2|文生图/i.test(p) && !p.includes("*") && !pendingGenFiles.includes(p) && !isToolSent(p)) {`],
];
let n = 0;
for (let [o, w] of jobs) {
  if (!s.includes(o)) { o = o.replace(/\r\n/g, "\n"); w = w.replace(/\r\n/g, "\n"); }
  if (s.split(o).length - 1 !== 1) { console.log("!! 锚不唯一/未命中:", o.slice(0, 46)); continue; }
  s = s.replace(o, w); n++; console.log("ok", o.slice(8, 42));
}
fs.writeFileSync(f, s);
console.log("applied", n);
