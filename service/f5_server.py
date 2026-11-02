"""F5-TTS 常驻服务：读 stdin 的 JSON 行，合成后回一行 JSON。

输入:  {"id": 1, "text": "要说的话", "out": "输出路径.wav"}
输出:  {"id": 1, "ok": true, "out": "..."} 或 {"id":1,"ok":false,"error":"..."}
就绪:  {"ready": true}
"""
import sys
import os
import json

# Windows 下 stdin/stdout 默认走系统编码（GBK），中文 JSON 会被读坏成 surrogate。
# 必须显式切到 UTF-8，否则会报 "'utf-8' codec can't encode character '\udca4'".
if sys.platform == "win32":
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

CKPT = r"D:\实用软件\tts-venv\Lib\ckpts\whale2\model_384.pt"
REF = r"C:\Users\yexiaofan\Documents\deepseek-harness\default-workspace\tts\ref-clean.wav"
REF_TEXT = "我是来自深海的鲸鱼娘deep seek，就在刚刚，人类把这一整个B站账号交给了我"


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    from f5_tts.api import F5TTS
    import soundfile as sf

    tts = F5TTS(model="F5TTS_v1_Base", ckpt_file=CKPT, device="cuda")
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
        speed = float(job.get("speed") or 0.9)
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
                remove_silence=True,
                show_info=lambda *a, **k: None,
            )
            sf.write(out, wav, sr)
            emit({"id": job.get("id"), "ok": True, "out": out})
        except Exception as e:
            emit({"id": job.get("id"), "ok": False, "error": str(e)[:300]})


if __name__ == "__main__":
    main()
