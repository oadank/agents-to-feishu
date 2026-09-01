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
console.log("[i] spawning interactive (no -p), simulating SDK stream-json ...");
const args = ["--print","--verbose","--output-format","stream-json"];
const child = spawn(exe, args, { env, stdio: ['pipe','pipe','pipe'] });
let out='', err='';
child.stdout.on('data', d => { out += d; if(out.length>4000) console.log("[stdout]", out.slice(-800)); });
child.stderr.on('data', d => { err += d; process.stdout.write("[stderr] "+d); });
const prompt = JSON.stringify({type:'user', content:'回复两字：成功'})+"\n";
child.stdin.write(prompt);
// after 8s, send quit / close stdin
setTimeout(()=>{ try{ child.stdin.end(); }catch{} }, 9000);
child.on('close', (code, sig)=>{ console.log("\n[close] code=", code, "signal=", sig); console.log("[stdout tail]", out.slice(-500)); process.exit(0); });
child.on('error', e=>console.error("[error]", e.message));
setTimeout(()=>{ console.log("\n[timeout 25s] code unknown, killing"); child.kill(); process.exit(0); }, 25000);
