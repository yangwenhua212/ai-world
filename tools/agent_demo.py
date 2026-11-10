"""AI World 后台智能体示例（无界面，纯 WebSocket 服务端）。

3D 页面会把你在 HUD 里输入 / 说出来的话以 {"type":"user","text":...} 发过来，
这里生成回复，再用 {"type":"message", ...} 或 {"type":"action", ...} 推回去：
角色就会拿手机看消息、回复、放下，或者直接去电脑前干活。

两种回复方式：
1. 默认（不配置模型）：关键词规则 + 模板回复，开箱即用，方便联调。
2. 配置 OpenAI 兼容接口后：改走模型生成回复，"要不要她去电脑干活"也交给模型判断。

环境变量：
    AI_WORLD_LLM_URL    例：https://api.openai.com/v1/chat/completions
    AI_WORLD_LLM_KEY    你的 API Key
    AI_WORLD_LLM_MODEL  例：gpt-4o-mini

运行：
    pip install websockets
    python -u tools/agent_demo.py

注意：与 tools/world_voice.py 同样使用 8777 端口，不要同时启动。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import urllib.request

import websockets

LLM_URL = os.environ.get("AI_WORLD_LLM_URL", "")
LLM_KEY = os.environ.get("AI_WORLD_LLM_KEY", "")
LLM_MODEL = os.environ.get("AI_WORLD_LLM_MODEL", "gpt-4o-mini")
LLM_ON = bool(LLM_URL and LLM_KEY)

# 动作类关键词：命中就直接驱动人物，不走聊天流程。
ACTIONS = [
    (re.compile(r"起床|醒来|睡醒"), "wake"),
    (re.compile(r"睡觉|躺下|上床|晚安|休息|困了"), "sleep"),
    (re.compile(r"玩.{0,3}电脑|用.{0,3}电脑|打字|干活|工作"), "computer"),
    (re.compile(r"看风景|窗外|风景|开窗"), "window"),
    (re.compile(r"手机"), "phone"),
    (re.compile(r"懒腰|伸展"), "stretch"),
    (re.compile(r"走动|散步|走两步|动一动"), "walk"),
]

# 普通聊天：按顺序匹配，命中就用对应回复。
CHAT_RULES = [
    (re.compile(r"你好|在吗|嗨|早上好|晚上好"), "在呀，我一直在房间里等你"),
    (re.compile(r"怎么样|还好吗|心情"), "挺好的，刚才还看了会儿窗外"),
    (re.compile(r"吃|饭|饿"), "我还不饿，你先去吃吧"),
]

# 被当成"要她做事"的消息：角色会直接去电脑前，而不是拿手机回复。
TASK_HINTS = re.compile(r"帮我|整理|查一下|查查|统计|写一[个份段]|总结|翻译|计划|安排|做一下|处理")

SYSTEM_PROMPT = (
    "你是住在 3D 房间里的二次元智能体。用简体中文、口语化、简短地回复（不超过 40 字）。"
    "只输出 JSON：{\"reply\": \"回复内容\", \"task\": true/false}。"
    "如果用户是在让你做事（整理、查资料、写东西等），task 为 true。"
)


def log(*args):
    print("[agent]", *args)


def _ask_llm(text: str) -> tuple[str, bool] | None:
    """调用 OpenAI 兼容的 chat/completions；失败返回 None 由调用方回退到规则。"""
    body = json.dumps(
        {
            "model": LLM_MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            "temperature": 0.7,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        LLM_URL,
        data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + LLM_KEY},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        content = data["choices"][0]["message"]["content"].strip()
        content = re.sub(r"^```(?:json)?|```$", "", content, flags=re.M).strip()
        out = json.loads(content)
        if isinstance(out.get("reply"), str):
            return out["reply"], bool(out.get("task"))
    except Exception as exc:  # 网络 / 额度 / 格式问题都回退到规则
        log("模型调用失败，回退规则：", exc)
    return None


def _rule_reply(text: str) -> tuple[str, bool]:
    if TASK_HINTS.search(text):
        return "好，我去电脑上处理一下", True
    for pattern, reply in CHAT_RULES:
        if pattern.search(text):
            return reply, False
    return "收到，我记下了", False


async def think(text: str) -> dict:
    """把用户的一句话变成页面能执行的一条指令。"""
    for pattern, action in ACTIONS:
        if pattern.search(text):
            return {"type": "action", "name": action}

    result = await asyncio.to_thread(_ask_llm, text) if LLM_ON else None
    reply, task = result or _rule_reply(text)
    return {
        "type": "message",
        "text": text,
        "mode": "task" if task else "chat",
        "reply": reply,
    }


async def handle(ws):
    peer = ws.remote_address
    log("页面已连接", peer)
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = msg.get("type")
            if kind == "user":
                text = str(msg.get("text", "")).strip()
                if text:
                    log("收到：", text)
                    await ws.send(json.dumps(await think(text), ensure_ascii=False))
            elif kind == "reply":
                log("她回复了：", msg.get("text"))
            elif kind == "speech-end":
                log("语音结束 interrupted=", msg.get("interrupted"))
    except websockets.ConnectionClosed:
        pass
    finally:
        log("页面断开", peer)


async def serve(host: str, port: int):
    async with websockets.serve(handle, host, port):
        log(f"已启动 ws://{host}:{port}（回复方式：{'LLM' if LLM_ON else '规则'}）")
        await asyncio.Future()


def main():
    parser = argparse.ArgumentParser(description="AI World 后台智能体示例")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8777)
    args = parser.parse_args()
    try:
        asyncio.run(serve(args.host, args.port))
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
