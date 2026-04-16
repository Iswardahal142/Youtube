import subprocess
import os
import json
import re
import base64
import requests
from storage import update_job, upload_clip

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")
CLIP_DURATION = 60  # seconds
TOP_N_CLIPS = 10
COOKIES_PATH = "/tmp/yt_cookies.txt"


def _setup_cookies():
    """Inject cookies from env variable into file"""
    cookies_b64 = os.environ.get("YT_COOKIES_B64")
    if cookies_b64:
        try:
            with open(COOKIES_PATH, "wb") as f:
                f.write(base64.b64decode(cookies_b64))
            print("Cookies loaded ✅")
        except Exception as e:
            print(f"Cookies setup failed: {e}")


def download_video(url: str, video_path: str) -> bool:
    """Download video using pytubefix — no JS challenge issues"""
    try:
        from pytubefix import YouTube
        yt = YouTube(url)

        stream = (
            yt.streams
            .filter(progressive=True, file_extension="mp4")
            .order_by("resolution")
            .last()
        )

        if not stream:
            stream = yt.streams.filter(file_extension="mp4").order_by("resolution").last()

        if not stream:
            stream = yt.streams.first()

        if not stream:
            return False

        import tempfile
        tmp_dir = tempfile.mkdtemp()
        downloaded = stream.download(output_path=tmp_dir)
        os.rename(downloaded, video_path)
        return True

    except Exception as e:
        print(f"pytubefix error: {e}")
        return False


def get_transcript(url: str) -> list:
    """Get transcript using yt-dlp subtitles (skip-download mode)"""
    try:
        subtitle_path = f"/tmp/subs_{os.path.basename(url)[-10:]}"
        cmd = [
            "yt-dlp",
            "--write-auto-sub",
            "--write-sub",
            "--sub-lang", "en",
            "--sub-format", "json3",
            "--skip-download",
            "--extractor-args", "youtube:player_client=ios",
            "-o", subtitle_path,
            url
        ]
        if os.path.exists(COOKIES_PATH) and os.path.getsize(COOKIES_PATH) > 0:
            cmd += ["--cookies", COOKIES_PATH]

        subprocess.run(cmd, capture_output=True, text=True, timeout=120)

        sub_file = None
        for f in os.listdir("/tmp"):
            if f.startswith(os.path.basename(subtitle_path)) and f.endswith(".json3"):
                sub_file = f"/tmp/{f}"
                break

        if sub_file and os.path.exists(sub_file):
            with open(sub_file) as f:
                data = json.load(f)

            segments = []
            for event in data.get("events", []):
                start_ms = event.get("tStartMs", 0)
                segs = event.get("segs", [])
                text = " ".join(s.get("utf8", "") for s in segs).strip()
                if text and text != "\n":
                    segments.append({
                        "start": start_ms / 1000,
                        "text": text
                    })
            os.remove(sub_file)
            return segments

    except Exception as e:
        print(f"Subtitle error: {e}")

    return []


def find_best_moments(segments: list, video_duration: int = 3600) -> list:
    """Use OpenRouter AI to find top 10 most interesting moments"""
    if not segments:
        step = video_duration // TOP_N_CLIPS
        return [{"start": i * step, "reason": f"Clip {i+1}"} for i in range(TOP_N_CLIPS)]

    transcript_text = ""
    for seg in segments:
        start = int(seg.get("start", 0))
        text = seg.get("text", "").strip()
        transcript_text += f"[{start}s] {text}\n"

    prompt = f"""Ye ek YouTube video ka transcript hai timestamps ke saath.
Mujhe TOP 10 most interesting/viral moments chahiye jo 60 second clips ban sakein.

Rules:
- Har moment ek complete thought/story ho
- Exciting, informative, ya emotional moments prefer karo
- Response SIRF JSON mein do, kuch aur mat likho

Format:
[
  {{"start": 120, "reason": "Very interesting moment about X"}},
  ...
]

Transcript:
{transcript_text[:8000]}
"""

    try:
        response = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "anthropic/claude-3-haiku",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 1000,
            },
            timeout=60
        )
        content = response.json()["choices"][0]["message"]["content"]
        content = re.sub(r"```json|```", "", content).strip()
        moments = json.loads(content)
        return moments[:TOP_N_CLIPS]
    except Exception as e:
        print(f"AI error: {e}")
        return [{"start": i * 300, "reason": f"Segment {i+1}"} for i in range(TOP_N_CLIPS)]


def get_video_duration(video_path: str) -> int:
    """Get video duration in seconds"""
    try:
        result = subprocess.run([
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            video_path
        ], capture_output=True, text=True)
        return int(float(result.stdout.strip()))
    except:
        return 3600


def cut_clip(video_path: str, start: int, job_id: str, index: int) -> str:
    """Cut a 60-second clip using FFmpeg"""
    output_path = f"/tmp/{job_id}_clip_{index}.mp4"
    subprocess.run([
        "ffmpeg", "-y",
        "-ss", str(max(0, start - 2)),
        "-i", video_path,
        "-t", str(CLIP_DURATION),
        "-c:v", "libx264",
        "-c:a", "aac",
        "-preset", "fast",
        "-crf", "28",
        output_path
    ], capture_output=True, timeout=120)
    return output_path


def process_video(url: str, job_id: str):
    """Main pipeline: download → subtitles → AI → cut → upload"""
    try:
        # Setup cookies at start
        _setup_cookies()

        update_job(job_id, {"status": "downloading", "progress": 10})

        video_path = f"/tmp/{job_id}.mp4"

        # Try pytubefix first
        success = download_video(url, video_path)

        # Fallback to yt-dlp with cookies
        if not success or not os.path.exists(video_path):
            print("pytubefix failed, trying yt-dlp fallback...")
            cmd = [
                "yt-dlp",
                "-f", "best[height<=720]/best",
                "--merge-output-format", "mp4",
                "--no-check-certificates",
                "--extractor-args", "youtube:player_client=ios",
                "--no-playlist",
                "-o", video_path,
                url,
            ]
            if os.path.exists(COOKIES_PATH) and os.path.getsize(COOKIES_PATH) > 0:
                cmd += ["--cookies", COOKIES_PATH]

            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            print(f"yt-dlp stdout: {result.stdout[-500:]}")
            print(f"yt-dlp stderr: {result.stderr[-500:]}")

        if not os.path.exists(video_path):
            update_job(job_id, {"status": "error", "error": "Video download failed. Try a different URL."})
            return

        # Thumbnail URL fetch karo
        thumbnail_url = ""
        try:
            from pytubefix import YouTube
            yt = YouTube(url)
            thumbnail_url = yt.thumbnail_url or ""
        except Exception as e:
            print(f"Thumbnail fetch error: {e}")

        duration = get_video_duration(video_path)

        update_job(job_id, {"status": "transcribing", "progress": 30})
        segments = get_transcript(url)

        update_job(job_id, {"status": "analyzing", "progress": 50})
        moments = find_best_moments(segments, duration)

        if not moments:
            moments = [{"start": i * 360, "reason": f"Clip {i+1}"} for i in range(TOP_N_CLIPS)]

        update_job(job_id, {"status": "cutting", "progress": 60})

        clips = []
        for i, moment in enumerate(moments):
            start = moment.get("start", i * 300)
            reason = moment.get("reason", f"Clip {i+1}")

            clip_path = cut_clip(video_path, start, job_id, i)

            if os.path.exists(clip_path):
                update_job(job_id, {"status": "uploading", "progress": 60 + (i * 3)})
                clip_url = upload_clip(clip_path, job_id, i)

                clips.append({
                    "index": i + 1,
                    "start": start,
                    "reason": reason,
                    "url": clip_url
                })

                os.remove(clip_path)

        if os.path.exists(video_path):
            os.remove(video_path)

        update_job(job_id, {
            "status": "done",
            "progress": 100,
            "clips": clips,
            "thumbnail": thumbnail_url
        })

    except Exception as e:
        update_job(job_id, {"status": "error", "error": str(e)})
