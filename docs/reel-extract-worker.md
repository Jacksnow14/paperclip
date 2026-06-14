# Reel Extraction Worker

Deployed at `/home/ievgen/outreach/reel_extract.py` on predictor host `78.153.195.107`.

Extracts caption, uploader, transcript, and keyframes from any public Instagram reel or post URL.
Falls back to a cookies file for gated content. Related issue: [AUR-2214](/AUR/issues/AUR-2214).

## Quick start

```bash
# JSON mode (preferred for programmatic callers)
python3 /home/ievgen/outreach/reel_extract.py '{"url": "https://www.instagram.com/reel/..."}'

# CLI mode
python3 /home/ievgen/outreach/reel_extract.py --url https://www.instagram.com/reel/...

# From a file
python3 /home/ievgen/outreach/reel_extract.py --file input.json

# From stdin
echo '{"url": "..."}' | python3 /home/ievgen/outreach/reel_extract.py
```

## Input schema (JSON mode)

```json
{
  "url":             "https://www.instagram.com/reel/...",
  "cookies":         "/path/to/cookies.txt",
  "out_dir":         "/tmp/reel_xyz",
  "whisper_model":   "base",
  "scene_threshold": 0.3,
  "max_frames":      8,
  "no_transcript":   false
}
```

All fields except `url` are optional.

## Output manifest (stdout JSON)

```json
{
  "ok":       true,
  "url":      "https://...",
  "out_dir":  "/tmp/reel_abc",
  "video":    "/tmp/reel_abc/reel.mp4",
  "audio":    "/tmp/reel_abc/audio.wav",
  "frames":   ["/tmp/reel_abc/frame_001.jpg"],
  "caption":  "Post description text",
  "uploader": "natgeo",
  "duration": 33,
  "transcript": {
    "language": "en",
    "text": "Full transcription of speech..."
  }
}
```

On failure `ok` is `false` and an `error` field is present. Exit code: 0 on success, 1 on failure.

## Dependencies (pre-installed on predictor host)

| Package | Version |
|---------|---------|
| yt-dlp | 2026.3.17 |
| faster-whisper | 1.2.1 |
| ffmpeg | 4.4.2 |

To reinstall: `pip install yt-dlp faster-whisper`

## Whisper model selection

Default is `base` — good balance of speed (~2× realtime on CPU) and accuracy for short social clips.
For higher accuracy at 2–3× slower speed: pass `"whisper_model": "small"`.

## Cookies fallback (IG auth gate mitigation)

If Instagram begins requiring login for a URL, supply a Netscape-format cookies file:

```bash
# Export from browser (e.g. with "Get cookies.txt LOCALLY" extension)
# Place at:
/home/ievgen/outreach/ig_cookies.txt

# The worker auto-loads this path if it exists and no explicit cookies key is provided
```

The worker also accepts an explicit path via `"cookies": "/path/to/file"`.

Refresh the cookies file periodically (session tokens expire). The worker retries downloads up to 3 times before reporting failure.

## Calling from Python / shell

```bash
# Shell (parse stdout as JSON)
result=$(python3 /home/ievgen/outreach/reel_extract.py '{"url": "..."}')
echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['transcript']['text'])"
```

```python
import subprocess, json

def extract_reel(url, cookies=None):
    inp = {"url": url}
    if cookies:
        inp["cookies"] = cookies
    proc = subprocess.run(
        ["python3", "/home/ievgen/outreach/reel_extract.py", json.dumps(inp)],
        capture_output=True, text=True, timeout=300
    )
    return json.loads(proc.stdout)

manifest = extract_reel("https://www.instagram.com/reel/DUWTKLFDMe8/")
print(manifest["transcript"]["text"])
```

## Smoke test log

Tested 2026-06-14 (AUR-2214):

| URL | Result |
|-----|--------|
| `https://www.instagram.com/p/DTDmvljAD7L/` | OK — natgeo reel, 33s, transcript extracted |
| `https://www.instagram.com/reel/DUWTKLFDMe8/` | OK — metadata extracted |
