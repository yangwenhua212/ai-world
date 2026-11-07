"""AI World 语音桥 —— 给任意智能体用的本地 WebSocket 服务端。

世界页面会主动连到 ws://127.0.0.1:8777（页面可用 ?bridge=ws://host:port 覆盖）。
智能体拿到 TTS 音频后调用 speak()，页面就会播放并驱动口型。

用法：
    from world_voice import WorldVoice

    voice = WorldVoice()                      # 默认 127.0.0.1:8777
    await voice.start()
    await voice.speak(wav_bytes, text="你好，我是你的智能体")
    await voice.stop()                        # 用户打断时调用

单独运行做联调（页面一连上来就自动发一段测试音）：
    python world_voice.py --demo
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import math
import struct
import wave

import websockets


class WorldVoice:
    def __init__(self, host: str = "127.0.0.1", port: int = 8777):
        self.host = host
        self.port = port
        self._clients: set = set()
        self._server = None
        self._demo_on_connect = False
        self.on_speech_end = None  # 可选：def on_speech_end(interrupted: bool)

    async def start(self) -> "WorldVoice":
        self._server = await websockets.serve(self._handle, self.host, self.port)
        return self

    async def _handle(self, ws) -> None:
        self._clients.add(ws)
        try:
            if self._demo_on_connect:
                await asyncio.sleep(0.4)
                await self._send_to(ws, {
                    "type": "speak",
                    "data": base64.b64encode(build_demo_wav(2.0)).decode("ascii"),
                    "mime": "audio/wav",
                    "text": "你好，我是你的智能体，现在住在 AI World 里。",
                })
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                if msg.get("type") == "speech-end" and self.on_speech_end:
                    self.on_speech_end(bool(msg.get("interrupted")))
        finally:
            self._clients.discard(ws)

    async def _send_to(self, ws, payload) -> None:
        try:
            await ws.send(json.dumps(payload, ensure_ascii=False))
        except Exception:
            self._clients.discard(ws)

    async def _broadcast(self, payload) -> bool:
        """发给所有已连接页面；返回是否有页面收到。"""
        text = json.dumps(payload, ensure_ascii=False)
        dead = []
        sent = False
        for ws in list(self._clients):
            try:
                await ws.send(text)
                sent = True
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._clients.discard(ws)
        return sent

    # ---- 对 Hermes 暴露的动作 ----

    async def speak(self, audio: bytes, text: str = "", mime: str = "audio/wav") -> bool:
        """播放一段完整音频（wav / mp3 等），同时按音量驱动口型。"""
        return await self._broadcast({
            "type": "speak",
            "data": base64.b64encode(audio).decode("ascii"),
            "mime": mime,
            "text": text,
        })

    async def speak_url(self, url: str, text: str = "") -> bool:
        return await self._broadcast({"type": "speak", "url": url, "text": text})

    async def stop(self) -> bool:
        """打断当前这句（页面会立刻闭口）。"""
        return await self._broadcast({"type": "stop"})

    async def mouth(self, value: float) -> bool:
        """手动驱动口型 0~1（没有音频时也可用）。"""
        return await self._broadcast({"type": "mouth", "value": float(value)})

    async def expression(self, name: str) -> bool:
        """happy / angry / sad / relaxed / surprised"""
        return await self._broadcast({"type": "expression", "name": name})

    async def action(self, name: str) -> bool:
        """角色动作：sleep | wake | phone | stretch | walk"""
        return await self._broadcast({"type": "action", "name": str(name)})

    async def state(self, sitting=None, room_visible=None, preset=None) -> bool:
        msg = {"type": "state"}
        if sitting is not None:
            msg["sitting"] = bool(sitting)
        if room_visible is not None:
            msg["roomVisible"] = bool(room_visible)
        if preset:
            msg["preset"] = str(preset)
        return await self._broadcast(msg)

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        self._clients.clear()


def pcm_to_wav(pcm: bytes, rate: int = 24000, channels: int = 1, sample_width: int = 2) -> bytes:
    """把 TTS 的裸 PCM 转成 WAV，方便 speak() 直接播放。"""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(sample_width)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def build_demo_wav(seconds: float = 2.0, rate: int = 22050) -> bytes:
    """生成一段带音节起伏的测试音（仅用于联调，不用于正式语音）。"""
    frames = bytearray()
    total = int(seconds * rate)
    for i in range(total):
        t = i / rate
        gate = max(0.0, math.sin(t * 6.5 * math.pi * 2)) ** 0.8
        v = math.sin(2 * math.pi * 150 * t) + 0.4 * math.sin(2 * math.pi * 310 * t)
        v = max(-1.0, min(1.0, v * gate))
        frames += struct.pack("<h", int(v * 22000))
    return pcm_to_wav(bytes(frames), rate=rate)


async def _main() -> None:
    parser = argparse.ArgumentParser(description="AI World 语音桥")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8777)
    parser.add_argument("--demo", action="store_true", help="页面连上后自动发一段测试音")
    args = parser.parse_args()

    voice = WorldVoice(args.host, args.port)
    voice._demo_on_connect = args.demo
    voice.on_speech_end = lambda interrupted: print(
        "页面回传 speech-end:", "被打断" if interrupted else "正常播完"
    )
    await voice.start()
    print(f"语音桥已启动：ws://{args.host}:{args.port}" + ("（demo）" if args.demo else ""))
    try:
        await asyncio.Future()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        await voice.close()


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        pass
