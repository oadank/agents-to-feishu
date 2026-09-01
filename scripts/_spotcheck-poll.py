#!/usr/bin/env python3
"""读取指定 bot 私聊最新的 bot(card/text) 回复正文，用于抽测轮询。
用法: python poll_reply.py <chat_id> [--len N]
"""
import json
import re
import subprocess
import sys

def main():
    chat_id = sys.argv[1]
    limit = 1200
    if '--len' in sys.argv:
        limit = int(sys.argv[sys.argv.index('--len') + 1])
    out = subprocess.run(
        ['cmd.exe', '/c', 'lark-cli', 'im', '+chat-messages-list', '--chat-id', chat_id, '--as', 'user'],
        capture_output=True, text=True, encoding='utf-8', timeout=60,
    )
    data = json.loads(out.stdout)
    msgs = data.get('data', {}).get('messages', [])
    shown = 0
    for m in msgs:
        if m.get('sender', {}).get('sender_type') != 'app':
            continue
        content = m.get('content', '')
        try:
            parsed = json.loads(content)
            if isinstance(parsed, dict) and 'text' in parsed:
                content = parsed['text']
        except Exception:
            pass
        content = re.sub(r'<[^>]+>', ' ', content)
        print(f"--- [{m.get('create_time')}] msg_type={m.get('msg_type')}")
        print(content[:limit])
        shown += 1
        if shown >= 2:
            break
    if shown == 0:
        print('(no app reply yet)')

if __name__ == '__main__':
    main()
