"""Anysearch provider — anysearch.com MCP 搜索（2026-09-01 自研接入）.

API: MCP streamable HTTP ``POST {base_url}/mcp``（tools/call search）
Key: https://anysearch.com 申请（Bearer anysearch_api_key）

Auto-detect priority: 12（bocha=10 之后、tavily=20 之前——配了 key 就优先用）。
协议实测（2026-09-01）：单次 ``tools/call`` 即可搜索，无需先 initialize；
响应 ``result.content[0].text`` 是 markdown 文本（### N. 标题 / - **URL**: … / - 摘要行）。
"""

from __future__ import annotations

import logging
import re
from typing import Any

from ....config import settings
from ..base import (
    AuthFailedError,
    MissingCredentialError,
    NetworkUnreachableError,
    SearchResult,
)
from ..registry import register

logger = logging.getLogger(__name__)

_MCP_URL = "https://api.anysearch.com/mcp"

# markdown 结果块解析：### 1. 标题 → - **URL**: xxx → - 摘要（可多行）
_BLOCK_RE = re.compile(r"^###\s+\d+\.\s+(.+?)\s*$", re.MULTILINE)
_URL_RE = re.compile(r"^- \*\*URL\*\*:\s*(\S+?)\s*$", re.MULTILINE)


def _api_key() -> str:
    key = ""
    try:
        key = (getattr(settings, "anysearch_api_key", "") or "").strip()
    except Exception:  # noqa: BLE001
        key = ""
    if not key:
        import os

        key = (os.getenv("ANYSEARCH_API_KEY") or "").strip()
    return key


def _parse_markdown_results(text: str, max_results: int) -> list[SearchResult]:
    """把 anysearch 的 markdown 文本拆成 SearchResult 列表。"""
    blocks = _BLOCK_RE.split(text)
    # split 后：[前置文本, title1, body1, title2, body2, ...]
    out: list[SearchResult] = []
    for i in range(1, len(blocks) - 1, 2):
        title = blocks[i].strip()
        body = blocks[i + 1]
        url_m = _URL_RE.search(body)
        url = url_m.group(1) if url_m else ""
        # 摘要 = 除 URL 行外的 "- " 行拼接
        snippet_lines = [
            ln.lstrip("- ").strip()
            for ln in body.splitlines()
            if ln.strip().startswith("- ") and "**URL**" not in ln
        ]
        out.append(
            SearchResult(
                title=title,
                url=url,
                snippet=" ".join(s for s in snippet_lines if s)[:300],
                source="anysearch",
            )
        )
        if len(out) >= max_results:
            break
    return out


class AnysearchProvider:
    id = "anysearch"
    label = "Anysearch (anysearch.com)"
    requires_credential = True
    auto_detect_order = 12
    signup_url = "https://anysearch.com"
    docs_url = "https://anysearch.com"

    def is_available(self) -> bool:
        return bool(_api_key())

    async def search(
        self,
        query: str,
        *,
        max_results: int = 5,
        region: str = "wt-wt",
        safesearch: str = "moderate",
        timeout_seconds: float = 0.0,
    ) -> list[SearchResult]:
        key = _api_key()
        if not key:
            raise MissingCredentialError("ANYSEARCH_API_KEY not configured", provider_id=self.id)

        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "search",
                "arguments": {"query": query},
            },
        }
        timeout = timeout_seconds if timeout_seconds and timeout_seconds > 0 else 30.0

        import httpx

        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    _MCP_URL,
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {key}",
                        "X-Anysearch-Client": "mcp/1.0.0",
                        "Accept": "application/json, text/event-stream",
                    },
                )
        except Exception as exc:  # noqa: BLE001
            raise NetworkUnreachableError(
                f"anysearch transport failure: {type(exc).__name__}: {exc}",
                provider_id=self.id,
            ) from exc

        if resp.status_code in (401, 403):
            raise AuthFailedError(
                f"anysearch auth failed (HTTP {resp.status_code}): {resp.text[:200]}",
                provider_id=self.id,
            )
        if resp.status_code == 429:
            from ..base import RateLimitedError

            raise RateLimitedError("anysearch rate limited (HTTP 429)", provider_id=self.id)
        if resp.status_code >= 400:
            raise NetworkUnreachableError(
                f"anysearch HTTP {resp.status_code}: {resp.text[:200]}",
                provider_id=self.id,
            )

        try:
            data = resp.json()
        except ValueError as exc:
            raise NetworkUnreachableError(
                f"anysearch returned non-JSON (HTTP {resp.status_code})",
                provider_id=self.id,
            ) from exc

        if "error" in data:
            raise NetworkUnreachableError(
                f"anysearch MCP error: {data['error']}",
                provider_id=self.id,
            )

        content = (data.get("result") or {}).get("content") or []
        text = ""
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text += item.get("text") or ""

        if not text or "0 results" in text[:80]:
            return []
        return _parse_markdown_results(text, max_results)

    async def news_search(self, *args: Any, **kwargs: Any) -> list[SearchResult] | None:
        # anysearch 无独立 news 端点；返回 None 走 auto-detect 交给下一个 provider。
        return None


register(AnysearchProvider())
