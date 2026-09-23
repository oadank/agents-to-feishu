#!/usr/bin/env python3
"""
微信公众号文章阅读脚本
通过模拟微信内置浏览器 UA 抓取文章内容，绕过反爬验证。
支持输出为纯文本或 Markdown 格式。
"""

import re
import sys
import json
import argparse
import urllib.request
from html import unescape


WECHAT_UA = (
    "Mozilla/5.0 (Linux; Android 13; SM-S901B) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/112.0.0.0 Mobile Safari/537.36 "
    "MicroMessenger/8.0.38"
)


def fetch_article(url: str, timeout: int = 30) -> str:
    """下载公众号文章 HTML"""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": WECHAT_UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def extract_article(html: str) -> dict:
    """从 HTML 中提取文章元数据和正文"""
    result = {"title": "", "author": "", "content": "", "summary": ""}

    # 标题
    m = re.search(r'var\s+msg_title\s*=\s*["\'](.+?)["\']', html)
    if m:
        result["title"] = m.group(1)
    else:
        m = re.search(r'var\s+otitle\s*=\s*["\'](.+?)["\']', html)
        if m:
            result["title"] = m.group(1)

    # 作者/公众号
    m = re.search(r'var\s+nickname\s*=\s*["\'](.+?)["\']', html)
    if m:
        result["author"] = unescape(m.group(1))

    # 摘要
    m = re.search(r'var\s+msg_desc\s*=\s*["\'](.+?)["\']', html)
    if m:
        result["summary"] = unescape(m.group(1))

    # 正文 - 提取 js_content
    m = re.search(r'id="js_content"[^>]*>(.*?)</div>\s*<', html, re.DOTALL)
    if m:
        raw = m.group(1)
        result["content"] = clean_html(raw)

    # 检查是否被验证页拦截
    if "wappoc_appmsgcaptcha" in html or "secitpt" in html:
        result["error"] = "文章被微信反爬验证拦截，请尝试更换 UA 或稍后重试"

    return result


def clean_html(raw: str) -> str:
    """将 HTML 正文转为可读文本（保留段落结构）"""
    # 保留段落分隔
    text = re.sub(r'<(br|p|div)\b[^>]*>', '\n', raw, flags=re.IGNORECASE)
    text = re.sub(r'</(p|div)\b[^>]*>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', '', text)
    text = unescape(text)
    # 合并多余空行
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def to_markdown(article: dict) -> str:
    """将文章转为 Markdown 格式"""
    lines = []
    if article.get("title"):
        lines.append(f"# {article['title']}")
        lines.append("")
    if article.get("author"):
        lines.append(f"**作者**: {article['author']}")
    if article.get("summary"):
        lines.append(f"**摘要**: {article['summary']}")
    lines.append("")
    lines.append("---")
    lines.append("")
    if article.get("content"):
        lines.append(article["content"])
    if article.get("error"):
        lines.append(f"\n⚠️ {article['error']}")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="读取微信公众号文章内容")
    parser.add_argument("url", help="公众号文章链接")
    parser.add_argument("--format", choices=["text", "markdown", "json"],
                        default="text", help="输出格式 (默认: text)")
    args = parser.parse_args()

    html = fetch_article(args.url)
    article = extract_article(html)

    if args.format == "json":
        print(json.dumps(article, ensure_ascii=False, indent=2))
    elif args.format == "markdown":
        print(to_markdown(article))
    else:
        if article.get("title"):
            print(f"标题: {article['title']}")
        if article.get("author"):
            print(f"作者: {article['author']}")
        if article.get("summary"):
            print(f"摘要: {article['summary']}")
        print()
        if article.get("content"):
            print(article["content"])
        if article.get("error"):
            print(f"\n⚠️ {article['error']}")


if __name__ == "__main__":
    main()
