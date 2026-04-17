import os
import json
import cloudinary
import cloudinary.uploader

CLOUDINARY_CLOUD_NAME = os.environ.get("CLOUDINARY_CLOUD_NAME")
CLOUDINARY_API_KEY = os.environ.get("CLOUDINARY_API_KEY")
CLOUDINARY_API_SECRET = os.environ.get("CLOUDINARY_API_SECRET")

# Cloudinary config
cloudinary.config(
    cloud_name=CLOUDINARY_CLOUD_NAME,
    api_key=CLOUDINARY_API_KEY,
    api_secret=CLOUDINARY_API_SECRET,
    secure=True
)

_redis_client = None
_memory_jobs = {}
_memory_logs = {}


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
        r.setex(f"job:{job_id}", 86400, json.dumps(data))
        r.delete(f"logs:{job_id}")
    else:
        _memory_jobs[job_id] = data
        _memory_logs[job_id] = []


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


def add_log(job_id: str, message: str):
    """Live log message add karo — SSE se frontend pe jayega"""
    print(f"[LOG] {job_id}: {message}")
    r = _get_redis()
    if r:
        r.rpush(f"logs:{job_id}", message)
        r.expire(f"logs:{job_id}", 86400)
    else:
        if job_id not in _memory_logs:
            _memory_logs[job_id] = []
        _memory_logs[job_id].append(message)


def get_job_logs(job_id: str) -> list:
    r = _get_redis()
    if r:
        return r.lrange(f"logs:{job_id}", 0, -1)
    return _memory_logs.get(job_id, [])


def get_job_status(job_id: str):
    r = _get_redis()
    if r:
        raw = r.get(f"job:{job_id}")
        return json.loads(raw) if raw else None
    return _memory_jobs.get(job_id)


def upload_clip(clip_path: str, job_id: str, index: int) -> str:
    """Upload clip to Cloudinary — 24hr baad auto-delete"""
    try:
        public_id = f"yt-clipper/{job_id}/clip_{index + 1}"

        result = cloudinary.uploader.upload(
            clip_path,
            public_id=public_id,
            resource_type="video",
            invalidate=True,
            tags=[f"job_{job_id}"],
        )

        url = result.get("secure_url", "")
        print(f"✅ Cloudinary upload done: {url}")
        return url

    except Exception as e:
        print(f"Upload error: {e}")
        return ""
