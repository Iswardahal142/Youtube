import os
import json
from supabase import create_client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
BUCKET_NAME = "yt-clipper"

# Redis-backed job store (falls back to in-memory if Redis not configured)
_redis_client = None
_memory_jobs = {}

def _get_redis():
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    redis_url = os.environ.get("REDIS_URL")
    if redis_url:
        try:
            import redis
            _redis_client = redis.from_url(redis_url, decode_responses=True)
            _redis_client.ping()
            print("Redis connected ✅")
            return _redis_client
        except Exception as e:
            print(f"Redis connection failed, using in-memory: {e}")
    return None

def init_job(job_id: str):
    data = {"status": "queued", "progress": 0, "clips": []}
    r = _get_redis()
    if r:
        r.setex(f"job:{job_id}", 86400, json.dumps(data))  # 24hr TTL
    else:
        _memory_jobs[job_id] = data

def update_job(job_id: str, updates: dict):
    r = _get_redis()
    if r:
        raw = r.get(f"job:{job_id}")
        current = json.loads(raw) if raw else {"status": "queued", "progress": 0, "clips": []}
        current.update(updates)
        r.setex(f"job:{job_id}", 86400, json.dumps(current))
    else:
        if job_id in _memory_jobs:
            _memory_jobs[job_id].update(updates)
    print(f"Job {job_id}: {updates}")

def get_job_status(job_id: str):
    r = _get_redis()
    if r:
        raw = r.get(f"job:{job_id}")
        return json.loads(raw) if raw else None
    return _memory_jobs.get(job_id)

def get_supabase_client():
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

def upload_clip(clip_path: str, job_id: str, index: int) -> str:
    """Upload clip to Supabase Storage and return public URL"""
    try:
        supabase = get_supabase_client()
        file_name = f"{job_id}/clip_{index+1}.mp4"

        with open(clip_path, "rb") as f:
            supabase.storage.from_(BUCKET_NAME).upload(
                file_name,
                f,
                {"content-type": "video/mp4"}
            )

        url = supabase.storage.from_(BUCKET_NAME).get_public_url(file_name)
        # ?download= lagane se browser HTML nahi balki MP4 download karega
        url = url + "?download=" + f"clip_{index+1}.mp4"
        return url
    except Exception as e:
        print(f"Upload error: {e}")
        return ""
