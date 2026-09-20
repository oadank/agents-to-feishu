# wb-1③ · WB provider 同类病复核（2026-09-20，WorkBuddy）

复核对象：`src/providers/workbuddy.ts`。对照两笔先例：
- 8e7cf9a（09-19 22:59）：老进程 exit 回调清空新进程引用 →"子进程不在"+每轮重生堆积；已修（代际判等 `child === proc`）。
- caf59ff（09-20，claude 家）：常驻进程静默退出后无人复位把手 → `ensureProcess` 的 `if(this.q) return` 永不重建 → 每条消息投死队列、300s 看门狗**只重投 prompt 不重建进程**。

## 结论（一句话）

WB 家**不存在字面意义的"重投 prompt 但不重建进程"**——provider 内无重试循环（claude 家 `claude.ts:528-605` 的 pendingRetryPrompt 重投模式 WB 没有），引擎侧唯一保险丝是 rpc 超时，超时后错误直接上报本轮、不自动重投。但复核出**三处同族病（"死了不自愈"）**，本票已按老大 09-20 新规矩（先给能自愈的代码）当场修复。

## 主路径核对证据

| 检查点 | 位置 | 结论 |
|---|---|---|
| 有无重试循环 | 全文件 grep `retry/attempt/重投` | 0 处。`streamChat` 单次走完，失败即 yield error |
| 看门狗位置 | 桥侧 `src/bridge/engine.ts:300` | 只记日志点名，**不重投不释放队列**（"那个任务还活着"）→ 无引擎外重投路径 |
| rpc 保险丝 | `workbuddy.ts:121-130` | prompt 900s（:284），超时 reject→本轮 error，不重投 |

## 三处同类病与修法（本 commit 内）

1. **initialize 失败不清尸**（ensureChild 内，改后 `workbuddy.ts:193-206`）
   - 病：`initialize` 超时/失败时 spawn 出的 `proc` 仍挂在 `child` 上且进程活着 → 下一轮 `ensureChild` 判 `child?.stdin?.writable && exitCode===null` 为真，直接复用这具**半死尸体** → 此后每个 rpc 都吃满超时（900s 一轮）死循环。这就是"重投 prompt 不重建进程"的 WB 变体。
   - 修：catch → `hardKill(proc)` + `child=null; startPromise=null` + 重抛；下条消息真重建。痕迹双写：`console.warn`（nssm 抓 out/err）+ rtLog。
2. **exit 后在途 rpc 干等保险丝**（`workbuddy.ts:186-193`）
   - 病：子进程死亡瞬间，在途 `session/prompt` 挂在 pend 上，要等最长 900s 超时才报错，期间卡片假死。
   - 修：`proc.on('exit')` 里当场以 error 响应唤醒全部 pend，在途轮次秒级收尾；叠加代际判等不清新引用（8e7cf9a 铁律保留）。
3. **dispose 不清 startPromise**（`workbuddy.ts:330-334`）
   - 病：dispose 后若有消息再进来，`ensureChild` 会 `await` 复用的旧 promise（可能永挂），既不报错也不重建。
   - 修：dispose 同步清 `startPromise=null`。

## 验证

- `npx tsc --noEmit` 退出码 0（09-20 本机实测）。
- 运行世代：workbuddy 服务经 nssm 注册表实锤为 `node + tsx src/index.ts`（AppParameters 现读），**无编译产物滞后问题**，下次重启自然加载本修复；按票面纪律本轮不重启。
- 痕迹口径（dsh 09-20 令）：本复核全程只认 git 实物与 `logs/workbuddy-out.log`/`workbuddy-err.log`；未把 `mimo-rt.log`（WB 服务 CTI_RT_LOG 历史误指向，注册表现读坐实）的任何行当 WB 证据。新增痕迹均双写 console.warn。
