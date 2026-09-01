/**
 * 内建 TTS（语音合成）—— 全引擎对齐 @oadank/dsh-input-tools：
 *   edge（微软免费）、xiaomi（小米预置音色+唱歌+音色描述底嗓）、
 *   voicedesign（小米音色设计，AI/固定模式）、voiceclone（小米音色克隆，多样本）、
 *   local（本地 MeloTTS，URL/CMD）、ali（阿里 qwen3-tts-flash）。
 * 配置驱动、可分发；接口 synthesize(text, ttsCfg, engineOverride?)。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { edgeTts } from './edge-tts.js'
import { resolveFfmpeg } from './asr.js'
import type { CloneSample } from '../config-center/store.js'

// ── 类型（对应 store.SpeechConfig.tts）──

export interface XiaomiTts {
  enabled: boolean
  apiKey: string
  baseUrl: string
  voice: string
  singing: boolean
  context: string
}
export interface VoiceDesignTts {
  enabled: boolean
  mode: 'ai' | 'fixed'
  context: string
  aiGender: string
  aiAge: string
  lockGender: boolean
  lockTimbre: boolean
  lockAge: boolean
}
export interface VoiceCloneTts {
  enabled: boolean
  samplePath: string
  context: string
  defaultId: string
  // [2026-09-01] 下拉选中的样本（对齐 dsh-web）：合成时优先用它，缺省回落 samples[0]
  sampleId?: string
  samples: CloneSample[]
}
export interface LocalTts { enabled: boolean; url: string; cmd: string }
export interface AliTts { enabled: boolean; apiKey: string; baseUrl: string; voice: string }
/** Audio8 本地零样本克隆 TTS（C:\D\opt\audio8-tts，音色须先注册到 voices/）
 *  url = 常驻服务地址（主路径，模型常驻内存）；cmd = CLI 兜底（服务没起来时才会用到） */
export interface Audio8Tts { enabled: boolean; url: string; cmd: string; voice: string }

export interface TtsConfig {
  /** edge | xiaomi | voicedesign | voiceclone | local | audio8 | ali | auto */
  defaultEngine: string
  edge: { enabled: boolean; voice: string }
  xiaomi: XiaomiTts
  voicedesign: VoiceDesignTts
  voiceclone: VoiceCloneTts
  local: LocalTts
  audio8: Audio8Tts
  ali: AliTts
}

export interface TtsResult {
  ok: boolean
  format?: string   // mp3 / wav
  data?: Buffer
  engine?: string
  error?: string
  degradedFrom?: string  // 2026-09-01：首选引擎失败、自动降级时记录原引擎
}

/** 语音设计年龄标签（对齐 dsh-input-tools AI_AGE_LABELS） */
const AI_AGE_LABELS: Record<string, string> = {
  infant: '婴儿感', child: '幼儿感', teen: '少年感', young: '青年感', middle: '中年感', old: '老年感',
}

// [2026-09-01] AI 模式随机音色描述池（对齐 dsh-input-tools 分档逻辑）：锁哪个年龄段就只抽哪个档的质感词，
// 避免"年轻/低沉"这类强年龄暗示词压过身份锚点（dsh-web 实测婴儿感翻车的教训）
const VD_TIMBRE_BY_AGE: Record<string, string[]> = {
  infant: ['奶声奶气的稚嫩嗓音', '软糯含糊的小奶音', '尖细清亮的宝宝嗓音', '奶乎乎的婴语嗓音，吐字稚嫩'],
  child: ['清脆明亮的孩童嗓音', '软糯稚嫩的童声', '活泼稚气的小学生嗓音'],
  teen: ['清亮干净的少年嗓音', '元气满满的青春嗓音', '略带青涩变声期的嗓音'],
  young: [
    '嗓音清亮通透', '声音温润醇厚', '带一点沙哑的颗粒感', '气声很重的轻柔嗓音', '明亮有弹性的年轻嗓音',
    '低沉磁性的嗓音', '清冷干净的嗓音', '软糯带鼻音的嗓音', '洪亮有力的嗓音', '细腻柔和的嗓音',
  ],
  middle: ['沉稳成熟的嗓音', '温和厚实的嗓音', '干练利落的嗓音', '低沉有阅历的嗓音'],
  old: ['沙哑沧桑的老年嗓音', '苍老低沉的嗓音，略带气喘', '沧桑沙哑、字音微颤的老年嗓音', '苍老厚重的嗓音，慢条斯理'],
}
const VD_RANDOM_MOOD = [
  '语气活泼轻快，像中了奖一样开心', '语气委屈巴巴，带着撒娇的鼻音', '语气温柔安抚，像哄小孩睡觉',
  '语气急促紧张，像赶时间要迟到', '语气慵懒随意，像刚睡醒的样子', '语气兴奋雀跃，忍不住笑出声',
  '语气认真严肃，一字一顿', '语气俏皮搞怪，爱开玩笑', '语气感伤低落，声音发闷',
  '语气得意洋洋，带点小骄傲', '语气神秘压低，像在讲秘密', '语气豪爽大方，像东北唠嗑',
]
const VD_RANDOM_PACE = [
  '语速适中，吐字清晰', '语速偏快，节奏跳跃', '语速缓慢，字正腔圆', '语速忽快忽慢，情绪起伏大', '语速均匀平稳',
]
// [2026-09-01 修] 对齐 dsh-input-tools：老大实测性别/年龄锁定不生效——中性池里"撒娇的鼻音"(女倾向)/
// "东北唠嗑"(男倾向)会把声音身份带偏。情绪/节奏池也按锁定年龄分档，三池（质感/情绪/节奏）全部吻合身份。
const VD_MOOD_BY_AGE: Record<string, string[]> = {
  infant: ['咿咿呀呀像在学说话', '咯咯咯笑个不停', '带着奶音的哭腔，委屈巴巴', '奶声奶气地耍小脾气', '含糊不清地自言自语'],
  child: ['兴高采烈像捡到宝', '撅着嘴小声嘟囔', '叽叽喳喳抢着说话', '奶声奶气地撒娇卖萌'],
  teen: ['元气满满像打了鸡血', '意气风发带着少年意气', '害羞时声音发紧', '兴奋时语调飞扬'],
  young: ['语气活泼轻快，像中了奖一样开心', '语气温柔安抚，像哄小孩睡觉', '语气急促紧张，像赶时间要迟到', '语气慵懒随意，像刚睡醒的样子', '语气兴奋雀跃，忍不住笑出声', '语气认真严肃，一字一顿', '语气俏皮搞怪，爱开玩笑'],
  middle: ['语气沉稳从容，不急不躁', '语气温和笃定，像宽厚的长辈', '语气干练果断，条理分明', '语气疲惫但克制', '语气爽朗，带着生活历练的通透'],
  old: ['语气慢悠悠像晒太阳', '絮絮叨叨地念家常', '带着笑意讲起往事，娓娓道来', '语气感慨，声音微微发颤', '有气无力但慈祥温和'],
}
const VD_PACE_BY_AGE: Record<string, string[]> = {
  infant: ['忽快忽慢，想到哪说到哪', '一个字一个字往外蹦', '断断续续还带着喘'],
  child: ['蹦蹦跳跳忽快忽慢', '一激动就越说越快'],
  teen: ['语速轻快带弹跳感', '忽快忽慢，情绪全写在节奏里'],
  young: ['语速适中，从容自然', '语速偏快，透着利索', '语速偏慢，懒洋洋的'],
  middle: ['语速平稳，字字清楚', '不紧不慢，稳中有度'],
  old: ['语速很慢，字与字之间带着停顿', '慢条斯理，偶尔喘口气', '念叨起来会不由自主变快'],
}
function randomVoiceDesignDesc(ageKey: string): string {
  const pick = (arr: string[]): string => arr[Math.floor(Math.random() * arr.length)]
  const timbre = VD_TIMBRE_BY_AGE[ageKey] ?? VD_TIMBRE_BY_AGE.young
  const mood = VD_MOOD_BY_AGE[ageKey] ?? VD_MOOD_BY_AGE.young
  const pace = VD_PACE_BY_AGE[ageKey] ?? VD_PACE_BY_AGE.young
  return `${pick(timbre)}，${pick(mood)}，${pick(pace)}`
}

// ── 工具 ──

/** 解析 Windows 命令行参数（处理双引号：引号内空格不拆、剥掉引号） */
function splitCommandLine(cmd: string): string[] {
  const args: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === '"') inQuote = !inQuote
    else if (ch === ' ' || ch === '\t') {
      if (inQuote) cur += ch
      else if (cur !== '') { args.push(cur); cur = '' }
    } else cur += ch
  }
  if (cur !== '') args.push(cur)
  return args
}

function resolveFfmpegBin(): string {
  try {
    const out = execFileSync('ffmpeg', ['-version'], { windowsHide: true, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    if (out.split(/\r?\n/)[0]?.trim()) return 'ffmpeg'
  } catch { /* 不在 PATH */ }
  return 'ffmpeg' // 让 execFileSync 自己解析系统 PATH；找不到会抛错由上层兜底
}

const FFMPEG_BIN = resolveFfmpegBin()

/** 非 mp3 音频转 mp3（失败保留原容器）；识别 mp3 头不转码（兼容 ID3v2 标签头） */
function toMp3(data: Uint8Array, declared: string): { data: Buffer; format: string } {
  // 跳过 ID3v2 标签（ID3 头 10 字节 + 4 字节大小），再找 MPEG 帧同步 0xFF E?
  let off = 0
  if (data.length > 10 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) { // 'ID3'
    const size = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f)
    off = 10 + size
  }
  const isMp3 = data.length > off + 2 && data[off] === 0xFF && ((data[off + 1] ?? 0) & 0xE0) === 0xE0
  let finalData = Buffer.from(data)
  let mediaType = declared
  if (!isMp3) {
    const tmpIn = path.join(process.env.TEMP || os.tmpdir(), `atf-tts-in-${crypto.randomUUID()}.wav`)
    const mp3Path = path.join(process.env.TEMP || os.tmpdir(), `atf-tts-${crypto.randomUUID()}.mp3`)
    fs.writeFileSync(tmpIn, finalData)
    try {
      execFileSync(FFMPEG_BIN, ['-y', '-i', tmpIn, '-c:a', 'libmp3lame', '-b:a', '128k', mp3Path], {
        windowsHide: true, stdio: 'ignore', timeout: 30_000,
      })
      finalData = fs.readFileSync(mp3Path)
      mediaType = 'audio/mpeg'
    } catch { /* 转码失败保留原容器 */ } finally {
      try { fs.unlinkSync(tmpIn) } catch {}
      try { fs.unlinkSync(mp3Path) } catch {}
    }
  }
  // audio/mpeg 含 mp3 判据：同时匹配 'mp3' 与 'mpeg'（'audio/mpeg'.includes('mp3') 是 false，旧 bug 导致 format='audio'）
  const fmt = (mediaType.includes('mpeg') || mediaType.includes('mp3')) ? 'mp3' : (mediaType.includes('wav') ? 'wav' : 'audio')
  return { data: finalData, format: fmt }
}

/** 年龄×性别 → 无歧义身份短语 */
function ageGenderIdentity(ageKey: string, genderKey: string): string {
  const male = genderKey === 'male'
  const female = genderKey === 'female'
  switch (ageKey) {
    case 'infant': return male ? '男婴' : female ? '女婴' : '婴儿'
    case 'child': return male ? '小男孩' : female ? '小女孩' : '小孩'
    case 'teen': return male ? '少年' : female ? '少女' : '少年'
    case 'young': return male ? '青年男性' : female ? '青年女性' : '青年人'
    case 'middle': return male ? '中年男性' : female ? '中年女性' : '中年人'
    case 'old': return male ? '老年男性' : female ? '老年女性' : '老年人'
    default: return male ? '男性' : female ? '女性' : ''
  }
}

/** 飞书语音消息需要 OPUS 格式（16k 单声道 libopus voip，对齐旧 agents-to-im）；失败返回 null */
export async function toOpus(data: Buffer): Promise<Buffer | null> {
  const ffmpeg = resolveFfmpeg()
  const tmp = process.env.TEMP || os.tmpdir()
  const inPath = path.join(tmp, `atf-opus-in-${crypto.randomUUID()}.bin`)
  const outPath = path.join(tmp, `atf-opus-${crypto.randomUUID()}.opus`)
  try {
    fs.writeFileSync(inPath, data)
    execFileSync(ffmpeg, ['-y', '-i', inPath, '-ar', '16000', '-ac', '1', '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', outPath], {
      windowsHide: true, stdio: 'ignore', timeout: 30_000,
    })
    const out = fs.readFileSync(outPath)
    if (out.length === 0) return null
    return out
  } catch {
    return null
  } finally {
    try { fs.unlinkSync(inPath) } catch {}
    try { fs.unlinkSync(outPath) } catch {}
  }
}

// ── 各引擎合成 ──

/** 微软 Edge 免费 */
async function synthesizeEdge(text: string, cfg: { enabled: boolean; voice: string }): Promise<TtsResult | null> {
  if (!cfg?.voice) return null
  try {
    const mp3 = await edgeTts(text, cfg.voice || 'zh-CN-XiaoxiaoNeural')
    if (!mp3 || mp3.length === 0) return { ok: false, error: 'Edge TTS 未返回音频' }
    return { ok: true, format: 'mp3', data: Buffer.from(mp3), engine: 'edge' }
  } catch (e) {
    return { ok: false, error: `Edge TTS 失败: ${(e as Error)?.message ?? String(e)}` }
  }
}

/** 小米预置音色（mimo-v2.5-tts）：唱歌标签 + 音色描述底嗓 context */
async function synthesizeXiaomi(text: string, cfg: XiaomiTts): Promise<TtsResult | null> {
  const apiKey = cfg?.apiKey ?? ''
  if (apiKey === '') return null
  const baseUrl = (cfg?.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '')
  const voice = cfg?.voice || '冰糖'
  let speak = text
  // 唱歌：文本自带 (唱歌) 标签，或明确唱歌意图时自动加标签
  const hasTag = /^\s*\((唱歌|sing|singing)\)/i.test(speak)
  const wantsSing = cfg?.singing === true || (!hasTag && /(唱(歌|一?首|一段)|歌声回复|用歌声|唱歌回|来一段|唱两句)/i.test(speak))
  if (wantsSing && !hasTag) speak = `(唱歌)${speak}`
  const messages: Array<{ role: string; content: string }> = []
  if ((cfg?.context ?? '').trim() !== '') messages.push({ role: 'user', content: cfg.context.trim() })
  messages.push({ role: 'assistant', content: speak })
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'mimo-v2.5-tts', messages, max_tokens: 8192, audio: { format: 'wav', voice } }),
      signal: AbortSignal.timeout(60000),
    })
    if (!resp.ok) {
      let b = ''; try { b = (await resp.text()).slice(0, 200) } catch {}
      return { ok: false, error: `小米 TTS 返回 ${resp.status}: ${b}` }
    }
    const payload = await resp.json() as any
    const data = payload?.choices?.[0]?.message?.audio?.data
    if (typeof data !== 'string' || data.length < 100) return { ok: false, error: '小米 TTS 未返回音频' }
    const r = toMp3(new Uint8Array(Buffer.from(data, 'base64')), 'audio/wav')
    return { ok: true, format: r.format, data: r.data, engine: 'xiaomi' }
  } catch (e) {
    return { ok: false, error: `小米 TTS 失败: ${(e as Error)?.message ?? String(e)}` }
  }
}

/** 小米音色设计（mimo-v2.5-tts-voicedesign）：user=音色描述，无 voice。
 *  mode=ai：按 aiGender/aiAge 生成身份基座 + 锁定锚点；
 *  mode=fixed：底嗓用 context，voiceDesc 作为情绪/风格叠加（overrideVoice=true 时整体替换）。 */
async function synthesizeVoiceDesign(
  text: string, cfg: VoiceDesignTts, apiKey: string, baseUrl: string, voiceDesc: string, overrideVoice: boolean,
): Promise<TtsResult | null> {
  if (apiKey === '') return null
  const vdMode = cfg?.mode || 'ai'
  let desc = (voiceDesc ?? '').trim()
  if (vdMode === 'ai') {
    const gKey = cfg?.aiGender === 'male' ? 'male' : cfg?.aiGender === 'female' ? 'female' : ''
    const aKey = AI_AGE_LABELS[cfg?.aiAge ?? ''] !== undefined ? cfg.aiAge : ''
    const identity = ageGenderIdentity(aKey, gKey)
    const lockG = cfg?.lockGender === true
    const lockA = cfg?.lockAge === true
    // [2026-09-01] 对齐 dsh-input-tools：质感锁定选项已删（三池按年龄分档，身份天然稳定）
    const gLabel = gKey === 'male' ? '男' : gKey === 'female' ? '女' : ''
    const aLabel = AI_AGE_LABELS[aKey] ?? ''
    const anchorText = [
      lockG ? '性别固定为' + (gLabel !== '' ? gLabel : '每次一致') : '',
      lockA ? '年龄感固定为' + (aLabel !== '' ? aLabel : '每次一致') : '',
    ].filter(Boolean).join('、')
    if (identity !== '' || anchorText !== '') {
      desc = (identity !== '' ? '一位' + identity + '的声音（身份硬性要求：' + (anchorText !== '' ? anchorText : '按上述身份') + '；若与其他描述冲突，一律以本身份为准，严禁合成其他性别或年龄段的声音）。' : '')
        + (desc !== '' ? '语气/情绪要求：' + desc + '（性别与年龄以身份为准，严禁改变；只按本描述演绎情绪语气）。' : '音色与语气要求：' + randomVoiceDesignDesc(aKey) + '（性别与年龄以身份为准，严禁改变）。')
    } else if (desc === '') {
      desc = randomVoiceDesignDesc('') + '；语气情绪要饱满生动，像真人一样带喜怒哀乐，禁止平淡。'
    }
  } else {
    // 固定模式：voiceDesc 作为情绪/风格叠加在底嗓 context 后；overrideVoice=true 整体替换
    const base = (cfg?.context ?? '').trim()
    if (overrideVoice === true && desc !== '') desc = desc
    else if (desc !== '') desc = base + '；' + desc
    else desc = base
  }
  if (desc === '') return null
  const messages = [
    { role: 'user', content: desc },
    { role: 'assistant', content: text },
  ]
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'mimo-v2.5-tts-voicedesign', messages, max_tokens: 8192, audio: { format: 'wav' } }),
      signal: AbortSignal.timeout(60000),
    })
    if (!resp.ok) {
      let b = ''; try { b = (await resp.text()).slice(0, 200) } catch {}
      return { ok: false, error: `语音设计返回 ${resp.status}: ${b}` }
    }
    const payload = await resp.json() as any
    const data = payload?.choices?.[0]?.message?.audio?.data
    if (typeof data !== 'string' || data.length < 100) return { ok: false, error: '语音设计未返回音频' }
    const r = toMp3(new Uint8Array(Buffer.from(data, 'base64')), 'audio/wav')
    return { ok: true, format: r.format, data: r.data, engine: 'voicedesign' }
  } catch (e) {
    return { ok: false, error: `语音设计失败: ${(e as Error)?.message ?? String(e)}` }
  }
}

/** 小米音色克隆（mimo-v2.5-tts-voiceclone）：audio.voice=样本 dataURL（≤10MB）。
 *  样本取 sampleId 选中项（对齐 dsh-web 下拉）→ samples[0] → samplePath 兼容；风格指令优先级 voiceDesc > 样本 context > 全局 context。
 *  [2026-09-01] export：config-center server 的 add 接口用它做"保存后预生成 -preview.mp3"。 */
export async function synthesizeVoiceClone(
  text: string, cfg: VoiceCloneTts, apiKey: string, baseUrl: string, voiceDesc: string,
): Promise<TtsResult | null> {
  if (apiKey === '') return null
  const sampleList = Array.isArray(cfg?.samples) ? cfg.samples : []
  const chosen = (typeof cfg?.sampleId === 'string' && cfg.sampleId !== '')
    ? (sampleList.find((s) => s?.id === cfg.sampleId) ?? sampleList[0])
    : sampleList[0]
  const samplePath = (chosen && typeof chosen.path === 'string' && chosen.path !== '')
    ? chosen.path
    : (cfg?.samplePath ?? '')
  if (samplePath === '') return null
  let sample: string
  try {
    const bytes = fs.readFileSync(samplePath)
    if (bytes.byteLength > 10 * 1024 * 1024) return { ok: false, error: '克隆样本 >10MB' }
    const suffix = samplePath.toLowerCase().split('.').pop()
    const mime = suffix === 'mp3' ? 'audio/mpeg' : 'audio/wav'
    sample = `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return { ok: false, error: '克隆样本读取失败' }
  }
  const messages: Array<{ role: string; content: string }> = []
  const sampleContext = typeof chosen?.context === 'string' ? chosen.context.trim() : ''
  const styleInstruct = (voiceDesc ?? '').trim() !== ''
    ? voiceDesc.trim()
    : (sampleContext !== '' ? sampleContext : (cfg?.context?.trim() ?? ''))
  if (styleInstruct !== '') messages.push({ role: 'user', content: styleInstruct })
  messages.push({ role: 'assistant', content: text })
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'mimo-v2.5-tts-voiceclone', messages, max_tokens: 8192, audio: { format: 'wav', voice: sample } }),
      signal: AbortSignal.timeout(60000),
    })
    if (!resp.ok) {
      let b = ''; try { b = (await resp.text()).slice(0, 200) } catch {}
      return { ok: false, error: `语音克隆返回 ${resp.status}: ${b}` }
    }
    const payload = await resp.json() as any
    const data = payload?.choices?.[0]?.message?.audio?.data
    if (typeof data !== 'string' || data.length < 100) return { ok: false, error: '语音克隆未返回音频' }
    const r = toMp3(new Uint8Array(Buffer.from(data, 'base64')), 'audio/wav')
    return { ok: true, format: r.format, data: r.data, engine: 'voiceclone' }
  } catch (e) {
    return { ok: false, error: `语音克隆失败: ${(e as Error)?.message ?? String(e)}` }
  }
}

/** 本地 MeloTTS：URL 常驻服务优先，CMD 兜底 */
async function synthesizeLocal(text: string, cfg: LocalTts): Promise<TtsResult | null> {
  const url = (cfg?.url ?? '').trim()
  try {
    if (url !== '') {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(60000),
      })
      if (!resp.ok) return { ok: false, error: `本地 TTS 服务返回 ${resp.status}` }
      const body = Buffer.from(await resp.arrayBuffer())
      const r = toMp3(new Uint8Array(body), 'audio/wav')
      return { ok: true, format: r.format, data: r.data, engine: 'local' }
    }
    const command = (cfg?.cmd ?? '').trim()
    if (command === '') return null
    const parts = splitCommandLine(command)
    const bin = parts[0]
    if (bin === undefined) return null
    const audio = execFileSync(bin, [...parts.slice(1), text], { windowsHide: true, encoding: 'buffer', timeout: 60000 })
    const r = toMp3(new Uint8Array(audio as Buffer), 'audio/mpeg')
    return { ok: true, format: r.format, data: r.data, engine: 'local' }
  } catch (e) {
    return { ok: false, error: `本地 TTS 失败: ${(e as Error)?.message ?? String(e)}` }
  }
}

// ── Audio8 本地零样本克隆 TTS（2026-09-01）────────────────────────────
/** Audio8 项目根（voices/ 在它下面；可用环境变量 AUDIO8_DIR 覆盖） */
export const AUDIO8_DIR = process.env.AUDIO8_DIR ?? 'C:\\D\\opt\\audio8-tts'
/** 已注册音色目录：voices/<名字>/{meta.json, codes.npy} */
export const AUDIO8_VOICES_DIR = path.join(AUDIO8_DIR, 'voices')
/** Audio8 专用 python（项目 venv），注册音色 register_voice.py 用它跑 */
export const AUDIO8_PY = path.join(AUDIO8_DIR, '.venv', 'Scripts', 'python.exe')

// 主路径 = 直连常驻服务（127.0.0.1:18795，模型常驻内存，省掉每次 spawn CLI + 等模型加载）；
// 兜底 = CLI 包装（audio8-tts.mjs，输出 mp3 到 stdout），仅当常驻服务没起来时才走。
// 没有内置音色——每句话都拿注册好的参考音频做克隆，音色须先注册到 C:\D\opt\audio8-tts\voices\。
async function synthesizeAudio8(text: string, cfg: Audio8Tts): Promise<TtsResult | null> {
  const voice = (cfg?.voice ?? '').trim()
  const url = (cfg?.url ?? '').trim()
  if (url !== '') {
    try {
      const r = await fetch(`${url.replace(/\/+$/, '')}/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice: voice === '' ? undefined : voice }),
        // audio8 纯 CPU 推理慢（短句 ~15s、长句 30s+），超时给足
        signal: AbortSignal.timeout(170_000),
      })
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length > 1000) return { ok: true, format: 'wav', data: buf, engine: 'audio8' }
      }
    } catch { /* 服务没起来：掉到下面的 CLI 兜底 */ }
  }
  const command = (cfg?.cmd ?? '').trim()
  if (command === '') return null
  try {
    const parts = splitCommandLine(command)
    const bin = parts[0]
    if (bin === undefined) return null
    const args = [...parts.slice(1)]
    if (voice !== '') args.push('--voice', voice)
    args.push(text)
    // audio8 纯 CPU 推理慢（短句 ~10s、长句 30s+），超时给足 180s
    const audio = execFileSync(bin, args, { windowsHide: true, encoding: 'buffer', timeout: 180_000 })
    return { ok: true, format: 'mp3', data: Buffer.from(audio as Buffer), engine: 'audio8' }
  } catch (e) {
    return { ok: false, error: `Audio8 克隆 TTS 失败: ${(e as Error)?.message ?? String(e)}` }
  }
}

/** 阿里 qwen3-tts-flash（dashscope） */
async function synthesizeAli(text: string, cfg: AliTts): Promise<TtsResult | null> {
  const apiKey = cfg?.apiKey ?? ''
  if (apiKey === '') return null
  const baseUrl = (cfg?.baseUrl || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation').replace(/\/+$/, '')
  const voice = cfg?.voice || 'Cherry'
  try {
    const resp = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'qwen3-tts-flash', input: { text }, parameters: { voice, format: 'wav', language_type: 'zh' } }),
      signal: AbortSignal.timeout(60000),
    })
    if (!resp.ok) {
      let b = ''; try { b = (await resp.text()).slice(0, 200) } catch {}
      return { ok: false, error: `阿里 TTS 返回 ${resp.status}: ${b}` }
    }
    const payload = await resp.json() as any
    const audioUrl = payload?.output?.audio?.url
    if (typeof audioUrl !== 'string' || audioUrl === '') return { ok: false, error: '阿里 TTS 未返回音频' }
    const audioRes = await fetch(audioUrl, { signal: AbortSignal.timeout(120000) })
    if (!audioRes.ok) return { ok: false, error: `音频下载失败 ${audioRes.status}` }
    const body = Buffer.from(await audioRes.arrayBuffer())
    const r = toMp3(new Uint8Array(body), 'audio/wav')
    return { ok: true, format: r.format, data: r.data, engine: 'ali' }
  } catch (e) {
    return { ok: false, error: `阿里 TTS 失败: ${(e as Error)?.message ?? String(e)}` }
  }
}

// ── 统一入口 ──

/**
 * 合成语音。engineOverride 指定引擎；否则用 cfg.defaultEngine。
 * voicedesign/voiceclone 需要额外小米 key（apiKey 由 cfg.xiaomi 提供）。
 * voiceDesc / overrideVoice 用于 voicedesign（动态音色描述/换声）与 voiceclone（风格指令）。
 */
export async function synthesize(
  text: string,
  cfg: TtsConfig,
  engineOverride?: string,
  voiceDesc?: string,
  overrideVoice?: boolean,
): Promise<TtsResult> {
  const engine = engineOverride || cfg?.defaultEngine || 'edge'
  const xiaomiKey = cfg?.xiaomi?.apiKey ?? ''
  const xiaomiBase = (cfg?.xiaomi?.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '')

  const runEngine = async (e: string): Promise<TtsResult> => runOne(e)

  // 单引擎分发（原 switch 抽成函数，供主引擎 + 降级链复用）
  async function runOne(e: string): Promise<TtsResult> {
  switch (e) {
    case 'edge':
      return (await synthesizeEdge(text, cfg?.edge)) ?? { ok: false, error: `Edge TTS 失败（voice 缺失）` }
    case 'xiaomi':
      if (cfg?.xiaomi?.enabled === false) return { ok: false, error: '小米 TTS 未启用' }
      return (await synthesizeXiaomi(text, cfg?.xiaomi)) ?? { ok: false, error: '小米 TTS 配置不完整（缺 apiKey）' }
    case 'voicedesign': {
      if (cfg?.voicedesign?.enabled === false) return { ok: false, error: '语音设计未启用' }
      if (xiaomiKey === '') return { ok: false, error: '语音设计需要小米 apiKey' }
      return (await synthesizeVoiceDesign(text, cfg?.voicedesign, xiaomiKey, xiaomiBase, voiceDesc ?? '', overrideVoice === true))
        ?? { ok: false, error: '语音设计配置不完整或未返回音频' }
    }
    case 'voiceclone': {
      if (cfg?.voiceclone?.enabled === false) return { ok: false, error: '语音克隆未启用' }
      if (xiaomiKey === '') return { ok: false, error: '语音克隆需要小米 apiKey' }
      return (await synthesizeVoiceClone(text, cfg?.voiceclone, xiaomiKey, xiaomiBase, voiceDesc ?? ''))
        ?? { ok: false, error: '语音克隆配置不完整（缺样本路径或未返回音频）' }
    }
    case 'local':
      if (cfg?.local?.enabled === false) return { ok: false, error: '本地 TTS 未启用' }
      return (await synthesizeLocal(text, cfg?.local)) ?? { ok: false, error: '本地 TTS 配置不完整' }
    case 'audio8':
      if (cfg?.audio8?.enabled === false) return { ok: false, error: 'Audio8 本地克隆未启用' }
      return (await synthesizeAudio8(text, cfg?.audio8)) ?? { ok: false, error: 'Audio8 本地克隆配置不完整（缺 cmd）' }
    case 'ali':
      if (cfg?.ali?.enabled === false) return { ok: false, error: '阿里 TTS 未启用' }
      return (await synthesizeAli(text, cfg?.ali)) ?? { ok: false, error: '阿里 TTS 配置不完整（缺 apiKey）' }
    default:
      return { ok: false, error: `未知 TTS 引擎: ${e}` }
  }
  }

  const primary = await runEngine(engine)
  // 手动试听（engineOverride）不降级：要如实暴露该引擎的报错，否则页面永远绿
  if (primary.ok || engineOverride) return primary

  // 2026-09-01 自动降级：首选引擎挂了不能把语音回复整个吞掉（老大实测 bot 只回文字不出声）。
  // 依次退到其它可用引擎，保证"发语音 ⇒ 回语音"，降级原因写日志与 degradedFrom 便于定位。
  const fallbackChain = ['local', 'edge', 'voiceclone', 'xiaomi'].filter((e) => e !== engine)
  for (const fb of fallbackChain) {
    try {
      const r = await runEngine(fb)
      if (r.ok) {
        console.warn(`[tts] 引擎 ${engine} 失败（${primary.error}），已自动降级到 ${fb}`)
        return { ...r, engine: fb, degradedFrom: engine }
      }
    } catch (e) {
      console.warn(`[tts] 降级引擎 ${fb} 抛错: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return primary
}
