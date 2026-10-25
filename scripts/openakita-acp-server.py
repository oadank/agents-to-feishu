#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OpenAkita ACP server — 把 openakita 接入 agents-to-im（ACP 协议，JSON-RPC over stdio）

用法: openakita-venv/python.exe openakita-acp-server.py
环境:
  OPENAKITA_ACP_WORKSPACE   openakita workspace（默认 ~/.openakita/workspaces/default）
  LLM_ENDPOINTS_CONFIG      端点配置（默认 <workspace>/data/llm_endpoints.json）

协议（对齐 agents-to-im 的 reasonix-provider ACP client）:
  -> initialize
  -> session/new {cwd, mcpServers}          <- {sessionId}
  -> session/load {sessionId, cwd, ...}     <- {sessionId}
  -> session/prompt {sessionId, prompt}     <- 流式 session/update + session/result
  -> session/cancel {sessionId}
事件映射:
  thinking_delta -> agent_thought_chunk
  text_delta     -> agent_message_chunk
  chain_text     -> activity_event (tool 叙事)
  tool_call_*    -> activity_event (tool_activity)
"""
import asyncio
import json
import os
import sys
import time
import uuid

# ── 必须在 import openakita 之前 chdir（settings.project_root 在 import 时按 cwd 初始化）──
WS = os.environ.get(
    "OPENAKITA_ACP_WORKSPACE",
    os.path.join(os.path.expanduser("~"), ".openakita", "workspaces", "default"),
)
os.chdir(WS)
os.environ.setdefault("LLM_ENDPOINTS_CONFIG", os.path.join(WS, "data", "llm_endpoints.json"))
os.environ.setdefault("OPENAKITA_AUTO_CONFIRM", "1")
BANNER = "日志预检"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ── 防止 openakita 日志污染 ACP stdout 通道 ──
# openakita 在 import 时会把 logging handler 绑到当时的 sys.stdout，
# 因此 import 期间临时把 stdout 换成 stderr，让 handler 永久指向 stderr。
_real_stdout = sys.stdout
sys.stdout = sys.stderr

# [2026-10-17 日志预检] 上一个进程若被 nssm restart 落成孤儿（venv 启动器→真 python 的
# 孙进程链杀不干净），会一直握着 openakita.log → 新进程 setup_logging 直接 PermissionError
# 退出 code=1，bot 整条链瘫。这里在 import openakita 前先试锁：打不开就把旧日志改名让路，
# 新进程建新文件，旧进程继续写它的旧 inode（Windows 改名后句柄仍有效），双活不冲突。
_candidates = [os.path.join(WS, "logs", "openakita.log")]
try:
    import re as _re
    _ws_env = os.path.join(WS, ".env")
    if os.path.isfile(_ws_env):
        _m = _re.search(r'^LOG_DIR=(.+)$', open(_ws_env, encoding="utf-8", errors="replace").read(), _re.M)
        if _m:
            _ld = _m.group(1).strip().strip('"')
            if not os.path.isabs(_ld):
                _ld = os.path.join(WS, _ld)
            if _ld not in _candidates:
                _candidates.append(os.path.join(_ld, "openakita.log"))
except Exception:
    pass
for _log_file in _candidates:
    try:
        _probe = open(_log_file, "a", encoding="utf-8")
        _probe.close()
        continue
    except FileNotFoundError:
        continue
    except PermissionError:
        _alt = _log_file + f".orphan-{time.strftime('%Y%m%d-%H%M%S')}"
        try:
            os.rename(_log_file, _alt)
            sys.stderr.write(f"[acp] {BANNER} {_log_file} 被孤儿占用，已改名让路\n"); sys.stderr.flush()
        except OSError as _oe:
            sys.stderr.write(f"[acp] {BANNER} {_log_file} 改名失败: {_oe}\n"); sys.stderr.flush()
    except Exception as _oe:
        sys.stderr.write(f"[acp] {BANNER} {_log_file} 预检异常: {_oe}\n"); sys.stderr.flush()

from openakita.main import get_agent  # noqa: E402
from openakita.sessions.session import Session  # noqa: E402

sys.stdout = _real_stdout

import logging as _logging

for _h in list(_logging.getLogger().handlers):
    if isinstance(_h, _logging.StreamHandler) and getattr(_h, "stream", None) in (sys.stdout, _real_stdout):
        try:
            _h.stream = sys.stderr
        except Exception:
            pass
_logging.getLogger().addHandler(_logging.StreamHandler(sys.stderr))

agent = None
sessions: dict[str, dict] = {}  # acp_id -> {"ok_session": Session, "history": [...], "task": Task}
_running_prompt: dict | None = None  # acp_id of current prompt (串行)


def send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _dbg(msg: str) -> None:
    try:
        sys.stderr.write(msg + "\n")
        sys.stderr.flush()
    except Exception:
        pass


async def _dump_pending_tasks(tag: str) -> None:
    """[2026-10-17 探挂] agent.initialize 挂死排查：把所有挂起协程的栈吐到 stderr（rt.log 可见）。"""
    try:
        import asyncio as _aio
        tasks = [t for t in _aio.all_tasks() if not t.done()]
        _dbg(f"[acp][hangdump:{tag}] pending tasks={len(tasks)}")
        for t in tasks:
            _dbg(f"[acp][hangdump:{tag}] ---- {t.get_name()}")
            for line in t.print_stack(limit=12).splitlines():
                _dbg(f"[acp][hangdump:{tag}]   {line}")
    except Exception as exc:
        _dbg(f"[acp][hangdump:{tag}] dump failed: {exc}")


async def get_agent_safe():
    global agent
    if agent is None:
        agent = get_agent()
        # [2026-10-17 探挂] initialize 挂死不改语义：300s 超时先吐 hangdump 再继续等，
        # 每 300s 重复 dump 一次，定位卡死的 await 后即可移除本探针。
        init_t = asyncio.ensure_future(agent.initialize())
        while True:
            done, _p = await asyncio.wait({init_t}, timeout=300)
            if done:
                await init_t  # 透传结果/异常
                _dbg("[acp] agent.initialize completed")
                return
            await _dump_pending_tasks("initialize-300s")
    return agent


def make_ok_session(acp_id: str) -> Session:
    return Session(
        id=f"acp-{uuid.uuid4().hex[:8]}",
        channel="acp",
        chat_id=acp_id,
        user_id="reasonix-bridge",
        working_directory=WS,
        # trust 模式：跳过 RiskIntentGate / security_confirm 等确认拦截（ACP 无人确认）
        confirmation_mode_override="trust",
        session_role="agent",
    )


async def emit_update(acp_id: str, update: dict) -> None:
    send({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {"sessionId": acp_id, "update": update},
    })


async def handle_prompt(acp_id: str, prompt: str, req_id: int) -> None:
    global _running_prompt
    _dbg(f"[acp] handle_prompt enter acp={acp_id} req={req_id} prompt={prompt[:60]!r}")
    st = sessions[acp_id]
    _dbg("[acp] get_agent_safe...")
    try:
        a = await get_agent_safe()
    except BaseException:
        # [T-0031 批一 09-30] 预备段（agent 构建）失败同样会带着闸门死掉：
        # _running_prompt 已置位，不复位 = main_loop 死等 + stdin 停读 = 进程死锁。
        _running_prompt = None
        raise
    _dbg("[acp] agent ready, start chat_with_session_stream...")

    # 预授权（RiskIntentGate 单次放行）：openakita 对 free-form streaming 会等确认，
    # ACP 环境无人确认，写入 risk_authorized_replay 让其跳过（30s 内精确匹配消息）。
    try:
        st["ok_session"].set_metadata("risk_authorized_replay", {
            "expires_at": time.time() + 60,
            "original_message": prompt,
        })
        _dbg("[acp] risk_authorized_replay stamped")
    except Exception as exc:
        _dbg(f"[acp] stamp risk_authorized failed: {exc}")

    reply_parts: list[str] = []
    is_error = False
    err_text = ""

    try:
        async for ev in a.chat_with_session_stream(
            message=prompt,
            session_messages=list(st["history"]),
            session_id=st["ok_session"].id,
            session=st["ok_session"],
            gateway=None,
            mode="agent",
        ):
            t = ev.get("type")
            if t == "thinking_delta":
                await emit_update(acp_id, {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": {"type": "text", "text": ev.get("content", "")},
                })
            elif t == "text_delta":
                chunk = ev.get("content", "")
                reply_parts.append(chunk)
                await emit_update(acp_id, {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": chunk},
                })
            elif t == "chain_text":
                # 工具/过程叙事 → activity（不污染正文）
                await emit_update(acp_id, {
                    "sessionUpdate": "activity_event",
                    "activity": {"kind": "progress", "text": str(ev.get("content", ""))[:500]},
                })
            elif t == "tool_call_start":
                name = ev.get("tool") or ev.get("name") or "tool"
                await emit_update(acp_id, {
                    "sessionUpdate": "tool_call",
                    "title": str(name),
                    "status": "running",
                    "toolCallId": f"ok-tool:{name}:{uuid.uuid4().hex[:6]}",
                    "input": {},
                })
            elif t == "tool_call_end":
                name = ev.get("tool") or ev.get("name") or "tool"
                await emit_update(acp_id, {
                    "sessionUpdate": "tool_call",
                    "title": str(name),
                    "status": "completed",
                    "toolCallId": f"ok-tool:{name}",
                    "output": str(ev.get("content", ""))[:500],
                })
            elif t == "done":
                # 2026-09-01 修复：不能 break！done 是外层 chat_with_session_stream 内部
                # reason_stream 中途 yield 的，此时外层生成器还停在 yield event 上，
                # break 会抛弃生成器 → _finalize_session（缓存 _last_usage_summary）
                # 永远不执行 → _meta.usage 永远为空。改为 drain 到生成器自然结束。
                pass
            elif t == "error":
                is_error = True
                err_text = str(ev.get("content") or ev.get("error") or "openakita error")
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        is_error = True
        err_text = f"{type(exc).__name__}: {exc}"
    finally:
        # [T-0031 批一 09-30] 闸门复位必须无条件执行：/stop 的 CancelledError 此前走
        # raise 跳过复位 → main_loop 的 while _running_prompt 死等 + stdin 停读 =
        # 一次 /stop 即进程死锁（审计 P0）。finally 保证 cancel/异常/成功三路都抬闸。
        _running_prompt = None

    # 更新历史（只在成功时记 assistant 回复）
    if not is_error:
        st["history"].append({"role": "user", "content": prompt})
        reply = "".join(reply_parts)
        st["history"].append({"role": "assistant", "content": reply})
    else:
        st["history"].append({"role": "user", "content": prompt})

    send({
        "jsonrpc": "2.0",
        "id": req_id,
        "result": {
            "sessionId": acp_id,
            "isError": is_error,
            "stopReason": "error" if is_error else "end_turn",
            "result": {
                "type": "text",
                "text": err_text if is_error else "".join(reply_parts),
            },
            # 2026-09-01 状态条修复：openakita 流事件不带 usage，但每轮收尾时
            # reasoning_engine._last_usage_summary 有 token 摘要（input_tokens/output_tokens）。
            # 桥接层 engine.ts 从 prompt 响应 _meta.usage 兜底捞 usage → recordStats 落盘，
            # 状态条 🎯/🟰 才有命中率数据（此前永远空）。
            "_meta": _usage_meta(a),
        },
    })


def _usage_meta(agent_obj) -> dict:
    """从 Agent._last_usage_summary 提取 usage 挂到 _meta（no-throw）。

    字段在 Agent 本体（_agent_runtime.py: _finalize_session 里缓存），
    同时兜底 reasoning_engine 路径以防版本差异。"""
    try:
        summary = getattr(agent_obj, "_last_usage_summary", None) or {}
        if not summary:
            summary = getattr(getattr(agent_obj, "reasoning_engine", None), "_last_usage_summary", None) or {}
        inp = int(summary.get("input_tokens") or 0)
        out = int(summary.get("output_tokens") or 0)
        if inp <= 0 and out <= 0:
            return {}
        return {"usage": {
            "inputTokens": inp,
            "outputTokens": out,
            "cacheReadTokens": 0,
            "requests": 1,
        }}
    except Exception:
        return {}


async def handle_cancel(acp_id: str) -> None:
    st = sessions.get(acp_id)
    if st and st.get("task") and not st["task"].done():
        st["task"].cancel()
        send({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": acp_id}})


async def main_loop() -> None:
    global _running_prompt
    loop = asyncio.get_running_loop()
    req_counter = [0]

    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = msg.get("method", "")
        req_id = msg.get("id")
        params = msg.get("params") or {}

        if method == "initialize":
            send({"jsonrpc": "2.0", "id": req_id, "result": {
                "protocolVersion": 1,
                "capabilities": {"session": True},
                "model": {"id": "openakita", "name": "OpenAkita"},
            }})
            # [2026-10-17 提速] agent.initialize 实测要 4~5 分钟（技能/插件扫描 + 冷缓存），
            # 懒加载会让首条消息干等。握手完成即后台预热，真消息到达时通常已就绪。
            asyncio.ensure_future(get_agent_safe())
        elif method == "session/new":
            acp_id = f"ok-{uuid.uuid4().hex[:12]}"
            sessions[acp_id] = {"ok_session": make_ok_session(acp_id), "history": [], "task": None}
            send({"jsonrpc": "2.0", "id": req_id, "result": {"sessionId": acp_id}})
        elif method == "session/load":
            sid = params.get("sessionId", "")
            if sid in sessions:
                send({"jsonrpc": "2.0", "id": req_id, "result": {"sessionId": sid}})
            else:
                send({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32001, "message": "Session not found"}})
        elif method == "session/prompt":
            sid = params.get("sessionId", "")
            _dbg(f"[acp] session/prompt received sid={sid} prompt={str(params.get('prompt',''))[:40]!r}")
            if sid not in sessions:
                send({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32001, "message": "Session not found"}})
                continue
            prompt = params.get("prompt", "")
            # 兼容 ACP 数组格式 [{"type":"text","text":"..."}] 和裸字符串
            if isinstance(prompt, list):
                prompt = "".join(
                    item.get("text", "") for item in prompt if isinstance(item, dict)
                )
            if not isinstance(prompt, str):
                prompt = str(prompt)
            # 串行执行（openakita 单 agent），不并发
            _dbg(f"[acp] prompt branch: _running_prompt={_running_prompt!r}")
            while _running_prompt is not None:
                await asyncio.sleep(0.1)
            _running_prompt = sid
            req_counter[0] += 1
            _dbg("[acp] before create_task")
            task = loop.create_task(handle_prompt(sid, prompt, req_id))
            _dbg("[acp] after create_task")
            sessions[sid]["task"] = task
        elif method == "session/cancel":
            sid = params.get("sessionId", "")
            await handle_cancel(sid)
        else:
            if req_id is not None:
                send({"jsonrpc": "2.0", "id": req_id, "result": {}})


if __name__ == "__main__":
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        pass
