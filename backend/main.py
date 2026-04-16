from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uuid
import os
import asyncio
import json
from clipper import process_video
from storage import get_job_status, init_job, get_job_logs

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class VideoRequest(BaseModel):
    url: str

@app.get("/")
def root():
    return {"status": "YT Clipper API running 🔥"}

@app.post("/clip")
async def clip_video(req: VideoRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    init_job(job_id)
    background_tasks.add_task(process_video, req.url, job_id)
    return {"job_id": job_id, "status": "processing"}

@app.get("/status/{job_id}")
def job_status(job_id: str):
    status = get_job_status(job_id)
    if not status:
        raise HTTPException(status_code=404, detail="Job not found")
    return status

@app.get("/logs/{job_id}")
async def stream_logs(job_id: str):
    """SSE endpoint — frontend pe live logs stream karo"""
    async def event_generator():
        last_index = 0
        max_wait = 600  # 10 min timeout
        waited = 0

        while waited < max_wait:
            status = get_job_status(job_id)
            if not status:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Job not found'})}\n\n"
                break

            # Naye logs bhejo jo abhi tak nahi bheje
            logs = get_job_logs(job_id)
            for log in logs[last_index:]:
                yield f"data: {json.dumps({'type': 'log', 'message': log})}\n\n"
            last_index = len(logs)

            # Progress + status update bhejo
            yield f"data: {json.dumps({'type': 'status', 'status': status.get('status'), 'progress': status.get('progress', 0)})}\n\n"

            # Done ya error pe stream band karo
            if status.get("status") in ("done", "error"):
                final = {
                    "type": "done",
                    "status": status.get("status"),
                    "clips": status.get("clips", []),
                    "thumbnail": status.get("thumbnail", ""),
                    "error": status.get("error", ""),
                }
                yield f"data: {json.dumps(final)}\n\n"
                break

            await asyncio.sleep(1)
            waited += 1

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # Nginx buffering band karo
        }
    )
