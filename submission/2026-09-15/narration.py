"""Generate the authored narration using an existing OpenAI credential in memory.

Run under WSL, supplying OPENAI_API_KEY or the PID of the existing local IDO
demo via --credential-process. No credentials are written or logged.
"""
import argparse
import json
import os
from pathlib import Path
import urllib.request
import wave

p = argparse.ArgumentParser()
p.add_argument("--content", required=True)
p.add_argument("--output", required=True)
p.add_argument("--credential-process", type=int)
p.add_argument("--credential-env-file")
a = p.parse_args()
key = os.environ.get("OPENAI_API_KEY")
if not key and a.credential_env_file:
    lines = Path(a.credential_env_file).read_text().splitlines()
    value = next((v.split("=", 1)[1].strip() for v in lines if v.startswith("OPENAI_API_KEY=")), "")
    key = value.strip("\"'")
if not key and a.credential_process:
    env = Path(f"/proc/{a.credential_process}/environ").read_bytes().split(b"\0")
    key = next((v.split(b"=", 1)[1].decode() for v in env if v.startswith(b"OPENAI_API_KEY=")), None)
if not key:
    raise SystemExit("An existing OpenAI API credential is required.")
out = Path(a.output)
out.mkdir(parents=True, exist_ok=True)
content = json.loads(Path(a.content).read_text(encoding="utf-8"))
timings = []
for s in content["segments"]:
    path = out / (s["id"] + ".wav")
    if not path.exists():
        body = json.dumps({
            "model": "gpt-4o-mini-tts", "voice": "coral", "input": s["voice"],
            "instructions": "日本語のハッカソンのデモ動画のナレーション。聞き手に近い自然な声で、明瞭に、少しテンポよく話す。大げさな宣伝口調や芝居を避ける。Codexはコーデックス、IDOはイドーと読む。",
            "response_format": "wav", "speed": 1.1,
        }).encode()
        request = urllib.request.Request("https://api.openai.com/v1/audio/speech", body,
            {"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=90) as response:
            path.write_bytes(response.read())
    with wave.open(str(path)) as w:
        params = (w.getnchannels(), w.getsampwidth(), w.getframerate())
        frames = w.readframes(w.getnframes())
        secs = len(frames) / params[0] / params[1] / params[2]
    # The API can stream WAV with an open-ended RIFF data size. Finalize it.
    with wave.open(str(path), "wb") as w:
        w.setnchannels(params[0])
        w.setsampwidth(params[1])
        w.setframerate(params[2])
        w.writeframes(frames)
    timings.append({"id": s["id"], "seconds": round(secs, 3), "file": path.name})
    print(json.dumps(timings[-1]), flush=True)
(out / "timings.json").write_text(json.dumps(timings, indent=2), encoding="utf-8")
print(json.dumps({"totalSpeechSeconds": sum(t["seconds"] for t in timings)}))
