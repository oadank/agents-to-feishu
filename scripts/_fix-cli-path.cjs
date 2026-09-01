const fs = require('fs');
const f = "C:\\Users\\oadan\\.agents-to-feishu\\config-open.json";
const open = JSON.parse(fs.readFileSync(f, 'utf8'));
const exe = "C:\\Users\\oadan\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
open.cliPath = { claude: exe };
open.runtimeEnv = {
  claude: {
    ANTHROPIC_PERMISSION_MODE: "bypassPermissions",
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1"
  }
};
fs.writeFileSync(f, JSON.stringify(open, null, 2), 'utf8');
console.log("cliPath.claude =", open.cliPath.claude);
console.log("existsSync =", fs.existsSync(exe));
