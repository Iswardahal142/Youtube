"use client";
import { useState, useEffect, useRef } from "react";

const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000").replace(/\/$/, "");

interface Clip {
  index: number;
  start: number;
  reason: string;
  url: string;
}

interface JobStatus {
  status: string;
  progress: number;
  clips: Clip[];
  error?: string;
  thumbnail?: string;
}

interface SavedSession {
  id: string;
  url: string;
  clips: Clip[];
  thumbnail?: string;
  createdAt: number;
}

const statusConfig: Record<string, { label: string; icon: string; color: string }> = {
  queued:       { label: "Queue mein hai",          icon: "⏳", color: "#f59e0b" },
  downloading:  { label: "Video download ho rahi",  icon: "⬇️", color: "#3b82f6" },
  transcribing: { label: "Transcript ban raha hai", icon: "🎙️", color: "#8b5cf6" },
  analyzing:    { label: "AI moments dhundh raha",  icon: "🤖", color: "#ec4899" },
  cutting:      { label: "Clips cut ho rahi hain",  icon: "✂️", color: "#f97316" },
  uploading:    { label: "Cloudinary pe upload",    icon: "☁️", color: "#06b6d4" },
  done:         { label: "Clips ready hain!",       icon: "✅", color: "#22c55e" },
  error:        { label: "Error aaya",              icon: "❌", color: "#ef4444" },
};

const STATUS_ORDER = ["queued", "downloading", "transcribing", "analyzing", "cutting", "uploading"];

// SSE timeout — agar 60s mein koi message nahi aaya toh error
const SSE_TIMEOUT_MS = 60000;

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function getShortUrl(url: string) {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname.slice(0, 20);
  } catch {
    return url.slice(0, 30);
  }
}

function getExpiryInfo(createdAt: number) {
  const expiresAt = createdAt + 24 * 60 * 60 * 1000;
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return { expired: true, label: "Expired" };
  const hrs = Math.floor(remaining / (1000 * 60 * 60));
  const mins = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
  if (hrs > 0) return { expired: false, label: `${hrs}h ${mins}m baki` };
  return { expired: false, label: `${mins}m baki` };
}

// Cloudinary ke liye fetch+blob download
async function downloadClip(clipUrl: string, fileName: string) {
  try {
    // Cloudinary fl_attachment flag se forced download hoga
    const dlUrl = clipUrl.includes("/upload/")
      ? clipUrl.replace("/upload/", "/upload/fl_attachment/")
      : clipUrl;

    const res = await fetch(dlUrl, { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
  } catch {
    // fallback — direct open in new tab
    window.open(clipUrl, "_blank");
  }
}

// Confirm Dialog Component
function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="confirm-overlay">
      <div className="confirm-box">
        <div className="confirm-icon">🗑</div>
        <div className="confirm-msg">{message}</div>
        <div className="confirm-btns">
          <button className="confirm-cancel" onClick={onCancel}>Cancel</button>
          <button className="confirm-ok" onClick={onConfirm}>Haan, Delete karo</button>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [dots, setDots] = useState("");
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null); // session id
  const [downloadingIdx, setDownloadingIdx] = useState<number | null>(null);
  const [uploadingIdx, setUploadingIdx] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const sseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem("yt_sessions");
    if (raw) setSavedSessions(JSON.parse(raw));
  }, []);

  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => setDots(d => d.length >= 3 ? "" : d + "."), 500);
    return () => clearInterval(t);
  }, [loading]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [liveLogs]);

  const saveSessions = (sessions: SavedSession[]) => {
    setSavedSessions(sessions);
    localStorage.setItem("yt_sessions", JSON.stringify(sessions));
  };

  const resetSseTimeout = (jobId: string, es: EventSource) => {
    if (sseTimeoutRef.current) clearTimeout(sseTimeoutRef.current);
    sseTimeoutRef.current = setTimeout(() => {
      es.close();
      setLoading(false);
      setStatus({ status: "error", progress: 0, clips: [], error: "Connection timeout — backend se koi response nahi aaya 60 seconds tak. Railway pe service check karo." });
    }, SSE_TIMEOUT_MS);
  };

  const startSSE = (jobId: string, videoUrl: string) => {
    if (esRef.current) esRef.current.close();

    const es = new EventSource(`${BACKEND_URL}/logs/${jobId}`);
    esRef.current = es;

    // Start timeout
    resetSseTimeout(jobId, es);

    es.onmessage = (event) => {
      // Koi bhi message aaya — timeout reset karo
      resetSseTimeout(jobId, es);

      try {
        const data = JSON.parse(event.data);

        if (data.type === "log") {
          setLiveLogs(prev => [...prev, data.message]);
        }

        if (data.type === "status") {
          setStatus(prev => prev ? {
            ...prev,
            status: data.status,
            progress: data.progress,
          } : { status: data.status, progress: data.progress, clips: [] });
        }

        if (data.type === "done") {
          if (sseTimeoutRef.current) clearTimeout(sseTimeoutRef.current);
          es.close();
          setLoading(false);

          if (data.status === "done") {
            const finalStatus: JobStatus = {
              status: "done",
              progress: 100,
              clips: data.clips,
              thumbnail: data.thumbnail,
            };
            setStatus(finalStatus);

            const newSession: SavedSession = {
              id: jobId,
              url: videoUrl,
              clips: data.clips,
              thumbnail: data.thumbnail,
              createdAt: Date.now(),
            };
            setSavedSessions(prev => {
              const updated = [newSession, ...prev.filter(s => s.id !== jobId)].slice(0, 10);
              localStorage.setItem("yt_sessions", JSON.stringify(updated));
              return updated;
            });
          } else {
            setStatus({ status: "error", progress: 0, clips: [], error: data.error || "Kuch toh gadbad hai" });
          }
        }

        if (data.type === "error") {
          if (sseTimeoutRef.current) clearTimeout(sseTimeoutRef.current);
          es.close();
          setLoading(false);
          setStatus({ status: "error", progress: 0, clips: [], error: data.message });
        }
      } catch {
        // parse error ignore
      }
    };

    es.onerror = () => {
      if (sseTimeoutRef.current) clearTimeout(sseTimeoutRef.current);
      es.close();
      setLoading(false);
      setStatus(prev => {
        // Agar already done/error hai toh mat badlo
        if (prev?.status === "done" || prev?.status === "error") return prev;
        return {
          status: "error",
          progress: prev?.progress ?? 0,
          clips: prev?.clips ?? [],
          error: "SSE connection toot gayi — backend se disconnect ho gaya. Page reload karke try karo.",
        };
      });
    };
  };

  const handleSubmit = async () => {
    if (!url.trim()) return;
    setLoading(true);
    setStatus(null);
    setLiveLogs([]);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(`${BACKEND_URL}/clip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`Server error: ${res.status} ${res.statusText}`);

      const data = await res.json();
      setCurrentSessionId(data.job_id);
      setStatus({ status: "queued", progress: 0, clips: [] });

      startSSE(data.job_id, url);

    } catch (err: unknown) {
      let msg = "Backend se connect nahi ho pa raha";
      if (err instanceof Error) {
        if (err.name === "AbortError") {
          msg = "Request timeout — Railway backend slow hai ya asleep. 30 sec baad try karo.";
        } else if (err.message.includes("Failed to fetch")) {
          msg = `Backend unreachable: ${BACKEND_URL} — Railway pe service running hai? Check karo.`;
        } else {
          msg = err.message;
        }
      }
      setStatus({ status: "error", progress: 0, clips: [], error: msg });
      setLoading(false);
    }
  };

  const deleteSession = (id: string) => {
    const updated = savedSessions.filter(s => s.id !== id);
    saveSessions(updated);
    setConfirmDelete(null);
  };

  const handleDownload = async (clipUrl: string, fileName: string, idx: number) => {
    setDownloadingIdx(idx);
    await downloadClip(clipUrl, fileName);
    setDownloadingIdx(null);
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleUpload = (idx: number) => {
    // YouTube upload — coming soon
    showToast("🚀 YouTube upload coming soon!");
  };

  const cfg = status ? statusConfig[status.status] : null;
  const oldSessions = savedSessions.filter(s => s.id !== currentSessionId);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=DM+Sans:wght@300;400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: 'DM Sans', sans-serif;
          background: #0a0a0a;
          color: #f0f0f0;
          min-height: 100vh;
        }

        .layout {
          display: flex;
          gap: 24px;
          max-width: 1200px;
          margin: 0 auto;
          padding: 48px 24px 80px;
          align-items: flex-start;
        }

        .main-col { flex: 1; min-width: 0; }
        .side-col { width: 320px; flex-shrink: 0; }

        @media (max-width: 768px) {
          .layout { flex-direction: column; padding: 24px 16px 60px; }
          .side-col { width: 100%; }
        }

        .header { margin-bottom: 32px; }
        .logo {
          display: flex; align-items: center;
          gap: 14px; margin-bottom: 10px;
        }
        .logo-icon {
          width: 48px; height: 48px;
          background: #ff2d2d; border-radius: 14px;
          display: flex; align-items: center; justify-content: center;
          font-size: 22px;
        }
        .logo h1 {
          font-family: 'Syne', sans-serif;
          font-size: 28px; font-weight: 800;
          letter-spacing: -0.5px; color: #fff;
        }
        .tagline {
          font-weight: 300; padding-left: 62px;
          color: #555; font-size: 14px;
        }

        .card {
          background: #111; border: 1px solid #222;
          border-radius: 20px; padding: 24px;
          margin-bottom: 16px;
        }
        .label {
          font-size: 12px; font-weight: 500;
          color: #555; text-transform: uppercase;
          letter-spacing: 1px; margin-bottom: 10px;
        }
        .input-row { display: flex; gap: 10px; }
        input[type="text"] {
          flex: 1; background: #1a1a1a;
          border: 1px solid #2a2a2a; border-radius: 12px;
          padding: 14px 18px; font-size: 14px;
          font-family: 'DM Sans', sans-serif;
          color: #f0f0f0; outline: none;
          transition: border-color 0.2s;
        }
        input[type="text"]:focus { border-color: #ff2d2d; }
        input[type="text"]::placeholder { color: #3a3a3a; }
        input[type="text"]:disabled { opacity: 0.5; }

        .btn {
          background: #ff2d2d; color: #fff;
          border: none; border-radius: 12px;
          padding: 14px 22px; font-size: 14px;
          font-weight: 600; font-family: 'DM Sans', sans-serif;
          cursor: pointer; transition: background 0.2s, transform 0.1s;
          white-space: nowrap;
        }
        .btn:hover:not(:disabled) { background: #e62222; }
        .btn:active:not(:disabled) { transform: scale(0.98); }
        .btn:disabled { background: #2a2a2a; color: #555; cursor: not-allowed; }

        .progress-section {
          margin-top: 20px;
          padding-top: 20px;
          border-top: 1px solid #1e1e1e;
        }
        .status-header {
          display: flex; align-items: center;
          justify-content: space-between; margin-bottom: 14px;
        }
        .status-label {
          display: flex; align-items: center;
          gap: 10px; font-size: 15px; font-weight: 500;
        }
        .status-pct {
          font-family: 'Syne', sans-serif;
          font-size: 22px; font-weight: 700; color: #ff2d2d;
        }
        .progress-track {
          height: 4px; background: #1e1e1e;
          border-radius: 99px; overflow: hidden; margin-bottom: 20px;
        }
        .progress-fill {
          height: 100%; border-radius: 99px;
          transition: width 0.6s ease;
        }
        .steps { display: flex; flex-direction: column; gap: 8px; }
        .step {
          display: flex; align-items: center;
          gap: 12px; padding: 10px 14px;
          border-radius: 10px; font-size: 13px;
          transition: background 0.2s;
        }
        .step.active { background: #1a1a1a; }
        .step-dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: #2a2a2a; flex-shrink: 0;
          transition: background 0.3s;
        }
        .step.done .step-dot { background: #22c55e; }
        .step.active .step-dot {
          background: #ff2d2d;
          box-shadow: 0 0 8px #ff2d2d88;
          animation: pulse 1s infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; } 50% { opacity: 0.4; }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(8px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        .step-text { color: #555; }
        .step.done .step-text { color: #888; }
        .step.active .step-text { color: #f0f0f0; }

        /* Live Logs Terminal */
        .logs-box {
          margin-top: 16px;
          background: #0d0d0d;
          border: 1px solid #1e1e1e;
          border-radius: 12px;
          padding: 14px 16px;
          max-height: 180px;
          overflow-y: auto;
          font-family: 'Courier New', monospace;
          font-size: 12px;
        }
        .logs-box::-webkit-scrollbar { width: 4px; }
        .logs-box::-webkit-scrollbar-track { background: transparent; }
        .logs-box::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 99px; }
        .log-line {
          color: #555;
          padding: 2px 0;
          line-height: 1.6;
          border-bottom: 1px solid #111;
        }
        .log-line:last-child { border-bottom: none; color: #aaa; }
        .log-line.error { color: #ef4444; }
        .logs-title {
          font-size: 11px; color: #333;
          text-transform: uppercase; letter-spacing: 1px;
          margin-bottom: 8px; font-family: 'DM Sans', sans-serif;
        }

        /* Clips */
        .clips-header {
          font-family: 'Syne', sans-serif;
          font-size: 18px; font-weight: 700;
          color: #22c55e; margin-bottom: 16px;
          display: flex; align-items: center; gap: 8px;
        }
        .clip-count {
          background: #22c55e22; color: #22c55e;
          font-size: 12px; font-weight: 600;
          padding: 3px 10px; border-radius: 99px;
        }
        .clip-list { display: flex; flex-direction: column; gap: 16px; }

        /* New clip card with video preview */
        .clip-card {
          background: #161616; border: 1px solid #222;
          border-radius: 16px; overflow: hidden;
          transition: border-color 0.2s;
        }
        .clip-card:hover { border-color: #333; }
        .clip-video {
          width: 100%; display: block;
          max-height: 280px;
          background: #000;
          border-bottom: 1px solid #1e1e1e;
        }
        .clip-meta {
          padding: 14px 16px;
        }
        .clip-meta-top {
          display: flex; align-items: center;
          gap: 10px; margin-bottom: 12px;
        }
        .clip-num {
          width: 32px; height: 32px;
          background: #ff2d2d22; color: #ff2d2d;
          border-radius: 8px; flex-shrink: 0;
          display: flex; align-items: center; justify-content: center;
          font-family: 'Syne', sans-serif;
          font-weight: 700; font-size: 13px;
        }
        .clip-info { flex: 1; min-width: 0; }
        .clip-reason {
          font-size: 13px; color: #ccc;
          margin-bottom: 3px;
        }
        .clip-time { font-size: 11px; color: #444; }
        .clip-actions {
          display: flex; gap: 8px;
        }
        .upload-btn {
          background: #1a1a2e; color: #818cf8;
          border: 1px solid #818cf833; border-radius: 10px;
          padding: 9px 14px; font-size: 12px;
          font-weight: 600; font-family: 'DM Sans', sans-serif;
          cursor: pointer; transition: background 0.2s;
          white-space: nowrap;
        }
        .upload-btn:hover { background: #22224a; }
        .dl-btn {
          flex: 1;
          background: #ff2d2d; color: #fff;
          border: none; border-radius: 10px;
          padding: 9px 14px; font-size: 12px;
          font-weight: 600; font-family: 'DM Sans', sans-serif;
          cursor: pointer; transition: background 0.2s;
          white-space: nowrap; text-align: center;
        }
        .dl-btn:hover:not(:disabled) { background: #e62222; }
        .dl-btn:disabled { background: #2a2a2a; color: #555; cursor: not-allowed; }

        /* Sidebar */
        .side-title {
          font-family: 'Syne', sans-serif;
          font-size: 16px; font-weight: 700;
          color: #fff; margin-bottom: 14px;
          display: flex; align-items: center; gap: 8px;
        }
        .side-empty {
          color: #333; font-size: 13px;
          text-align: center; padding: 32px 0;
        }
        .history-item {
          background: #111; border: 1px solid #1e1e1e;
          border-radius: 14px; padding: 14px 16px;
          margin-bottom: 10px;
        }
        .history-top {
          display: flex; align-items: center;
          justify-content: space-between; margin-bottom: 6px;
        }
        .history-url {
          font-size: 12px; color: #555;
          white-space: nowrap; overflow: hidden;
          text-overflow: ellipsis; flex: 1;
        }
        .del-btn {
          background: #1a0a0a; color: #ef4444;
          border: 1px solid #3a1515; border-radius: 8px;
          padding: 4px 10px; font-size: 11px;
          cursor: pointer; flex-shrink: 0; margin-left: 8px;
          transition: background 0.2s;
        }
        .del-btn:hover { background: #2a1010; }

        /* Expiry badge */
        .expiry-badge {
          font-size: 10px; padding: 2px 8px;
          border-radius: 99px; margin-bottom: 8px;
          display: inline-block;
        }
        .expiry-badge.ok { background: #0a2a0a; color: #22c55e; border: 1px solid #22c55e33; }
        .expiry-badge.expired { background: #1a0a0a; color: #ef4444; border: 1px solid #ef444433; }

        .history-thumb {
          width: 100%; border-radius: 8px;
          margin-bottom: 10px; object-fit: cover;
          max-height: 120px; border: 1px solid #1e1e1e;
        }
        .history-clips { display: flex; flex-direction: column; gap: 6px; }
        .history-clip {
          display: flex; align-items: center;
          gap: 8px; font-size: 12px; color: #666;
        }
        .history-clip-num {
          color: #ff2d2d; font-weight: 700;
          font-size: 11px; flex-shrink: 0;
        }
        .history-clip-text {
          flex: 1; white-space: nowrap;
          overflow: hidden; text-overflow: ellipsis;
        }
        .history-dl {
          background: transparent; color: #ff2d2d;
          border: 1px solid #ff2d2d33; border-radius: 6px;
          padding: 3px 8px; font-size: 10px;
          cursor: pointer; flex-shrink: 0;
          transition: background 0.2s;
        }
        .history-dl:hover { background: #ff2d2d22; }

        .error-box {
          background: #1a0a0a; border: 1px solid #3a1515;
          border-radius: 14px; padding: 20px;
          margin-top: 16px;
        }
        .error-title { color: #ef4444; font-weight: 600; margin-bottom: 6px; font-size: 14px; }
        .error-msg { color: #666; font-size: 13px; line-height: 1.5; }
        .debug-url {
          font-size: 11px; color: #333;
          margin-top: 8px; font-family: monospace;
        }

        .thumbnail-img {
          width: 100%; border-radius: 12px;
          margin-bottom: 16px;
          object-fit: cover; max-height: 200px;
          border: 1px solid #222;
        }
        .hint {
          text-align: center; color: #2a2a2a;
          font-size: 12px; margin-top: 32px;
        }

        /* Confirm dialog */
        .confirm-overlay {
          position: fixed; inset: 0;
          background: rgba(0,0,0,0.75);
          display: flex; align-items: center; justify-content: center;
          z-index: 999;
          backdrop-filter: blur(4px);
        }
        .confirm-box {
          background: #161616; border: 1px solid #2a2a2a;
          border-radius: 20px; padding: 32px 28px;
          max-width: 360px; width: 90%;
          text-align: center;
        }
        .confirm-icon { font-size: 32px; margin-bottom: 12px; }
        .confirm-msg {
          font-size: 14px; color: #aaa;
          line-height: 1.6; margin-bottom: 24px;
        }
        .confirm-btns { display: flex; gap: 10px; }
        .confirm-cancel {
          flex: 1; background: #1e1e1e; color: #888;
          border: 1px solid #2a2a2a; border-radius: 12px;
          padding: 12px; font-size: 13px; font-weight: 500;
          font-family: 'DM Sans', sans-serif;
          cursor: pointer; transition: background 0.2s;
        }
        .confirm-cancel:hover { background: #252525; }
        .confirm-ok {
          flex: 1; background: #ef4444; color: #fff;
          border: none; border-radius: 12px;
          padding: 12px; font-size: 13px; font-weight: 600;
          font-family: 'DM Sans', sans-serif;
          cursor: pointer; transition: background 0.2s;
        }
        .confirm-ok:hover { background: #dc2626; }

        /* Expire warning banner */
        .expire-banner {
          background: #1a1200; border: 1px solid #f59e0b33;
          border-radius: 10px; padding: 10px 14px;
          font-size: 12px; color: #f59e0b;
          margin-bottom: 14px; display: flex;
          align-items: center; gap: 8px;
        }
      `}</style>

      {confirmDelete && (
        <ConfirmDialog
          message="Is session ki saari clips delete ho jayengi. Pakka karna hai?"
          onConfirm={() => deleteSession(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {toast && (
        <div style={{
          position: "fixed", bottom: 32, left: "50%", transform: "translateX(-50%)",
          background: "#1e1e2e", border: "1px solid #818cf844", color: "#818cf8",
          borderRadius: 12, padding: "12px 24px", fontSize: 13, fontWeight: 600,
          zIndex: 9999, boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          animation: "fadeIn 0.2s ease"
        }}>
          {toast}
        </div>
      )}

      <div className="layout">
        {/* Main Column */}
        <div className="main-col">
          <div className="header">
            <div className="logo">
              <div className="logo-icon">🎬</div>
              <h1>YT Clipper</h1>
            </div>
            <p className="tagline">Long video → Top 10 Shorts/Reels (60 sec each)</p>
          </div>

          <div className="card">
            <div className="label">YouTube URL</div>
            <div className="input-row">
              <input
                type="text"
                placeholder="https://youtube.com/watch?v=..."
                value={url}
                onChange={e => setUrl(e.target.value)}
                disabled={loading}
                onKeyDown={e => e.key === "Enter" && handleSubmit()}
              />
              <button className="btn" onClick={handleSubmit} disabled={loading || !url.trim()}>
                {loading ? `Processing${dots}` : "🚀 Clip karo"}
              </button>
            </div>

            {status && cfg && status.status !== "done" && status.status !== "error" && (
              <div className="progress-section">
                <div className="status-header">
                  <div className="status-label">
                    <span>{cfg.icon}</span>
                    <span style={{ color: cfg.color }}>{cfg.label}{loading ? dots : ""}</span>
                  </div>
                  <div className="status-pct">{status.progress}%</div>
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${status.progress}%`, background: cfg.color }} />
                </div>
                <div className="steps">
                  {Object.entries(statusConfig).filter(([k]) => k !== "done" && k !== "error").map(([key, s]) => {
                    const curIdx = STATUS_ORDER.indexOf(status.status);
                    const thisIdx = STATUS_ORDER.indexOf(key);
                    const state = thisIdx < curIdx ? "done" : thisIdx === curIdx ? "active" : "";
                    return (
                      <div key={key} className={`step ${state}`}>
                        <div className="step-dot" />
                        <span className="step-text">{s.icon} {s.label}</span>
                      </div>
                    );
                  })}
                </div>

                {liveLogs.length > 0 && (
                  <div className="logs-box">
                    <div className="logs-title">🖥 Live Logs</div>
                    {liveLogs.map((log, i) => (
                      <div key={i} className={`log-line ${log.includes("❌") ? "error" : ""}`}>
                        {log}
                      </div>
                    ))}
                    <div ref={logsEndRef} />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Clips Ready */}
          {status && status.status === "done" && (
            <div className="card">
              <div className="expire-banner">
                ⏰ Clips 24 ghante baad Cloudinary se delete ho jayengi — abhi download kar lo!
              </div>
              <div className="clips-header">
                ✅ Clips Ready
                <span className="clip-count">{status.clips.length} clips</span>
              </div>
              {status.thumbnail && (
                <img src={status.thumbnail} alt="Video thumbnail" className="thumbnail-img" />
              )}
              <div className="clip-list">
                {status.clips.map(clip => (
                  <div key={clip.index} className="clip-card">
                    <video
                      className="clip-video"
                      src={clip.url}
                      controls
                      controlsList="nodownload"
                      preload="metadata"
                      playsInline
                    />
                    <div className="clip-meta">
                      <div className="clip-meta-top">
                        <div className="clip-num">#{clip.index}</div>
                        <div className="clip-info">
                          <div className="clip-reason">{clip.reason}</div>
                          <div className="clip-time">⏱ {formatTime(clip.start)} se shuru</div>
                        </div>
                      </div>
                      <div className="clip-actions">
                        <button
                          className="upload-btn"
                          onClick={() => handleUpload(clip.index)}
                        >
                          ▲ Upload
                        </button>
                        <button
                          className="dl-btn"
                          disabled={downloadingIdx === clip.index}
                          onClick={() => handleDownload(clip.url, `clip_${clip.index}.mp4`, clip.index)}
                        >
                          {downloadingIdx === clip.index ? "⏳ Downloading..." : "⬇️ Download"}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {status && status.status === "error" && (
            <div className="error-box">
              <div className="error-title">❌ Error aaya bhai</div>
              <div className="error-msg">{status.error || "Kuch toh gadbad hai"}</div>
              <div className="debug-url">Backend: {BACKEND_URL}</div>
            </div>
          )}

          <div className="hint">Processing time: ~5-10 min per video</div>
        </div>

        {/* Sidebar */}
        <div className="side-col">
          <div className="side-title">🕘 Purani Clips</div>
          {oldSessions.length === 0 ? (
            <div className="side-empty">Abhi koi purani clips nahi hain</div>
          ) : (
            oldSessions.map(session => {
              const expiry = getExpiryInfo(session.createdAt);
              return (
                <div key={session.id} className="history-item">
                  <div className="history-top">
                    <div className="history-url">🔗 {getShortUrl(session.url)}</div>
                    <button className="del-btn" onClick={() => setConfirmDelete(session.id)}>🗑 Delete</button>
                  </div>
                  <span className={`expiry-badge ${expiry.expired ? "expired" : "ok"}`}>
                    {expiry.expired ? "⚠️ Expired" : `⏱ ${expiry.label}`}
                  </span>
                  {session.thumbnail && (
                    <img src={session.thumbnail} alt="thumbnail" className="history-thumb" />
                  )}
                  <div className="history-clips">
                    {session.clips.map(clip => (
                      <div key={clip.index} className="history-clip">
                        <span className="history-clip-num">#{clip.index}</span>
                        <span className="history-clip-text">{clip.reason}</span>
                        <button
                          className="history-dl"
                          disabled={expiry.expired}
                          onClick={() => !expiry.expired && downloadClip(clip.url, `clip_${clip.index}.mp4`)}
                          style={expiry.expired ? { opacity: 0.3, cursor: "not-allowed" } : {}}
                        >
                          Download
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
