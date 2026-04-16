import os
import json
from supabase import create_client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
BUCKET_NAME = "yt-clips"

# In-memory job store (use Redis in production)
jobs = {}

def get_client():
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

def init_job(job_id: str):
    jobs[job_id] = {"status": "queued", "progress": 0, "clips": []}

def update_job(job_id: str, data: dict):
    if job_id in jobs:
        jobs[job_id].update(data)
    print(f"Job {job_id}: {data}")

def get_job_status(job_id: str):
    return jobs.get(job_id)

def upload_clip(clip_path: str, job_id: str, index: int) -> str:
    """Upload clip to Supabase Storage and return public URL"""
    try:
        supabase = get_client()
        file_name = f"{job_id}/clip_{index+1}.mp4"

        with open(clip_path, "rb") as f:
            supabase.storage.from_(BUCKET_NAME).upload(
                file_name,
                f,
                {"content-type": "video/mp4"}
            )

        # Get public URL
        url = supabase.storage.from_(BUCKET_NAME).get_public_url(file_name)
        return url
    except Exception as e:
        print(f"Upload error: {e}")
        return ""
