"""
F5-TTS 常驻工作进程。

从环境变量读配置（由 voice-service.cjs 传进来）：
  VOICE_TTS_CKPT      权重文件路径
  VOICE_TTS_REF       参考音频路径
  VOICE_TTS_REF_TEXT  参考音频对应的文字
  VOICE_TTS_SPEED     语速（默认 0.85）
  VOICE_TTS_DEVICE    设备（默认 cuda，不可用时自动退回 cpu）

协议：stdin 每行一个 JSON {id, text, out, speed}
     stdout 每行一个 JSON {"ready":true} 或 {id, ok, out} / {id, ok:false, error}
"""
import sys
import os
import json

# Windows 下 stdin/stdout 默认是 GBK，必须改成 UTF-8，否则中文会崩
if sys.platform == "win32":
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

CKPT = os.environ.get("VOICE_TTS_CKPT", "")
REF = os.environ.get("VOICE_TTS_REF", "")
REF_TEXT = os.environ.get("VOICE_TTS_REF_TEXT", "")
DEFAULT_SPEED = float(os.environ.get("VOICE_TTS_SPEED", "0.85"))
DEVICE = os.environ.get("VOICE_TTS_DEVICE", "cuda")


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    if not CKPT or not os.path.exists(CKPT):
        emit({"ready": False, "error": "ckpt 不存在: " + str(CKPT)})
        return
    if REF and not os.path.exists(REF):
        emit({"ready": False, "error": "参考音频不存在: " + str(REF)})
        return

    import soundfile as sf
    from f5_tts.api import F5TTS

    try:
        tts = F5TTS(model="F5TTS_v1_Base", ckpt_file=CKPT, device=DEVICE)
    except Exception:
        # 显卡不可用时退回 CPU（慢很多，但至少能用）
        tts = F5TTS(model="F5TTS_v1_Base", ckpt_file=CKPT, device="cpu")

    emit({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except Exception:
            continue

        text = (job.get("text") or "").strip()
        speed = float(job.get("speed") or DEFAULT_SPEED)
        out = job.get("out") or ""
        if not text or not out:
            emit({"id": job.get("id"), "ok": False, "error": "text/out 为空"})
            continue

        try:
            wav, sr, _ = tts.infer(
                ref_file=REF,
                ref_text=REF_TEXT,
                gen_text=text,
                nfe_step=32,
                speed=speed,
                # remove_silence 只处理首尾；数字前后的中间停顿得靠后面的压缩
                remove_silence=False,
                show_info=lambda *a, **k: None,
            )
            # 压掉中间的长停顿：念到数字时 F5 会停顿比较久，听着像卡住。
            # 用 numpy 自己扫，避免依赖 ffmpeg 再走一遍解码。
            import numpy as _np
            a = _np.asarray(wav, dtype=_np.float32)
            if a.ndim > 1:
                a = a.mean(axis=1)
            # 按 20ms 一帧算能量
            win = max(1, int(sr * 0.02))
            n = len(a) // win
            if n > 3:
                frames = a[: n * win].reshape(n, win)
                rms = _np.sqrt((frames ** 2).mean(axis=1) + 1e-12)
                thr = max(0.006, float(rms.max()) * 0.06)
                silent = rms < thr
                # 连续静音超过 180ms 就裁到 180ms
                max_sil = int(0.18 / 0.02)
                keep = _np.ones(n, dtype=bool)
                i = 0
                while i < n:
                    if silent[i]:
                        j = i
                        while j < n and silent[j]:
                            j += 1
                        run = j - i
                        if run > max_sil:
                            # 保留前 max_sil 帧，其余丢掉
                            keep[i + max_sil : j] = False
                        i = j
                    else:
                        i += 1
                if not keep.all():
                    idx = _np.repeat(keep, win)
                    tail_len = len(a) - n * win
                    if tail_len > 0:
                        idx = _np.concatenate([idx, _np.ones(tail_len, dtype=bool)])
                    a = a[idx]
                    wav = a
            sf.write(out, wav, sr)
            emit({"id": job.get("id"), "ok": True, "out": out})
        except Exception as e:
            emit({"id": job.get("id"), "ok": False, "error": str(e)[:300]})


if __name__ == "__main__":
    main()
