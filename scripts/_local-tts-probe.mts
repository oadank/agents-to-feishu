import { readStore } from '../src/config-center/store.ts';
import { synthesize } from '../src/voice/tts.ts';

const cfg = readStore().speech?.tts;
const t0 = Date.now();
const r: any = await Promise.race([
  synthesize('本地语音切换测试', cfg, undefined, undefined, 'local'),
  new Promise((res) => setTimeout(() => res({ ok: false, error: '60秒未返回' }), 60000)),
]);
console.log('local 引擎:', r.ok ? `OK ${((Date.now() - t0) / 1000).toFixed(1)}s bytes=${(r.data || '').length}` : r.error);
process.exit(0);
