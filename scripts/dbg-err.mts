import { createDshProvider } from '../src/providers/dsh.js';
const p = createDshProvider();
await p.prepare();
try {
  for await (const ev of p.streamChat({ text: 'hi', sessionKey: 'test', freshSession: true })) {
    console.log('EV:', ev.type, ev.type === 'error' ? ev.message : '');
  }
} catch (e) {
  console.error('CAUGHT:', e);
  console.error((e as Error).stack);
}
await p.dispose();
