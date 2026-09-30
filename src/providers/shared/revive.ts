/**
 * [T-0016 家法·2026-09-27 推广到 mimo/zcode/workbuddy]
 *
 * 病灶：桥/引擎换代后去赎回旧会话，若上一轮 turn 还挂在引擎里没收口，引擎会回
 * `Invalid params: session is already active: <sid>`（zcode 侧措辞类似）。旧逻辑一律
 * 当成"档案丢了"→ 清档案 + 新建 + auto /new，用户感知就是【重启之后丢失上文】。
 *
 * 正解（dsh.ts reviveStalledSession 已验证的同一口径）：
 *   ① 先 cancel/stop 把在飞 turn 摘掉；② 退避等它 settle；③ 重试 resume/load。
 *   只要赎回成功，引擎原生记忆原样回来 —— 不清档案、不弹 auto /new、不喂影子。
 *
 * 仅在错误命中"在飞"特征时才走这条路；命中不了就原样失败，行为与改造前完全一致
 * （各家引擎错误措辞不同，不做投机分支）。
 */

/** 「上一轮还在飞」类错误特征；命中才救，不命中就老实失败 */
export const IN_FLIGHT_RESUME_RE =
  /already active|already in progress|session is (still )?running|turn is running|busy/i;

export function isInFlightResumeError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return IN_FLIGHT_RESUME_RE.test(m);
}

export interface ReviveArgs<T> {
  /** 日志前缀，如 'mimo' */
  label: string;
  /** 会话 id（只用于打日志） */
  sid: string;
  /** 摘掉在飞 turn（mimo/dsh= session/cancel，zcode= session/stop），失败不致命 */
  cancelInFlight: () => Promise<void>;
  /** 重新赎回会话，成功返回会话对象 */
  retryResume: () => Promise<T>;
  log: (m: string) => void;
  attempts?: number;
  backoffMs?: number[];
}

/**
 * @returns 赎回成功返回会话对象；救不回来返回 null（调用方继续走原来的"新建"路径）
 */
export async function reviveInFlightSession<T>(args: ReviveArgs<T>): Promise<T | null> {
  const attempts = args.attempts ?? 3;
  const backoff = args.backoffMs ?? [1_500, 3_000, 4_500];
  for (let i = 1; i <= attempts; i++) {
    try {
      await args.cancelInFlight();
      args.log(`[${args.label}] revive#${i} 已摘在飞 turn ${args.sid.slice(0, 8)}`);
    } catch (e) {
      args.log(`[${args.label}] revive#${i} 摘在飞失败（不致命）: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`);
    }
    const wait = backoff[Math.min(i - 1, backoff.length - 1)];
    await new Promise((r) => setTimeout(r, wait));
    try {
      const s = await args.retryResume();
      args.log(`[${args.label}] revive#${i} 赎回成功 ${args.sid.slice(0, 8)}：记忆原样，不弹卡`);
      return s;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      args.log(`[${args.label}] revive#${i} 仍失败: ${msg.slice(0, 140)}`);
      if (!isInFlightResumeError(e)) return null; // 不是"在飞"类 → 别耗时间
    }
  }
  return null;
}
