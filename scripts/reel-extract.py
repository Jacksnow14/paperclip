#!/usr/bin/env python3
"""AUR-2214: Instagram reel extraction worker — production-hardened.

Given a public Instagram reel/post URL, this script:
  1. Downloads the video + metadata via yt-dlp (works WITHOUT login for public
     reels as of 2026-06; falls back to a cookies file for gated content).
  2. Pulls the caption/description and author from the metadata.
  3. Extracts 16 kHz mono audio and transcribes it with faster-whisper.
  4. Extracts scene-change keyframes (representative screenshots).
  5. Emits a single JSON manifest on stdout.

Two invocation modes (mirrors outreach/form_runner.py):

  # JSON mode (preferred for programmatic callers):
  python3 reel-extract.py '{"url": "https://..."}'
  python3 reel-extract.py --file input.json
  echo '{"url": "..."}' | python3 reel-extract.py

  # CLI mode (convenient for humans):
  python3 reel-extract.py --url URL [--out-dir DIR] [--cookies FILE]
                          [--whisper-model base] [--scene-threshold 0.3]
                          [--max-frames 8] [--no-transcript]

JSON input schema:
  {
    "url":             "https://www.instagram.com/reel/...",
    "cookies":         "/path/to/cookies.txt",  // optional
    "out_dir":         "/tmp/reel_xyz",          // optional
    "whisper_model":   "base",                   // optional, default "base"
    "scene_threshold": 0.3,                      // optional
    "max_frames":      8,                        // optional
    "no_transcript":   false                     // optional
  }

JSON output manifest:
  {
    "ok":        true | false,
    "url":       "...",
    "out_dir":   "/tmp/reel_...",
    "video":     "/tmp/reel_.../reel.mp4",
    "audio":     "/tmp/reel_.../audio.wav",
    "frames":    ["/tmp/reel_.../frame_001.jpg", ...],
    "caption":   "...",
    "uploader":  "...",
    "duration":  33,
    "transcript": {"language": "en", "text": "..."},
    "error":     "..."   // only present on failure
  }

Proven end-to-end on 2026-06-14 against:
  - https://www.instagram.com/p/DTDmvljAD7L/   (natgeo, 33s)
  - https://www.instagram.com/reel/DUWTKLFDMe8/

Risk: IG may require auth in future — supply a Netscape cookies file via
--cookies / "cookies" key to mitigate. Store the cookies file on the host
at /home/ievgen/outreach/ig_cookies.txt and refresh periodically.

Requirements (pre-installed on predictor host 78.153.195.107):
  pip install yt-dlp faster-whisper
  ffmpeg on PATH
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

_DOWNLOAD_RETRIES = 3
_DOWNLOAD_RETRY_DELAY = 5  # seconds between attempts


def _run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def download(url, out_dir, cookies, retries=_DOWNLOAD_RETRIES):
    """Download the reel + info.json with retry. Returns (video_path, info_dict)."""
    tmpl = os.path.join(out_dir, "reel.%(ext)s")
    cmd = [
        "yt-dlp", "--no-warnings",
        "--retries", "3",          # yt-dlp internal fragment retries
        "--fragment-retries", "3",
        "-o", tmpl,
        "--write-info-json",
        url,
    ]
    if cookies:
        cmd += ["--cookies", cookies]

    last_err = ""
    for attempt in range(1, retries + 1):
        res = _run(cmd, timeout=240)
        if res.returncode == 0:
            break
        last_err = res.stderr.strip()[:500]
        if attempt < retries:
            time.sleep(_DOWNLOAD_RETRY_DELAY)
    else:
        raise RuntimeError(f"yt-dlp failed after {retries} attempts: {last_err}")

    info_path = next(
        (os.path.join(out_dir, f) for f in os.listdir(out_dir) if f.endswith(".info.json")),
        None,
    )
    info = json.load(open(info_path)) if info_path else {}
    video = next(
        (
            os.path.join(out_dir, f)
            for f in os.listdir(out_dir)
            if f.startswith("reel.") and not f.endswith(".info.json")
        ),
        None,
    )
    if not video:
        raise RuntimeError("yt-dlp produced no video file")
    return video, info


def extract_audio(video, out_dir):
    audio = os.path.join(out_dir, "audio.wav")
    res = _run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-i", video, "-vn", "-ar", "16000", "-ac", "1", audio],
        timeout=180,
    )
    if res.returncode != 0:
        raise RuntimeError(f"ffmpeg audio extract failed: {res.stderr.strip()[:300]}")
    return audio


def extract_frames(video, out_dir, threshold, max_frames):
    pattern = os.path.join(out_dir, "frame_%03d.jpg")
    _run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", video,
         "-vf", f"select='gt(scene,{threshold})'", "-vsync", "vfr", pattern],
        timeout=180,
    )
    frames = sorted(
        os.path.join(out_dir, f) for f in os.listdir(out_dir) if f.startswith("frame_")
    )
    if not frames:  # static clip: fall back to a single mid-point thumbnail
        thumb = os.path.join(out_dir, "frame_001.jpg")
        _run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", video,
             "-vf", "thumbnail", "-frames:v", "1", thumb],
            timeout=60,
        )
        frames = [thumb] if os.path.exists(thumb) else []
    return frames[:max_frames]


def transcribe(audio, model_name):
    from faster_whisper import WhisperModel
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio)
    text = " ".join(s.text.strip() for s in segments).strip()
    return {"language": info.language, "text": text}


def _parse_input():
    """Return (input_dict, use_json_mode) for both invocation styles."""
    ap = argparse.ArgumentParser(add_help=False)
    # JSON mode args
    ap.add_argument("json_input", nargs="?", help="JSON input string")
    ap.add_argument("--file", "-f", help="Path to JSON input file")
    # CLI mode args
    ap.add_argument("--url")
    ap.add_argument("--out-dir")
    ap.add_argument("--cookies", help="Netscape cookies file for non-public reels")
    ap.add_argument("--whisper-model", default="base")
    ap.add_argument("--scene-threshold", type=float, default=0.3)
    ap.add_argument("--max-frames", type=int, default=8)
    ap.add_argument("--no-transcript", action="store_true")
    ap.add_argument("-h", "--help", action="store_true")
    args, _ = ap.parse_known_args()

    if args.help:
        print(__doc__)
        sys.exit(0)

    # JSON mode: explicit file
    if args.file:
        with open(args.file) as fh:
            return json.load(fh), True

    # JSON mode: positional arg looks like JSON
    if args.json_input and args.json_input.strip().startswith("{"):
        return json.loads(args.json_input), True

    # JSON mode: stdin piped
    if not sys.stdin.isatty():
        raw = sys.stdin.read().strip()
        if raw:
            return json.loads(raw), True

    # CLI mode: --url or bare positional that is a URL
    url = args.url or args.json_input
    if not url:
        print("error: provide a URL or JSON input", file=sys.stderr)
        sys.exit(1)
    return {
        "url": url,
        "out_dir": args.out_dir,
        "cookies": args.cookies,
        "whisper_model": args.whisper_model,
        "scene_threshold": args.scene_threshold,
        "max_frames": args.max_frames,
        "no_transcript": args.no_transcript,
    }, False


def run_extract(cfg):
    """Core extraction logic. cfg is a dict with fields from JSON/CLI input."""
    url = cfg.get("url", "").strip()
    if not url:
        return {"ok": False, "error": "Missing required field: url"}

    out_dir = cfg.get("out_dir") or tempfile.mkdtemp(prefix="reel_")
    os.makedirs(out_dir, exist_ok=True)

    cookies = cfg.get("cookies") or None
    # Default cookies path on the host — used when cookies key absent but file exists
    _default_cookies = "/home/ievgen/outreach/ig_cookies.txt"
    if not cookies and os.path.exists(_default_cookies):
        cookies = _default_cookies

    whisper_model = cfg.get("whisper_model") or "base"
    scene_threshold = float(cfg.get("scene_threshold") or 0.3)
    max_frames = int(cfg.get("max_frames") or 8)
    no_transcript = bool(cfg.get("no_transcript") or False)

    manifest = {"url": url, "out_dir": out_dir, "ok": False}
    try:
        video, info = download(url, out_dir, cookies)
        manifest.update(
            video=video,
            caption=info.get("description") or "",
            uploader=info.get("uploader") or info.get("uploader_id"),
            duration=info.get("duration"),
            like_count=info.get("like_count"),
            timestamp=info.get("timestamp"),
        )
        manifest["audio"] = extract_audio(video, out_dir)
        manifest["frames"] = extract_frames(video, out_dir, scene_threshold, max_frames)
        if not no_transcript:
            manifest["transcript"] = transcribe(manifest["audio"], whisper_model)
        manifest["ok"] = True
    except Exception as e:
        manifest["error"] = str(e)

    return manifest


def main():
    cfg, _ = _parse_input()
    manifest = run_extract(cfg)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    sys.exit(0 if manifest.get("ok") else 1)


if __name__ == "__main__":
    main()
