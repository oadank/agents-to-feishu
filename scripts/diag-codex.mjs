/**
 * 诊断 codex app-server "without active item" 空回复 bug。
 * 直接启动 codex app-server，跑一个 turn，dump 所有 notification + 需要应答的 request，
 * 观察文本增量事件是否到达、是否报 ReasoningSummaryDelta/OutputTextDelta without active item。
 */
import { CodexAppServerClient } from '../src/providers/codex/codex-app-server-client.js';

const client = new CodexAppServerClient();

let reqCount = 0;
const unsubscribe = client.subscribe((msg) => {
  if (msg.kind === 'request') {
    reqCount++;
    const method = msg.method;
    const params = msg.params ?? {};
    // 打印 server request，并自动应答（简化：回空结果 / 允许）
    console.log(`\n[REQ #${reqCount}] ${method}`);
    console.log(`  params: ${JSON.stringify(params).slice(0, 500)}`);
    // 根据方法应答
    Promise.resolve()
      .then(() => client.respond(msg.id, autoAnswer(method, params)))
      .catch((e) => console.error('respond err', e.message));
  } else {
    const method = msg.method;
    // notification：打印摘要，重点看文本/reasoning/turn 事件
    const p = (typeof msg.params === 'object' && msg.params) ? msg.params : {};
    const brief = JSON.stringify(p).slice(0, 200);
    if (/delta|item|turn|reasoning|agentMessage|toolCall|completed|error/i.test(method)) {
      console.log(`[NOTIF] ${method} :: ${brief}`);
    }
  }
});

function autoAnswer(method, params) {
  if (/permission|approval|confirm/i.test(method)) {
    return { outcome: { outcome: 'selected', optionId: 'allow' } };
  }
  if (/editor|input|prompt/i.test(method)) {
    // 给个空理由，避免特定编辑器请求卡住
    return { response: null };
  }
  return {};
}

async function main() {
  try {
    await client.prepare();
    console.log('== codex app-server prepared ==\n');

    const thread = await client.call('thread/start', {
      experimentalRawEvents: true,
      persistExtendedHistory: true,
      cwd: 'C:\\D\\opt',
    });
    console.log('\n[RESP] thread/start ->', JSON.stringify(thread).slice(0, 400));
    const threadId = thread?.thread?.id;
    if (!threadId) { console.log('NO THREAD ID, abort'); await client.close(); return; }

    console.log('\n== sending turn/start (exactly as providers/codex.ts does) ==\n');
    await client.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: '只回复一句话：收到，连接正常。' }],
      cwd: 'C:\\D\\opt',
    });
    console.log('\n[RESP] turn/start sent (call returned)');

    // 等待事件流结束（给 90s）
    await new Promise((r) => setTimeout(r, 90000));
  } catch (e) {
    console.error('\n[ERROR]', e.message);
  } finally {
    unsubscribe();
    await client.close();
  }
}

main();
