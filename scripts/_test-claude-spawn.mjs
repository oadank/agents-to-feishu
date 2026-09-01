import { spawn } from 'node:child_process';
const exe = "C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: "https://gateway.henry-gao.com",
  ANTHROPIC_AUTH_TOKEN: "sk-hg-C0a8FwNc-kex8cPzIsAw7EAJXlFDcEX5WmaZH2WFvNI",
  ANTHROPIC_API_KEY: "sk-hg-C0a8FwNc-kex8cPzIsAw7EAJXlFDcEX5WmaZH2WFvNI",
  ANTHROPIC_PERMISSION_MODE: "bypassPermissions",
  ANTHROPIC_MODEL: "deepseek-v4-flash",
  CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: "512000",
};
console.log("[spawn] cwd=", process.cwd());
const child = spawn(exe, ["-p", "回复两字：成功", "--dangerously-skip-permissions"], { env, stdio: ['ignore','pipe','pipe'] });
let out='', err='';
child.stdout.on('data', d => out += d);
child.stderr.on('data', d => err += d);
child.on('close', (code, sig) => {
  console.log("[spawn] close code=", code, "signal=", sig);
  console.log("[spawn] stdout:", (out||'').slice(0,500));
  console.log("[spawn] stderr:", (err||'').slice(0,1000));
});
child.on('error', e => console.error("[spawn] error:", e.message));
