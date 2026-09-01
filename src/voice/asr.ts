/**
 * 内建 ASR（语音识别）—— 三模式（对齐 dsh-input-tools）：
 *   service = 本地常驻 HTTP 服务（如 sherpa 18790，POST /transcribe {audioPath}）
 *   cmd     = 本地命令（sherpa-onnx-offline.exe，结果在 stderr 的 text JSON 里）
 *   api     = 在线 API（OpenAI 兼容 chat/completions + input_audio；含 openai 地址走 Whisper 风格）
 * 音频统一先转 16k 单声道 PCM WAV（需 ffmpeg，失败则用原文件）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'

export interface AsrConfig {
  enabled: boolean
  mode: 'service' | 'cmd' | 'api'
  url: string        // service 模式：本地常驻服务地址，如 http://127.0.0.1:18790
  cmd: string        // cmd 模式：本地命令（含参数）
  apiKey: string     // api 模式
  apiBaseUrl: string // api 模式：https://api.xiaomimimo.com/v1；含 openai 走 Whisper 风格
}

export const DEFAULT_ASR: AsrConfig = {
  enabled: true,
  mode: 'service',
  url: 'http://127.0.0.1:18790',
  cmd: '',
  apiKey: '',
  apiBaseUrl: 'https://api.xiaomimimo.com/v1',
}

export interface AsrResult {
  ok: boolean
  text?: string
  error?: string
}

/** 解析 ffmpeg 可执行路径：环境变量 > WinGet 用户链接（LocalSystem 服务进程无用户 PATH，且 os.homedir() 指向 systemprofile 不可用）> PATH */
export function resolveFfmpeg(): string {
  if (process.env.FFMPEG_BIN && fs.existsSync(process.env.FFMPEG_BIN)) return process.env.FFMPEG_BIN
  // 服务进程（LocalSystem）没有用户 PATH：用真实用户目录兜底（配置中心服务专用本机，CTI_USER_HOME 已注入）
  const userHome = process.env.CTI_USER_HOME || process.env.USERPROFILE || 'C:\\Users\\oadan'
  const winGetFfmpeg = path.join(userHome, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')
  if (fs.existsSync(winGetFfmpeg)) return winGetFfmpeg
  return 'ffmpeg'
}

const FFMPEG_BIN_ASR = resolveFfmpeg()

/** 把任意音频 buffer 转成 16k 单声道 wav（临时文件），失败返回 null */
function to16kWav(audioBytes: Buffer, tmpDir: string): string | null {
  try {
    const rawPath = path.join(tmpDir, `asr-${crypto.randomUUID()}.raw`)
    const wavPath = path.join(tmpDir, `asr-${crypto.randomUUID()}.wav`)
    fs.writeFileSync(rawPath, audioBytes)
    try {
      execFileSync(FFMPEG_BIN_ASR, ['-y', '-i', rawPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath], {
        windowsHide: true, stdio: 'ignore', timeout: 30_000,
      })
      fs.unlinkSync(rawPath)
      // 缓存最近一次录音到 ~/.dsh/last-voice.wav（供"用我刚才那段语音克隆音色"用，不阻塞识别）
      try {
        const homeDir = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
        fs.mkdirSync(homeDir, { recursive: true })
        fs.copyFileSync(wavPath, path.join(homeDir, 'last-voice.wav'))
      } catch { /* 缓存失败不影响识别 */ }
      return wavPath
    } catch {
      // ffmpeg 失败：仅当原数据已是标准 WAV 时直接用（改 .wav 扩展名，sherpa 吃扩展名判定），
      // 否则返回 null（宁可报"转 wav 失败"，也不把 .raw/未知格式发给 sherpa 导致其崩溃 0xC0000005）
      const isWav = audioBytes.length > 12
        && audioBytes[0] === 0x52 && audioBytes[1] === 0x49 // RI
        && audioBytes[2] === 0x46 && audioBytes[3] === 0x46 // FF
        && audioBytes.slice(8, 12).toString('latin1') === 'WAVE'
      if (isWav) {
        fs.unlinkSync(rawPath)
        fs.writeFileSync(wavPath, audioBytes)
        return wavPath
      }
      return null
    }
  } catch {
    return null
  }
}

/** 解析 Windows 命令行参数（处理双引号：引号内空格不拆、剥掉引号）；根治带引号路径 cmd。 */
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

/** 识别一段音频（buffer），返回文本。 */
export async function transcribe(audioBytes: Buffer, cfg: AsrConfig): Promise<AsrResult> {
  if (!cfg.enabled) return { ok: false, error: 'ASR 未启用' }
  if (!audioBytes || audioBytes.length === 0) return { ok: false, error: '缺少音频数据' }

  const tmpDir = process.env.TEMP || os.tmpdir()
  const wavPath = to16kWav(audioBytes, tmpDir)
  if (!wavPath) return { ok: false, error: '音频转 wav 失败' }

  try {
    // 1) service：本地常驻 HTTP
    if (cfg.mode === 'service' && cfg.url.trim() !== '') {
      const baseUrl = cfg.url.trim().replace(/\/+$/, '')
      const resp = await fetch(`${baseUrl}/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audioPath: wavPath }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!resp.ok) return { ok: false, error: `ASR 服务返回 ${resp.status}` }
      const payload = await resp.json().catch(() => ({})) as { text?: string }
      const text = (payload.text ?? '').trim()
      if (text === '') return { ok: false, error: 'ASR 服务未返回文本' }
      return { ok: true, text }
    }

    // 2) cmd：本地命令（sherpa-onnx，结果在 stdout/stderr 的 "text":"..." JSON）
    if (cfg.mode === 'cmd' && cfg.cmd.trim() !== '') {
      const parts = splitCommandLine(cfg.cmd.trim())
      const bin = parts[0]
      if (!bin) return { ok: false, error: '命令格式错误' }
      const result = spawnSync(bin, [...parts.slice(1), wavPath], {
        windowsHide: true, encoding: 'utf-8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
      })
      const all = (result.stdout ?? '') + '\n' + (result.stderr ?? '')
      const m = all.match(/"text"\s*:\s*"([^"]*)"/)
      const text = (m?.[1] ?? '').trim()
      if (text === '') return { ok: false, error: '本地命令未输出识别结果' }
      return { ok: true, text }
    }

    // 3) api：在线（OpenAI 兼容 chat/completions input_audio；含 openai 走 Whisper 风格）
    if (cfg.mode === 'api' && cfg.apiKey.trim() !== '') {
      const apiKey = cfg.apiKey.trim()
      const baseUrl = (cfg.apiBaseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '')
      const audioBase64 = audioBytes.toString('base64')
      if (baseUrl.includes('openai')) {
        // Whisper 风格（multipart file + model）
        const form = new FormData()
        form.append('file', new Blob([audioBytes], { type: 'audio/wav' }), 'audio.wav')
        form.append('model', 'whisper-1')
        const resp = await fetch(`${baseUrl}/audio/transcriptions`, {
          method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form,
          signal: AbortSignal.timeout(60_000),
        })
        if (!resp.ok) return { ok: false, error: `ASR API 返回 ${resp.status}` }
        const payload = await resp.json().catch(() => ({})) as { text?: string }
        const text = (payload.text ?? '').trim()
        if (text === '') return { ok: false, error: 'ASR API 未返回文本' }
        return { ok: true, text }
      }
      // 小米 mimo-v2.5-asr：chat/completions + input_audio dataURL
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'mimo-v2.5-asr',
          messages: [{ role: 'user', content: [
            { type: 'text', text: '请把这段语音转写成文字，只输出文字内容。' },
            { type: 'input_audio', input_audio: { data: audioBase64, format: 'wav' } },
          ] }],
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!resp.ok) return { ok: false, error: `ASR API 返回 ${resp.status}` }
      const payload = await resp.json() as { choices?: Array<{ message?: { content?: unknown } }> }
      const raw = payload?.choices?.[0]?.message?.content
      const text = (typeof raw === 'string' ? raw : '').trim()
      if (text === '') return { ok: false, error: 'ASR API 未返回文本' }
      return { ok: true, text }
    }

    return { ok: false, error: `ASR 配置不完整（mode=${cfg.mode} 缺必要参数）` }
  } finally {
    try { fs.unlinkSync(wavPath) } catch { /* 忽略 */ }
  }
}