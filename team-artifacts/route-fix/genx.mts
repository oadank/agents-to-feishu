import { runGenerateImage } from "../../src/tools/registry.js";
const r = await runGenerateImage({ prompt: "一只红苹果，写实静物摄影，8K", template: "Krea2 Turbo-文生图.json", width: 768, height: 1024 });
const j = JSON.parse(String(r));
console.log("RESULT source=", j.source ?? j.backend ?? "?", "| file=", (j.file ?? j.path ?? j.image ?? JSON.stringify(j)).toString().slice(0, 120), "| ok=", j.ok ?? j.success ?? "?");
