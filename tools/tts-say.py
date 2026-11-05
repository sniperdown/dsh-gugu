"""文字转语音（edge-tts）—— 插件调用的小工具，**不是给人手动跑的**。

## 契约（和 `src/dsh/tts.mjs` 对齐，改一边就要改另一边）

参数（全部走 argv 数组，**不经过 shell**）：
  --text-file <path>   要念的文本（UTF-8，一行或多行都行）
  --out <path.mp3>     输出的 mp3
  --result <path.json> 结果 JSON（**必写**：成功 `{"ok":true,...}`，失败 `{"ok":false,"error":"..."}`）
  --voice <name>       音色（默认 zh-CN-XiaoxiaoNeural）
  --rate <±N%>         语速
  --pitch <±NHz>       音高

## 为什么要写结果文件，而不是靠 stdout 判断

Windows 控制台是 GBK：把中文错误直接打到 stdout 会有两种翻车方式 ——
① 编码炸掉（异常里带中文时 `UnicodeEncodeError`）；② 调用方按 GBK 解 UTF-8 得到乱码，
**看起来像"成功了但文本不对"**。所以结果一律写 UTF-8 JSON 文件，stdout 只留 ASCII 摘要。
（同 `tools/transcribe-voice.py` 的理由。）

## 退出码

0 = 成功；1 = 合成失败（结果文件里有原因）；2 = 参数/文本有问题。
"""
import argparse
import asyncio
import json
import os
import sys
import time


def write_result(path: str, payload: dict) -> None:
    """结果一定写盘（哪怕只是失败信息）—— 调用方只认这个文件。"""
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001
        print("RESULT_WRITE_FAILED %s" % type(exc).__name__)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text-file", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--result", required=True)
    ap.add_argument("--voice", default="zh-CN-XiaoxiaoNeural")
    ap.add_argument("--rate", default="+0%")
    ap.add_argument("--pitch", default="+0Hz")
    args = ap.parse_args()

    try:
        with open(args.text_file, encoding="utf-8") as fh:
            text = fh.read().strip()
    except Exception as exc:  # noqa: BLE001
        write_result(args.result, {"ok": False, "error": "读不到文本文件: %s" % type(exc).__name__})
        print("TEXT_FILE_UNREADABLE")
        return 2

    if not text:
        write_result(args.result, {"ok": False, "error": "文本是空的"})
        print("EMPTY_TEXT")
        return 2

    try:
        import edge_tts
    except Exception as exc:  # noqa: BLE001
        write_result(args.result, {"ok": False, "error": "import edge_tts 失败: %s: %s" % (type(exc).__name__, str(exc)[:200])})
        print("EDGE_TTS_IMPORT_FAILED")
        return 1

    try:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        t0 = time.perf_counter()
        comm = edge_tts.Communicate(text, args.voice, rate=args.rate, pitch=args.pitch)
        asyncio.run(comm.save(args.out))
        ms = int((time.perf_counter() - t0) * 1000)
    except Exception as exc:  # noqa: BLE001
        write_result(args.result, {
            "ok": False,
            "error": "%s: %s" % (type(exc).__name__, str(exc)[:300]),
        })
        print("TTS_FAILED")
        return 1

    if not os.path.exists(args.out):
        write_result(args.result, {"ok": False, "error": "edge-tts 没产出文件"})
        print("NO_OUTPUT_FILE")
        return 1
    size = os.path.getsize(args.out)
    if size <= 0:
        write_result(args.result, {"ok": False, "error": "输出文件是空的（0 字节）"})
        print("EMPTY_OUTPUT_FILE")
        return 1

    write_result(args.result, {"ok": True, "ms": ms, "bytes": size, "chars": len(text), "voice": args.voice})
    print("OK ms=%d bytes=%d chars=%d" % (ms, size, len(text)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
