"""wav2small 推理（A/D/V）—— 插件调用的小工具，**不是给人手动跑的**。

## 契约（和 `src/dsh/emotion.mjs` 对齐，改一边就要改另一边）

参数（全部走 argv 数组，**不经过 shell**）：
  --wav <path>        输入音频（16-bit PCM wav；24k 也能吃，内部重采样到 16k）
  --out <path.json>   **结果 JSON（必写）**
  --model <path>      safetensors 权重（默认用脚本同目录的 `emotion-model.safetensors`）
  --min-seconds <f>   低于这个时长直接跳过（默认 1.0）
  --min-rms <f>       低于这个 RMS 直接跳过（默认 0.001，判据见下）

结果 JSON 形状：
  成功       {"ok": true, "skipped": "", "arousal": 0.42, "secs": 12.3, "rms": 0.05, "ms": 61}
  跳过       {"ok": true, "skipped": "too_short" | "too_quiet", "secs": ..., "rms": ...}
  失败       {"ok": false, "error": "..."}

## 三件必须记住的事

1. **只输出 arousal。** valence 实测跨数据集不一致（RAVDESS 上 happy/sad 完全分不开），
   dominance 与 arousal 的 r≈0.996（同一个信号）⇒ 这两个**一律不往外传**，
   免得以后有人顺手拿它当判断依据。
2. **必须 clip 到 [0,1]。** CCC 训练的目标在 [0,1]，但输出没有 clamp：
   RAVDESS 640 条里 arousal 有 14 条 >1（最大 1.1756）。
3. **电量门槛放在最前面、且在 import torch 之前。** 纯静音会输出胡话（实测 valence −0.78），
   而 import torch 要 ~2 秒 —— 先门限再加载，静音/过短就一秒都不花。

## 为什么不用 transformers / librosa

权重里**自带** DFT 矩阵与 mel 滤波器组（都是 buffer）⇒ 不需要它们。
依赖只有 torch(cpu) + safetensors + numpy + soxr。
"""
import argparse
import json
import os
import sys
import time
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL = os.path.join(HERE, "emotion-model.safetensors")


def write_result(path, payload):
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=True)
    except Exception as exc:  # noqa: BLE001
        print("RESULT_WRITE_FAILED %s" % type(exc).__name__)


def read_wav(path):
    with wave.open(path, "rb") as fh:
        channels, sr, width, frames = fh.getnchannels(), fh.getframerate(), fh.getsampwidth(), fh.getnframes()
        raw = fh.readframes(frames)
    if width != 2:
        raise ValueError("只支持 16-bit PCM wav（这个文件是 %d 字节/样本）" % width)
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)
    return x, sr


def build_model(model_path):
    """和官方 README 逐层同名；DFT/mel 都是 buffer，直接灌权重。"""
    import torch
    from torch import nn
    from safetensors.torch import load_file

    def prenorm(x, attention_mask=None):
        if attention_mask is not None:
            n = attention_mask.sum(1, keepdim=True)
            x = x - x.sum(1, keepdim=True) / n
            var = (x * x).sum(1, keepdim=True) / n
        else:
            x = x - x.mean(1, keepdim=True)
            var = (x * x).mean(1, keepdim=True)
        return x / torch.sqrt(var + 1e-7)

    class Conv(nn.Module):
        def __init__(self, c_in, c_out, k=3, stride=1, padding=1):
            super().__init__()
            self.conv = nn.Conv2d(c_in, c_out, k, stride=stride, padding=padding, bias=False)
            self.norm = nn.BatchNorm2d(c_out)

        def forward(self, x):
            return torch.relu_(self.norm(self.conv(x)))

    class Vgg7(nn.Module):
        def __init__(self, n_mels=26):
            super().__init__()
            self.l1 = Conv(1, 13)
            self.l2 = Conv(13, 13)
            self.l3 = Conv(13, 13)
            self.maxpool_A = nn.MaxPool2d(3, stride=2, padding=1)
            self.l4 = Conv(13, 13)
            self.l5 = Conv(13, 13)
            self.l6 = Conv(13, 13)
            self.l7 = Conv(13, 13)
            self.lin = nn.Conv2d(13, 13, 1, padding=0, stride=1)
            self.sof = nn.Conv2d(13, 13, 1, padding=0, stride=1)
            self.spectrogram_extractor = nn.Module()
            self.spectrogram_extractor.conv_real = nn.Conv1d(1, 33, 64, stride=32, padding=0, bias=False)
            self.spectrogram_extractor.conv_imag = nn.Conv1d(1, 33, 64, stride=32, padding=0, bias=False)
            self.logmel_extractor = nn.Module()
            self.logmel_extractor.register_buffer("melW", torch.zeros(33, n_mels))
            self.logmel_extractor.register_buffer("amin", torch.zeros(1))

        def forward(self, x):
            x = prenorm(x)
            x = x[:, None, :]
            real = self.spectrogram_extractor.conv_real(x)
            imag = self.spectrogram_extractor.conv_imag(x)
            x = real ** 2 + imag ** 2
            x = torch.matmul(x[:, None, :, :].transpose(2, 3), self.logmel_extractor.melW)
            x = torch.where(x > self.logmel_extractor.amin, x, self.logmel_extractor.amin)
            x = 10 * torch.log10(x)
            x = self.l1(x); x = self.l2(x); x = self.l3(x)
            x = self.maxpool_A(x)
            x = self.l4(x); x = self.l5(x); x = self.l6(x); x = self.l7(x)
            x = self.lin(x) * self.sof(x).softmax(2)
            x = x.sum(2)
            x = torch.cat([x, torch.bmm(x, x.transpose(1, 2))], 2)
            return x.reshape(-1, 338)

    class Wav2Small(nn.Module):
        def __init__(self):
            super().__init__()
            self.vgg7 = Vgg7()
            self.adv = nn.Linear(338, 3)

        def forward(self, x):
            return self.adv(self.vgg7(x))

    model = Wav2Small()
    state = load_file(model_path)
    missing, unexpected = model.load_state_dict(state, strict=False)
    if unexpected or missing:
        raise ValueError("权重对不上：missing=%s unexpected=%s" % (missing[:3], unexpected[:3]))
    return model.eval()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--min-seconds", type=float, default=1.0)
    ap.add_argument("--min-rms", type=float, default=0.001)
    args = ap.parse_args()

    t0 = time.perf_counter()
    try:
        x, sr = read_wav(args.wav)
    except Exception as exc:  # noqa: BLE001
        write_result(args.out, {"ok": False, "error": "读音频失败：%s: %s" % (type(exc).__name__, str(exc)[:200])})
        print("WAV_READ_FAILED")
        return 1

    secs = len(x) / float(sr)
    rms = float(np.sqrt(np.mean(x * x))) if len(x) > 0 else 0.0

    # ---- 门限（**在 import torch 之前**：静音/过短一秒都不花）----
    if secs < args.min_seconds:
        write_result(args.out, {"ok": True, "skipped": "too_short", "secs": round(secs, 2), "rms": round(rms, 5)})
        print("SKIP too_short %.2fs" % secs)
        return 0
    if rms < args.min_rms:
        write_result(args.out, {"ok": True, "skipped": "too_quiet", "secs": round(secs, 2), "rms": round(rms, 5)})
        print("SKIP too_quiet rms=%.5f" % rms)
        return 0

    try:
        if not os.path.exists(args.model):
            raise FileNotFoundError(args.model)
        import soxr
        import torch

        if sr != 16000:
            x = soxr.resample(x, sr, 16000, quality="HQ")
        model = build_model(args.model)
        with torch.no_grad():
            adv = model(torch.from_numpy(x.astype(np.float32))[None, :])[0].tolist()
    except Exception as exc:  # noqa: BLE001
        write_result(args.out, {"ok": False, "error": "推理失败：%s: %s" % (type(exc).__name__, str(exc)[:200])})
        print("INFER_FAILED")
        return 1

    # ⚠️ 只传 arousal；dominance/valence **不出这个函数**（理由见文件头）。
    arousal = min(1.0, max(0.0, float(adv[0])))
    ms = int((time.perf_counter() - t0) * 1000)
    write_result(args.out, {
        "ok": True,
        "skipped": "",
        "arousal": round(arousal, 4),
        "secs": round(secs, 2),
        "rms": round(rms, 5),
        "ms": ms,
    })
    print("OK arousal=%.3f ms=%d" % (arousal, ms))
    return 0


if __name__ == "__main__":
    sys.exit(main())
