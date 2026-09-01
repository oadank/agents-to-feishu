import { readStore } from '../src/config-center/store.ts';
import { synthesize } from '../src/voice/tts.ts';

const cfg = readStore().speech?.tts;
const t0 = Date.now();
console.log('开始 synthesize（CTI_BOT=' + (process.env.CTI_BOT || '(空)') + ' node ' + process.version + '）…');
const r: any = await Promise.race([
  synthesize('测试语音', cfg),
  new Promise((res) => setTimeout(() => res({ ok: false, error: '90秒未返回——挂起实锤' }), 90000)),
]);
console.log('结果:', r.ok ? `OK 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s` : r.error, '| 总耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's');
process.exit(0);
