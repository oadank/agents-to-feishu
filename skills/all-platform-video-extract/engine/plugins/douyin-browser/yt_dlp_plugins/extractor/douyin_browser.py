r"""抖音 extractor 插件：解析交给本机工具，下载交给 yt-dlp。

两种解析后端（`DOUYIN_RESOLVE` 切换，默认 auto）：
  · api（推荐）——「签名中转」：让浏览器发一次详情请求、我们抄下被 SDK 签好名的 URL，
    再用 Node 重放拿 JSON。约 2 秒、不播放视频、档位最全。脚本 `resolve_signed.mjs`
  · sniff ——「浏览器抓流」：让页面真播放，CDP 抓真实媒体地址。20~40 秒，但更抗改版。脚本 `sniff_download.mjs`
  · auto：先 api，失败自动退 sniff

两个后端吐同一种一行 JSON（`__RESOLVE_JSON__{...}`），下游 formats 处理完全共用。

🔴 为什么不在 Node 里直接算签名：`a_bogus` / `x-secsdk-web-signature` 由 webmssdk 的**自研 VM 字节码**
生成、由**拦截器自动注入 fetch**（2026-09-21 实测：219 个已加载脚本里搜不到这两个字面量；
公开入口 `window.byted_acrawler.frontierSign` 在真实请求中**调用 0 次**，只产 X-Bogus 那个旧签名）。
补环境复刻要同时拿下 webmssdk + secsdk + bdms 三套 SDK 并伪造整套设备指纹（uifid 是设备级标识，
服务端会校验一致性），代价过高 → 选「签名中转」，浏览器只借一道手、不参与下载。

用法：
    & yt-dlp.exe --plugin-dirs C:\D\opt\tools\yt-dlp\plugins "<抖音链接>"
前置：专用 Edge 开在本机调试口 9401（见 SKILL.md「第三条路」）。
"""
import json
import os
import shutil
import subprocess

from yt_dlp.extractor.common import InfoExtractor
from yt_dlp.utils import ExtractorError

_HOME = r'C:\D\opt\tools\yt-dlp'
_NODE = os.environ.get('DOUYIN_NODE') or shutil.which('node') or 'node'
_JOBS = {
    'api': (os.environ.get('DOUYIN_API_JS') or os.path.join(_HOME, 'resolve_signed.mjs'), '签名中转'),
    'sniff': (os.environ.get('DOUYIN_SNIFF_JS') or os.path.join(_HOME, 'sniff_download.mjs'), '浏览器抓流'),
}
_TIMEOUT = int(os.environ.get('DOUYIN_TIMEOUT') or 240)
_MARKER = '__RESOLVE_JSON__'


class DouyinBrowserIE(InfoExtractor):
    IE_NAME = 'douyin:browser'
    _VALID_URL = (
        r'https?://(?:(?:www\.)douyin\.com/(?:video|note)/[0-9]+'
        r'|v\.douyin\.com/[A-Za-z0-9_-]+)'
    )
    _TESTS = []

    def _park_page(self):
        """收尾：把浏览器页面停到不播东西的位置。

        🔴 老大 2026-09-21 点名要求。抖音视频页**播完会自动连播下一条**，窗口留在那儿就会在
        后台一直响；而且不光是抓流后端会播 —— 签名中转后端虽然只发一次接口请求，页面被留在
        视频页上抖音自己也会开始播。所以无论哪个后端、成功还是失败，跑完都得把页面收走。
        DOUYIN_KEEP_PAGE=1 可关掉（调试用）。
        """
        if os.environ.get('DOUYIN_KEEP_PAGE') == '1':
            return
        park = os.path.join(_HOME, 'park_page.mjs')
        if not os.path.isfile(park):
            return
        try:
            subprocess.run([_NODE, park], capture_output=True, timeout=20)
        except Exception:
            pass  # 收尾失败不影响下载结果

    def _resolve_via(self, kind, url):
        script, label = _JOBS[kind]
        if not os.path.isfile(script):
            raise ExtractorError(f'{label}脚本不存在：{script}')
        env = dict(os.environ, RESOLVE_JSON='1')
        try:
            try:
                proc = subprocess.run([_NODE, script, url], capture_output=True, timeout=_TIMEOUT, env=env)
            except FileNotFoundError:
                raise ExtractorError(f'找不到 node 解释器：{_NODE}')
            except subprocess.TimeoutExpired:
                raise ExtractorError(f'{label}超时（{_TIMEOUT}s）：专用 Edge 没开或没登录？')

            out = (proc.stdout or b'').decode('utf-8', 'replace')
            err = (proc.stderr or b'').decode('utf-8', 'replace')
            for line in out.splitlines():
                if line.startswith(_MARKER):
                    return json.loads(line[len(_MARKER):])

            tail = ' | '.join(out.strip().splitlines()[-3:]) or '(stdout 为空)'
            raise ExtractorError(
                f'{label}没吐出 JSON。末尾日志：{tail[:280]}'
                + (f' / stderr: {err.strip()[-200:]}' if err.strip() else '')
                + '\n提示：先确认专用 Edge 开在 9401 且已登录（见 SKILL.md 第三条路）',
                expected=True,
            )
        finally:
            self._park_page()  # 成功/失败/超时都收尾，别让页面留在视频页上自动连播

    def _resolve(self, url):
        mode = (os.environ.get('DOUYIN_RESOLVE') or 'auto').lower()
        if mode in _JOBS:
            return self._resolve_via(mode, url), mode
        try:
            return self._resolve_via('api', url), 'api'
        except ExtractorError as e:
            self.report_warning(f'接口后端不可用（{e}），退回抓流后端（较慢）')
            return self._resolve_via('sniff', url), 'sniff'

    def _real_extract(self, url):
        data, mode = self._resolve(url)
        formats = data.get('formats') or []
        if not formats:
            raise ExtractorError(f'{mode} 后端拿到 0 路媒体地址', expected=True)
        for f in formats:
            if not f.get('url'):
                continue
            # 媒体直链要带抖音站内 referer，否则 CDN 可能拒
            f.setdefault('http_headers', {})['Referer'] = 'https://www.douyin.com/'
        self.to_screen(f'[douyin] 解析后端={mode}，拿到 {len(formats)} 路')
        return {
            'id': str(data.get('id') or self._match_id(url)),
            'title': data.get('title') or 'douyin-video',
            'duration': data.get('duration'),
            'webpage_url': data.get('webpage_url') or url,
            'formats': formats,
        }
