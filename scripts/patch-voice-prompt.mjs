// 一次性脚本：重写 config-store.json 的 injection.global 里「# 语音」段落为【语音】块规则（4条）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const storePath = path.join(os.homedir(), '.agents-to-feishu', 'config-store.json');

const NEW_VOICE_SECTION = `# 语音规则（桥接层自动收发，禁止手动发）
语音回复的 4 条规则：
1. **用户发语音 → 必须回语音**：用户发语音，桥接层自动转成文字给你（回「语音转写：…」回执），你正常文字回答，桥接层会自动发语音回本对话。
2. **用户要求发语音 → 必须回语音**：用户说「发语音/用语音/语音回复/语音回」等，桥接层会自动发语音回；若用户明确指定用哪个语音服务商（如小米/微软/edge/阿里/本地或某音色），桥接层会用指定服务商合成。
3. **用户发文本 → AI 自己决定**：用户纯文字提问时，是否语音回复由你判断——想用语音就主动服务（总结性、口语化、适合听），不需要就不发。
4. **发语音必须自然口语（新增，强制）**：任何要语音回复的场景，你必须在回复正文之外单独另起一段写：
  【语音】……（用口语写这一段，像跟人说话：直接给结论，简短、口语化；**禁止朗读回复的文本、禁止念代码/命令/路径/网址/邮箱/参数/工具执行过程**；需要细节就说细节在文字里）
  这段【语音】块**不会显示在飞书卡片上**，只用于桥接层合成语音；正文照常写完整内容。不打算语音回复时不要写【语音】块。
- **禁止**再用任何脚本/工具（send-feishu-voice.ps1、tts、bash 等）手动发送语音——桥接层自动发，手动再发 = 重复回复 = 错误；不主动写【语音】块 = 本轮不发语音。
- **🔊 语音转写可能不准**：识别常出错（同音字/中英混淆），遇到转写内容不通顺/像错别字/疑似工具或人名时，结合上下文猜真实意图，不要反问（①看主题 ②想常见读音 ③按最合理意图执行）。`;

let store;
try {
  store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
} catch (e) {
  console.error('读取 config-store.json 失败:', e.message);
  process.exit(1);
}

const global = store?.injection?.global;
if (typeof global !== 'string') {
  console.error('injection.global 不是字符串，退出');
  process.exit(1);
}

// 匹配旧「# 语音…」段（兼容上次改过的名字），替换到「# 知识循环」前
const candidates = ['# 语音规则（三规则，桥接层自动收发，禁止手动发）', '# 语音（桥接层自动收发，禁止手动发）'];
let start = -1;
for (const c of candidates) {
  const i = global.indexOf(c);
  if (i !== -1) { start = i; break; }
}
if (start === -1) {
  console.error('未找到语音段落，退出');
  process.exit(1);
}
const endMarker = '\n\n# 知识循环';
const end = global.indexOf(endMarker, start);
if (end === -1) {
  console.error('未找到「# 知识循环」结束标记，退出（保守起见不替换）');
  process.exit(1);
}
const oldSection = global.slice(start, end);
store.injection.global = global.replace(oldSection, NEW_VOICE_SECTION);

fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
console.log('✅ 语音 4 条规则已写入 →', storePath);
console.log('旧段首行:', oldSection.split('\n')[0]);
console.log('新段首行:', NEW_VOICE_SECTION.split('\n')[0]);
