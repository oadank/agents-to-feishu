// ACP 自测（注入 credentials 里的 ARK key）：断言 session/update 携带 _meta.usage
// 启动入口/环境共用 scripts/dsh-acp-spawn.mjs（dshAcpSpawnPlan + dshAcpEnv：
// 剥 DSH_*、注 DSH_HOME/Windows 系统变量），不再走已删除的 packages/examples/acp-demo 旧入口。
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import { dshAcpSpawnPlan, dshAcpEnv } from './dsh-acp-spawn.mjs'

const yaml = readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const m = yaml.match(/^  ARK_API_KEY:\s*"?([^\n"]+)/m) || yaml.match(/^ARK_API_KEY:\s*"?([^\n"]+)/m)
if (!m) { console.log('no ARK key'); process.exit(1) }
const env = dshAcpEnv({ ARK_API_KEY: m[1].trim() })

const HARNESS = 'C:/D/opt/deepseek-harness/deepseek-harness' // 仅用作 session/new 的工作目录
const configArg = path.join(os.homedir(), '.dsh', 'dsh-bot', 'cordis.yml')
const plan = dshAcpSpawnPlan({ config: configArg })
const child = spawn(plan.command, plan.args, { cwd: plan.cwd, stdio: ['pipe', 'pipe', 'pipe'], env })
let nextId = 1
const pending = new Map()
const send = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
const rl = createInterface({ input: child.stdout })
let sawUsageMeta = null
const updates = []
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error).slice(0, 200)))
    else p.resolve(msg.result)
    return
  }
  if (msg.method === 'session/update') {
    const u = msg.params?.update
    updates.push(u?.sessionUpdate)
    if (u?.sessionUpdate === 'agent_message_chunk' && u._meta?.usage) sawUsageMeta = u._meta.usage
  }
})
child.stderr.on('data', () => {})
const timer = setTimeout(() => {
  console.log('TIMEOUT updates:', [...new Set(updates)].join(','))
  console.log('usageMeta:', JSON.stringify(sawUsageMeta))
  child.kill(); process.exit(0)
}, 180000)
try {
  await send('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const session = await send('session/new', { cwd: HARNESS, mcpServers: [] })
  await send('session/prompt', { sessionId: session.sessionId ?? session.session_id, prompt: [{ type: 'text', text: '只回复两个字：收到' }] })
  clearTimeout(timer)
  console.log('updates:', [...new Set(updates)].join(','))
  console.log('usageMeta:', JSON.stringify(sawUsageMeta))
  console.log(sawUsageMeta ? 'RESULT: PASS' : 'RESULT: FAIL')
} catch (e) { console.log('ERR', String(e).slice(0, 200)) }
child.kill(); process.exit(0)
