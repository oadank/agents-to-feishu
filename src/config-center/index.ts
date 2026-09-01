/**
 * config-center 入口 —— 启动配置中心 HTTP 服务。
 *
 * 用法：
 *   node --import tsx/esm src/config-center/index.ts [--port 13600] [--no-restart]
 *
 * --no-restart : apply 时只写文件不重启进程（测试用）
 */

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createConfigServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 解析监听地址列表（2026-08-29 二次修正，按老大拍板）：
 *   - CTI_CONFIG_HOST 显式设置 → 只绑该地址（设 0.0.0.0 = 客户自己要求全接口，照给）
 *   - 未设置 → 双绑 127.0.0.1 + Tailscale IP（本机进程可用，老大远程也可用，不对局域网裸奔）
 *   - 探测不到 Tailscale → 只绑 127.0.0.1
 */
function resolveHosts(): string[] {
  const override = process.env.CTI_CONFIG_HOST?.trim();
  if (override) return [override];

  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    const lowerName = name.toLowerCase();
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const [a, b] = ni.address.split('.').map(Number);
      // Tailscale 固定使用 CGNAT 网段 100.64.0.0/10
      const isCgnat = a === 100 && b >= 64 && b <= 127;
      if (isCgnat || lowerName.includes('tailscale')) {
        return ['127.0.0.1', ni.address];
      }
    }
  }

  console.warn('[config-center] 未探测到 Tailscale 网卡，仅监听 127.0.0.1（如需远程访问请设 CTI_CONFIG_HOST）');
  return ['127.0.0.1'];
}

function parseArgs(argv: string[]): { port: number; restartOnApply: boolean; staticDir: string } {
  let port = 13600;
  let restartOnApply = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = Number(argv[i + 1] ?? 13600);
    if (argv[i] === '--no-restart') restartOnApply = false;
  }
  return { port, restartOnApply, staticDir: path.join(__dirname, '..', '..', 'web', 'config-center') };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const hosts = resolveHosts();
  const server = createConfigServer({
    host: hosts,
    port: args.port,
    staticDir: args.staticDir,
    restartOnApply: args.restartOnApply,
    globalExtra: {},
  });
  await server.listen();
  console.log(`config-center 就绪，监听 ${hosts.join(' + ')}:${args.port}（Tailscale 远程访问用 http://${hosts[hosts.length - 1]}:${args.port}/）`);
  console.log(`config-center 前端目录: ${args.staticDir}`);

  // 2026-08-30 修复开机竞态：断电/重启后 Tailscale 网卡常晚于本服务就绪，
  // 启动瞬间探测不到 ⇒ 只绑 127.0.0.1 ⇒ 老大从 Tailscale 打不开 13600。
  // 这里周期探测：Tailscale 网卡一出现就补绑。
  const detectTailscaleIps = (): string[] => {
    const out: string[] = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family !== 'IPv4' || ni.internal) continue;
        const [x, y] = ni.address.split('.').map(Number);
        // Tailscale 固定使用 CGNAT 网段 100.64.0.0/10
        const isCgnat = x === 100 && y >= 64 && y <= 127;
        if (isCgnat || name.toLowerCase().includes('tailscale')) out.push(ni.address);
      }
    }
    return out;
  };
  const timer = setInterval(() => {
    const bound = server.boundHosts();
    for (const ip of detectTailscaleIps()) {
      if (bound.includes(ip)) continue;
      void server.bindHost(ip).catch((e: unknown) => {
        console.warn(`[config-center] 补绑 ${ip} 失败: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }, 20_000);
  timer.unref?.();
}

main().catch((e) => {
  console.error('config-center 启动失败:', e);
  process.exit(1);
});
