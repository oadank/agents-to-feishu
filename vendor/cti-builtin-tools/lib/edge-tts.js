/**
 * Microsoft Edge TTS — 原生 WebSocket 客户端（免费，无需 API key）。
 * 从 deepseek-harness packages/host/apiproxy/src/edge-tts.ts 移植（TTS 独立化），
 * 对齐 Python edge-tts v7.2.8 的 DRM + Headers；Sec-MS-GEC 令牌放在 URL 参数里。
 */

import WebSocket from 'ws'
import { createHash, randomBytes } from 'node:crypto'

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud'
const CHROMIUM_FULL_VERSION = '143.0.3650.75'
const CHROMIUM_MAJOR_VERSION = '143'
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`
const WIN_EPOCH = 11644473600
const S_TO_NS = 1e9

function generateSecMsGec() {
  let ticks = Date.now() / 1000
  ticks += WIN_EPOCH
  ticks -= ticks % 300
  ticks *= S_TO_NS / 100
  const strToHash = `${Math.floor(ticks)}${TRUSTED_CLIENT_TOKEN}`
  return createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase()
}

function generateMuid() {
  return randomBytes(16).toString('hex').toUpperCase()
}

function uuid() {
  return crypto.randomUUID().replaceAll('-', '')
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function getWssUrl() {
  return `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
    + `&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
}

function getWssHeaders() {
  return {
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
    'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cookie': `muid=${generateMuid()};`,
  }
}

/**
 * [2026-09-01 同步改造] 与 harness apiproxy edge-tts.ts 对齐：单次尝试收流超时 12s
 * （Edge 正常 1-3 秒完成）+ settled 防重复回调 + 外层重试最多 3 次（间隔 500ms/1s 递增）。
 * @param {string} text - plain text to speak.
 * @param {string} voice - Edge voice name.
 * @returns {Promise<Buffer>} MP3 bytes (audio-24khz-48kbitrate-mono-mp3).
 */
function edgeTtsOnce(text, voice) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getWssUrl(), { headers: getWssHeaders() })
    const audioData = []
    let messageTimeout
    let settled = false
    const settle = (done) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimeout)
      if (messageTimeout !== undefined) clearTimeout(messageTimeout)
      done()
    }

    const connectTimeout = setTimeout(() => {
      ws.terminate()
      settle(() => reject(new Error('Edge TTS WebSocket connect timeout (10s)')))
    }, 10_000)

    ws.on('message', (rawData, isBinary) => {
      const buf = rawData
      if (!isBinary) {
        const str = buf.toString('utf8')
        if (str.includes('turn.end')) {
          settle(() => resolve(Buffer.concat(audioData)))
          ws.close()
        }
        return
      }
      const separator = 'Path:audio\r\n'
      const idx = buf.indexOf(separator)
      if (idx !== -1) audioData.push(buf.subarray(idx + separator.length))
    })

    ws.on('error', (err) => {
      ws.terminate()
      settle(() => reject(err))
    })

    ws.on('open', () => {
      clearTimeout(connectTimeout)
      // 收流超时 12s：正常合成 1-3 秒完成，超时基本等于链路异常，交给重试层。
      messageTimeout = setTimeout(() => {
        ws.terminate()
        settle(() => reject(new Error('Edge TTS message timeout (12s)')))
      }, 12_000)

      const speechConfig = JSON.stringify({
        context: { synthesis: { audio: {
          metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
          outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        } } },
      })
      const configMsg = `X-Timestamp:${Date()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${speechConfig}`
      ws.send(configMsg, { compress: true })

      const ssml = '<speak version=\'1.0\' xmlns=\'http://www.w3.org/2001/10/synthesis\' xml:lang=\'zh-CN\'>'
        + `<voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`
      const ssmlMsg = `X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${Date()}Z\r\nPath:ssml\r\n\r\n${ssml}`
      ws.send(ssmlMsg, { compress: true })
    })
  })
}

const MAX_ATTEMPTS = 3

/** 带重试的 Edge TTS：最多 3 次尝试（首次 + 2 次重试），失败间隔递增（500ms/1s）。 */
export async function edgeTts(text, voice = 'zh-CN-XiaoxiaoNeural') {
  let lastErr
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await edgeTtsOnce(text, voice)
    } catch (err) {
      lastErr = err
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * attempt))
    }
  }
  throw lastErr
}