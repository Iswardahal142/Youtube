import subprocess
import os
import json
import re
import requests
from storage import update_job, upload_clip, add_log

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")
RAPIDAPI_KEY = os.environ.get("RAPIDAPI_KEY")
CLIP_DURATION = 60  # seconds
TOP_N_CLIPS = 10


def download_video(url: str, video_path: str, job_id: str) -> bool:
    """Download video using RapidAPI with live progress updates"""
    try:
        video_id = re.search(r"(?:v=|youtu\.be/)([^&\n?#]+)", url)
        if not video_id:
            add_log(job_id, "❌ Video ID nahi mila URL se")
            return False
        video_id = video_id.group(1)
        add_log(job_id, f"🔍 Video ID mila: {video_id}")

        add_log(job_id, "📡 RapidAPI se video info le raha hai...")
        response = requests.get(
            "https://youtube-media-downloader.p.rapidapi.com/v2/video/details",
            headers={
                "x-rapidapi-host": "youtube-media-downloader.p.rapidapi.com",
                "x-rapidapi-key": RAPIDAPI_KEY
            },
            params={"videoId": video_id},
            timeout=30
        )
        data = response.json()

        videos = data.get("videos", {}).get("items", [])
        mp4_videos = [
            v for v in videos
            if v.get("extension") == "mp4" and v.get("height", 0) <= 720
        ]

        if not mp4_videos:
            add_log(job_id, "❌ Koi MP4 video nahi mila RapidAPI se")
            return False

        best = sorted(mp4_videos, key=lambda x: x.get("height", 0), reverse=True)[0]
        download_url = best.get("url")
        add_log(job_id, f"⬇️ {best.get('height')}p video download ho rahi hai...")

        # Stream download with live progress
        with requests.get(download_url, stream=True, timeout=600) as r:
            r.raise_for_status()
            total = int(r.headers.get('content-length', 0))
            downloaded = 0
            last_logged_pct = 0

            with open(video_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=65536):
                    f.write(chunk)
                    downloaded += len(chunk)

                    if total:
                        # Download = 10% se 28% tak
                        dl_pct = int((downloaded / total) * 100)
                        progress = 10 + int((downloaded / total) * 18)
                        update_job(job_id, {"progress": progress})

                        # Har 20% pe log bhejo
                        if dl_pct - last_logged_pct >= 20:
                            mb_done = downloaded / (1024 * 1024)
                            mb_total = total / (1024 * 1024)
                            add_log(job_id, f"⬇️ Download: {dl_pct}% ({mb_done:.1f}/{mb_total:.1f} MB)")
                            last_logged_pct = dl_pct

        if os.path.exists(video_path) and os.path.getsize(video_path) > 10000:
            size_mb = os.path.getsize(video_path) / (1024 * 1024)
            add_log(job_id, f"✅ Download complete! ({size_mb:.1f} MB)")
            return True
        else:
            add_log(job_id, "❌ File download hui par empty hai")
            return False

    except Exception as e:
        add_log(job_id, f"❌ Download error: {e}")
        return False


def get_transcript(url: str, job_id: str) -> list:
    """Get transcript using yt-dlp subtitles"""
    try:
        add_log(job_id, "🎙️ Subtitles/transcript extract ho rahi hai...")
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
            add_log(job_id, f"✅ Transcript mila — {len(segments)} segments")
            return segments
        else:
            add_log(job_id, "⚠️ Transcript nahi mila — AI equally space karega clips")

    except Exception as e:
        add_log(job_id, f"⚠️ Transcript error: {e}")

    return []


def find_best_moments(segments: list, video_duration: int, job_id: str) -> list:
    """Use OpenRouter AI to find top 10 most interesting moments"""
    if not segments:
        step = video_duration // TOP_N_CLIPS
        add_log(job_id, f"🤖 Transcript nahi tha — equally spaced {TOP_N_CLIPS} clips ban rahe hain")
        return [{"start": i * step, "reason": f"Clip {i+1}"} for i in range(TOP_N_CLIPS)]

    add_log(job_id, "🤖 AI best moments dhundh raha hai...")

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
        add_log(job_id, f"✅ AI ne {len(moments[:TOP_N_CLIPS])} moments identify kiye!")
        return moments[:TOP_N_CLIPS]
    except Exception as e:
        add_log(job_id, f"⚠️ AI error: {e} — fallback clips use ho rahe hain")
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
        add_log(job_id, "🚀 Processing shuru ho gaya!")
        update_job(job_id, {"status": "downloading", "progress": 10})

        video_path = f"/tmp/{job_id}.mp4"
        success = download_video(url, video_path, job_id)  # job_id pass kiya

        if not os.path.exists(video_path) or not success:
            add_log(job_id, "❌ Video download fail — koi aur URL try karo")
            update_job(job_id, {"status": "error", "error": "Video download failed. Try a different URL."})
            return

        # Thumbnail
        thumbnail_url = ""
        try:
            video_id = re.search(r"(?:v=|youtu\.be/)([^&\n?#]+)", url)
            if video_id:
                thumbnail_url = f"https://img.youtube.com/vi/{video_id.group(1)}/hqdefault.jpg"
        except Exception as e:
            pass

        duration = get_video_duration(video_path)
        add_log(job_id, f"📏 Video duration: {duration // 60}m {duration % 60}s")

        update_job(job_id, {"status": "transcribing", "progress": 30})
        segments = get_transcript(url, job_id)

        update_job(job_id, {"status": "analyzing", "progress": 50})
        moments = find_best_moments(segments, duration, job_id)

        if not moments:
            moments = [{"start": i * 360, "reason": f"Clip {i+1}"} for i in range(TOP_N_CLIPS)]

        update_job(job_id, {"status": "cutting", "progress": 60})
        add_log(job_id, f"✂️ {len(moments)} clips cut ho rahi hain...")

        clips = []
        for i, moment in enumerate(moments):
            start = moment.get("start", i * 300)
            reason = moment.get("reason", f"Clip {i+1}")

            add_log(job_id, f"✂️ Clip {i+1}/{len(moments)} cut ho rahi hai ({start//60}m {start%60}s se)...")
            clip_path = cut_clip(video_path, start, job_id, i)

            if os.path.exists(clip_path):
                # Progress: 60% se 95% tak distribute karo
                progress = 60 + int(((i + 1) / len(moments)) * 35)
                update_job(job_id, {"status": "uploading", "progress": progress})
                add_log(job_id, f"☁️ Clip {i+1} Supabase pe upload ho rahi hai...")

                clip_url = upload_clip(clip_path, job_id, i)

                if clip_url:
                    add_log(job_id, f"✅ Clip {i+1} upload complete!")
                else:
                    add_log(job_id, f"⚠️ Clip {i+1} upload fail hui")

                clips.append({
                    "index": i + 1,
                    "start": start,
                    "reason": reason,
                    "url": clip_url
                })
                os.remove(clip_path)

        if os.path.exists(video_path):
            os.remove(video_path)

        add_log(job_id, f"🎉 Sab done! {len(clips)} clips ready hain!")
        update_job(job_id, {
            "status": "done",
            "progress": 100,
            "clips": clips,
            "thumbnail": thumbnail_url
        })

    except Exception as e:
        add_log(job_id, f"❌ Fatal error: {e}")
        update_job(job_id, {"status": "error", "error": str(e)})
