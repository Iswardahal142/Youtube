# 🎬 YT Clipper - YouTube Long Video to Short Clips

YouTube ki long video ko automatically **Top 10 Short Clips (60 sec)** mein convert karo!

## How it Works
1. YouTube URL dalo
2. AI (OpenRouter) best moments dhundta hai
3. FFmpeg 60-sec clips cut karta hai
4. Supabase Storage mein upload hoti hain
5. Download links milte hain

---

## Setup Guide

### Step 1: GitHub Repos Banao

```bash
# Poora project clone/push karo
git init
git add .
git commit -m "initial commit"
gh repo create yt-clipper --public --push
```

### Step 2: Backend - Railway pe Deploy

1. **railway.app** jao → New Project → Deploy from GitHub
2. `backend/` folder select karo
3. Environment Variables add karo:

```
OPENROUTER_API_KEY=sk-or-xxxxxxxxxx
SUPABASE_URL=https://xxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJxxxxxxxxxx
```

4. Deploy hone ke baad Railway ka URL copy karo
   Example: `https://yt-clipper-production.railway.app`

### Step 3: Frontend - Vercel pe Deploy

1. **vercel.com** jao → Import from GitHub
2. `frontend/` folder select karo
3. Environment Variable add karo:

```
NEXT_PUBLIC_BACKEND_URL=https://your-railway-url.railway.app
```

4. Deploy!

---

## Supabase Storage Policy Setup

Supabase Dashboard → Storage → yt-clips bucket → Policies:

```sql
-- Public read allow karo
CREATE POLICY "Public Access"
ON storage.objects FOR SELECT
USING (bucket_id = 'yt-clips');
```

---

## Tech Stack
- **Frontend**: Next.js 14 + Tailwind CSS (Vercel)
- **Backend**: Python FastAPI (Railway)
- **AI**: OpenRouter (claude-3-haiku)
- **Video**: yt-dlp + FFmpeg + Whisper
- **Storage**: Supabase Storage

---

## Notes
- Pehli baar Whisper model download hoga (~150MB) - Railway build mein hoga
- Ek video process hone mein ~5-10 min lagta hai
- Supabase free tier: 1GB storage
