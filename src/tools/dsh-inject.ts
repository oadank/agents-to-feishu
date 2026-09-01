/**
 * dsh(ACP) 内置工具自动注入（2026-08-29 方向定调：桥接自有工具，不依赖外界 npm 包）
 *
 * 桥接第一方插件 vendor/cti-builtin-tools（收编自 @oadank/dsh-input-tools，摘除 webServer
 * 依赖、实现随插件自带——零网络、零端口、零外部安装）。桥接启动时幂等确保：
 *   1. 插件部署在 <dsh-bot>/node_modules/cti-builtin-tools（缺失 → 从 vendor 拷入）
 *   2. cordis.yml 有 `- id: cti-builtin-tools` 条目（缺失 → 追加）
 * ESM 以配置文件所在目录为解析锚点（NODE_PATH 对 ESM 无效），故部署目标必须是
 * dsh-bot/node_modules/。之前试过的 junction→profiles 与 @oadank 包引用均已废弃。
 *
 * 与 src/tools/registry.ts 的关系：同一套能力、两份实现（桥接 TS 版给 claude 进程内直调；
 * 插件 JS 版给 harness 进程内直调）。改任一侧的实现必须评估另一侧是否同步——两份文件头
 * 都有互指标注。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function userHome(): string {
  // 坑 #3：nssm LocalSystem 下 os.homedir() 指向 systemprofile —— 项目统一用 CTI_USER_HOME 兜底
  return process.env.CTI_USER_HOME || process.env.USERPROFILE || process.env.HOME || '';
}

export interface DshInjectResult {
  ok: boolean;
  pluginInstalled: boolean;
  cordisRegistered: boolean;
  actions: string[];
  error?: string;
}

export function ensureDshPluginInjected(log: (m: string) => void = () => {}): DshInjectResult {
  const actions: string[] = [];
  try {
    const home = userHome();
    const botHome = path.join(home, '.dsh', 'dsh-bot');
    const pluginTarget = path.join(botHome, 'node_modules', 'cti-builtin-tools');
    const cordisFile = process.env.CTI_DSH_ACP_CONFIG?.trim() || path.join(botHome, 'cordis.yml');

    // 1) 插件部署（vendor 是唯一来源，跟 agents-to-feishu 仓库走）
    const pluginInstalled = fs.existsSync(path.join(pluginTarget, 'lib', 'index.js'));
    if (!pluginInstalled) {
      const vendorSrc = process.env.CTI_DSH_PLUGIN_DIR?.trim()
        || path.resolve(__dirname, '..', '..', 'vendor', 'cti-builtin-tools');
      if (!fs.existsSync(path.join(vendorSrc, 'lib', 'index.js'))) {
        log(`[dsh-inject] vendor 副本缺失（${vendorSrc}），跳过自动安装`);
        return { ok: false, pluginInstalled: false, cordisRegistered: false, actions, error: 'vendor missing' };
      }
      fs.mkdirSync(path.dirname(pluginTarget), { recursive: true });
      fs.cpSync(vendorSrc, pluginTarget, { recursive: true });
      actions.push(`deployed plugin -> ${pluginTarget}`);
    }

    // 2) cordis.yml 条目（render.ts 生成的已含；手工/旧文件则补）
    let cordisRegistered = false;
    if (fs.existsSync(cordisFile)) {
      const yml = fs.readFileSync(cordisFile, 'utf8');
      if (!yml.includes('- id: cti-builtin-tools')) {
        fs.appendFileSync(cordisFile, `\n# Built-in tools plugin (bridge-owned first-party; appended by dsh-inject)\n- id: cti-builtin-tools\n  name: 'cti-builtin-tools'\n`);
        actions.push(`registered in ${path.basename(cordisFile)}`);
      }
      cordisRegistered = fs.readFileSync(cordisFile, 'utf8').includes('- id: cti-builtin-tools');
    } else {
      log(`[dsh-inject] cordis.yml 不存在（${cordisFile}），跳过条目检查`);
    }

    if (actions.length) log(`[dsh-inject] ${actions.join('; ')}`);
    else log('[dsh-inject] 插件与条目均已就位（幂等 no-op）');
    return { ok: true, pluginInstalled: true, cordisRegistered, actions };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`[dsh-inject] 失败: ${msg}`);
    return { ok: false, pluginInstalled: false, cordisRegistered: false, actions, error: msg };
  }
}
