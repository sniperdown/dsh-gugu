#!/usr/bin/env python3
"""把一段音频文件转成文字（QQ 语音用）。

## 为什么是这个形状

插件侧是 node，转写能力在 **faster-whisper**（`shared/tools/whisper/.venv`，已装
faster-whisper 1.2.1 + ctranslate2 + av，GPU 是 4070 SUPER）。所以这里是一个
**一次性进程**：node 用 `spawn(python, [script, ...])` 调它，参数走数组**不经过 shell**
（AGENTS.md 那条"内容一旦穿 shell 就可能被静默改写"）。

## 输出约定（两个刻意的选择）

1. **结果写文件，不写 stdout** —— Windows 控制台是 GBK，中文/emoji 直接打 stdout 会炸
   （AGENTS.md 第 3 条）。stdout 只给一行 ASCII 状态，node 那边只判退出码。
2. **`text` 是"一整句"** —— QQ 语音都很短，不需要时间轴；把 segments 拼起来去掉空白。

## 退出码

- `0` 成功（JSON 里 `ok: true`）
- `2` 参数不对
- `3` 模型/转写失败（stderr 里带异常，node 会把它放进 warn 日志）

## 用法

    python transcribe-voice.py --audio a.wav --out a.json \
        --model <models/large-v3> --device cuda --language zh
"""
from __future__ import annotations

import argparse
import json
import os
import sys


def register_nvidia_dlls() -> list:
    """把 pip 装的 CUDA 运行库目录加进 DLL 搜索路径（Windows）。

    ## 为什么必须自己注册（2026-10-25 实测）

    `nvidia-cublas-cu12` / `nvidia-cudnn-cu12` 这两个 wheel 把 DLL 放在
    `site-packages/nvidia/<pkg>/bin`，**不在 PATH 里、也不是系统 CUDA**。
    ctranslate2 在 **import 时**就去加载 `cublas64_12.dll`，找不到就
    `Library cublas64_12.dll is not found or cannot be loaded`
    —— 所以必须在 `from faster_whisper import ...` **之前**调用本函数。

    （这段与 `shared/tools/whisper/bili2text.py` 的 `register_nvidia_dlls()` 同源。
      刻意不 import 它：那是另一个项目的脚本，插件不该依赖工作区里别人的目录结构。）
    """
    added = []
    if os.name != 'nt':
        return added
    try:
        import importlib.util

        for pkg in ('nvidia.cublas', 'nvidia.cudnn', 'nvidia.cuda_runtime'):
            spec = importlib.util.find_spec(pkg)
            if not spec or not spec.submodule_search_locations:
                continue
            for loc in spec.submodule_search_locations:
                for sub in ('bin', 'lib'):
                    folder = os.path.join(str(loc), sub)
                    if not os.path.isdir(folder):
                        continue
                    try:
                        os.add_dll_directory(folder)
                        added.append(folder)
                        os.environ['PATH'] = folder + os.pathsep + os.environ.get('PATH', '')
                    except OSError:
                        pass
    except Exception:
        pass
    return added


def parse_args(argv):
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument('--audio', required=True, help='音频文件路径（wav，NapCat get_record 解出来的）')
    parser.add_argument('--out', required=True, help='JSON 结果写到哪里')
    parser.add_argument('--model', default='', help='本地模型目录（空 = 用 HuggingFace 上的 large-v3 名字）')
    parser.add_argument('--device', default='cuda', help='cuda / cpu')
    parser.add_argument('--language', default='zh', help='语言代码；空串 = 自动识别')
    parser.add_argument('--vad', default='1', help='1 = 开 VAD 过滤（去静音），0 = 关')
    return parser.parse_args(argv)


def main(argv) -> int:
    try:
        args = parse_args(argv)
    except SystemExit:
        return 2

    audio = str(args.audio or '')
    out = str(args.out or '')
    if audio == '' or out == '':
        print('bad-args', file=sys.stderr)
        return 2
    if not os.path.isfile(audio):
        print(f'audio-not-found: {audio}', file=sys.stderr)
        return 3

    try:
        # ⚠️ 必须在 import faster_whisper **之前**（ctranslate2 在 import 时就要 cublas）。
        register_nvidia_dlls()
        from faster_whisper import WhisperModel  # 延迟导入：参数错误时不该花 3 秒加载库
    except Exception as error:  # pragma: no cover - 环境问题
        print(f'import-failed: {error}', file=sys.stderr)
        return 3

    device = str(args.device or 'cuda').strip().lower()
    if device not in ('cuda', 'cpu'):
        device = 'cpu'
    try:
        # GPU 用 float16（4070 SUPER 够）；CPU 只能 int8，否则慢到没意义。
        compute_type = 'float16' if device == 'cuda' else 'int8'
        model_ref = str(args.model or '').strip() or 'large-v3'
        model = WhisperModel(model_ref, device=device, compute_type=compute_type)
    except Exception as error:
        # ⚠️ cuda 起不来时退到 CPU 一次：用户的机器是带 GPU 的，但驱动/显存问题
        # 不该让"这条语音没有转写"变成常态（宁可慢，也要有字）。
        if device == 'cuda':
            try:
                model = WhisperModel(model_ref, device='cpu', compute_type='int8')
                device = 'cpu'
            except Exception as retry_error:  # pragma: no cover - 环境问题
                print(f'model-load-failed: {error} / cpu-retry: {retry_error}', file=sys.stderr)
                return 3
        else:  # pragma: no cover - 环境问题
            print(f'model-load-failed: {error}', file=sys.stderr)
            return 3

    language = str(args.language or '').strip()
    use_vad = str(args.vad or '1').strip() != '0'
    try:
        segments, info = model.transcribe(
            audio,
            language=(language or None),
            vad_filter=use_vad,
            beam_size=1,
            # 语音消息都很短，不要让它去"猜上下文"；温度 0 = 稳定输出。
            temperature=0.0,
        )
        text = ''.join(segment.text for segment in segments).strip()
    except Exception as error:  # pragma: no cover - 转写失败
        print(f'transcribe-failed: {error}', file=sys.stderr)
        return 3

    payload = {
        'ok': True,
        'text': text,
        'language': str(getattr(info, 'language', '') or ''),
        'duration': float(getattr(info, 'duration', 0.0) or 0.0),
        'device': device,
    }
    try:
        with open(out, 'w', encoding='utf-8') as handle:
            json.dump(payload, handle, ensure_ascii=False)
    except Exception as error:  # pragma: no cover - 写不出来
        print(f'write-failed: {error}', file=sys.stderr)
        return 3

    # stdout 只用 ASCII：node 那边只需要一个"跑完了"的信号。
    print('ok')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
