"use client";
import { useState, useEffect } from "react";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

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
}

const statusConfig: Record<string, { label: string; icon: string; color: string }> = {
  queued:      { label: "Queue mein hai",           icon: "⏳", color: "#f59e0b" },
  downloading: { label: "Video download ho rahi",   icon: "⬇️", color: "#3b82f6" },
  transcribing:{ label: "Transcript ban raha hai",  icon: "🎙️", color: "#8b5cf6" },
  analyzing:   { label: "AI moments dhundh raha",   icon: "🤖", color: "#ec4899" },
  cutting:     { label: "Clips cut ho rahi hain",   icon: "✂️", color: "#f97316" },
  uploading:   { label: "Supabase pe upload",       icon: "☁️", color: "#06b6d4" },
  done:        { label: "Clips ready hain!",        icon: "✅", color: "#22c55e" },
  error:       { label: "Error aaya",               icon: "❌", color: "#ef4444" },
};

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [dots, setDots] = useState("");

  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => setDots(d => d.length >= 3 ? "" : d + "."), 500);
    return () => clearInterval(t);
  }, [loading]);

  const handleSubmit = async () => {
    if (!url.trim()) return;
    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch(`${BACKEND_URL}/clip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      pollStatus(data.job_id);
    } catch {
      setStatus({ status: "error", progress: 0, clips: [], error: "Backend se connect nahi ho pa raha" });
      setLoading(false);
    }
  };

  const pollStatus = (id: string) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/status/${id}`);
        const data: JobStatus = await res.json();
        setStatus(data);
        if (data.status === "done" || data.status === "error") {
          clearInterval(interval);
          setLoading(false);
        }
      } catch {
        clearInterval(interval);
        setLoading(false);
      }
    }, 3000);
  };

  const cfg = status ? statusConfig[status.status] : null;

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

        .wrap {
          max-width: 680px;
          margin: 0 auto;
          padding: 48px 24px 80px;
        }

        /* Header */
        .header {
          margin-bottom: 48px;
        }
        .logo {
          display: flex;
          align-items: center;
          gap: 14px;
          margin-bottom: 10px;
        }
        .logo-icon {
          width: 48px; height: 48px;
          background: #ff2d2d;
          border-radius: 14px;
          display: flex; align-items: center; justify-content: center;
          font-size: 22px;
        }
        .logo h1 {
          font-family: 'Syne', sans-serif;
          font-size: 28px;
          font-weight: 800;
          letter-spacing: -0.5px;
          color: #fff;
        }
        .tagline {
          color: #666;
          font-size: 14px;
          font-weight: 300;
          letter-spacing: 0.2px;
          padding-left: 62px;
        }

        /* Input card */
        .card {
          background: #111;
          border: 1px solid #222;
          border-radius: 20px;
          padding: 28px;
          margin-bottom: 20px;
        }
        .label {
          font-size: 12px;
          font-weight: 500;
          color: #555;
          text-transform: uppercase;
          letter-spacing: 1px;
          margin-bottom: 10px;
        }
        .input-row {
          display: flex;
          gap: 10px;
        }
        input[type="text"] {
          flex: 1;
          background: #1a1a1a;
          border: 1px solid #2a2a2a;
          border-radius: 12px;
          padding: 14px 18px;
          font-size: 14px;
          font-family: 'DM Sans', sans-serif;
          color: #f0f0f0;
          outline: none;
          transition: border-color 0.2s;
        }
        input[type="text"]:focus {
          border-color: #ff2d2d;
        }
        input[type="text"]::placeholder { color: #3a3a3a; }
        input[type="text"]:disabled { opacity: 0.5; }

        .btn {
          background: #ff2d2d;
          color: #fff;
          border: none;
          border-radius: 12px;
          padding: 14px 22px;
          font-size: 14px;
          font-weight: 600;
          font-family: 'DM Sans', sans-serif;
          cursor: pointer;
          transition: background 0.2s, transform 0.1s;
          white-space: nowrap;
        }
        .btn:hover:not(:disabled) { background: #e62222; }
        .btn:active:not(:disabled) { transform: scale(0.98); }
        .btn:disabled { background: #2a2a2a; color: #555; cursor: not-allowed; }

        /* Status section */
        .status-card {
          background: #111;
          border: 1px solid #222;
          border-radius: 20px;
          padding: 28px;
          margin-bottom: 20px;
        }

        .status-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 20px;
        }
        .status-label {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 15px;
          font-weight: 500;
        }
        .status-icon { font-size: 18px; }
        .status-pct {
          font-family: 'Syne', sans-serif;
          font-size: 22px;
          font-weight: 700;
          color: #ff2d2d;
        }

        .progress-track {
          height: 4px;
          background: #1e1e1e;
          border-radius: 99px;
          overflow: hidden;
          margin-bottom: 28px;
        }
        .progress-fill {
          height: 100%;
          border-radius: 99px;
          transition: width 0.6s ease;
        }

        /* Steps */
        .steps {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .step {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 14px;
          border-radius: 10px;
          font-size: 13px;
          transition: background 0.2s;
        }
        .step.active {
          background: #1a1a1a;
        }
        .step-dot {
          width: 8px; height: 8px;
          border-radius: 50%;
          background: #2a2a2a;
          flex-shrink: 0;
          transition: background 0.3s;
        }
        .step.done .step-dot { background: #22c55e; }
        .step.active .step-dot {
          background: #ff2d2d;
          box-shadow: 0 0 8px #ff2d2d88;
          animation: pulse 1s infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .step-text { color: #555; }
        .step.done .step-text { color: #888; }
        .step.active .step-text { color: #f0f0f0; }

        /* Clips */
        .clips-header {
          font-family: 'Syne', sans-serif;
          font-size: 18px;
          font-weight: 700;
          color: #22c55e;
          margin-bottom: 20px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .clip-count {
          background: #22c55e22;
          color: #22c55e;
          font-size: 12px;
          font-weight: 600;
          padding: 3px 10px;
          border-radius: 99px;
        }

        .clip-list { display: flex; flex-direction: column; gap: 10px; }
        .clip-item {
          background: #161616;
          border: 1px solid #222;
          border-radius: 14px;
          padding: 16px 18px;
          display: flex;
          align-items: center;
          gap: 14px;
          transition: border-color 0.2s;
        }
        .clip-item:hover { border-color: #333; }
        .clip-num {
          width: 32px; height: 32px;
          background: #ff2d2d22;
          color: #ff2d2d;
          border-radius: 8px;
          display: flex; align-items: center; justify-content: center;
          font-family: 'Syne', sans-serif;
          font-weight: 700;
          font-size: 13px;
          flex-shrink: 0;
        }
        .clip-info { flex: 1; min-width: 0; }
        .clip-reason {
          font-size: 13px;
          color: #ccc;
          margin-bottom: 4px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .clip-time {
          font-size: 11px;
          color: #444;
        }
        .dl-btn {
          background: #ff2d2d;
          color: #fff;
          text-decoration: none;
          border-radius: 10px;
          padding: 8px 16px;
          font-size: 12px;
          font-weight: 600;
          font-family: 'DM Sans', sans-serif;
          transition: background 0.2s;
          white-space: nowrap;
        }
        .dl-btn:hover { background: #e62222; }

        /* Error */
        .error-box {
          background: #1a0a0a;
          border: 1px solid #3a1515;
          border-radius: 14px;
          padding: 20px;
        }
        .error-title {
          color: #ef4444;
          font-weight: 600;
          margin-bottom: 6px;
          font-size: 14px;
        }
        .error-msg {
          color: #666;
          font-size: 13px;
          line-height: 1.5;
        }

        /* Footer hint */
        .hint {
          text-align: center;
          color: #2a2a2a;
          font-size: 12px;
          margin-top: 40px;
        }
      `}</style>

      <div className="wrap">
        {/* Header */}
        <div className="header">
          <div className="logo">
            <div className="logo-icon">🎬</div>
            <h1>YT Clipper</h1>
          </div>
          <p className="tagline">Long video → Top 10 Shorts/Reels (60 sec each)</p>
        </div>

        {/* Input */}
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
        </div>

        {/* Status */}
        {status && cfg && (
          <div className="status-card">
            {status.status !== "done" && status.status !== "error" && (
              <>
                <div className="status-header">
                  <div className="status-label">
                    <span className="status-icon">{cfg.icon}</span>
                    <span style={{ color: cfg.color }}>{cfg.label}{loading ? dots : ""}</span>
                  </div>
                  <div className="status-pct">{status.progress}%</div>
                </div>

                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{ width: `${status.progress}%`, background: cfg.color }}
                  />
                </div>

                {/* Steps */}
                <div className="steps">
                  {Object.entries(statusConfig).filter(([k]) => k !== "done" && k !== "error").map(([key, s]) => {
                    const order = ["queued","downloading","transcribing","analyzing","cutting","uploading"];
                    const curIdx = order.indexOf(status.status);
                    const thisIdx = order.indexOf(key);
                    const state = thisIdx < curIdx ? "done" : thisIdx === curIdx ? "active" : "";
                    return (
                      <div key={key} className={`step ${state}`}>
                        <div className="step-dot" />
                        <span className="step-text">{s.icon} {s.label}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {status.status === "done" && (
              <>
                <div className="clips-header">
                  ✅ Clips Ready
                  <span className="clip-count">{status.clips.length} clips</span>
                </div>
                <div className="clip-list">
                  {status.clips.map(clip => (
                    <div key={clip.index} className="clip-item">
                      <div className="clip-num">#{clip.index}</div>
                      <div className="clip-info">
                        <div className="clip-reason">{clip.reason}</div>
                        <div className="clip-time">⏱ {formatTime(clip.start)} se shuru</div>
                      </div>
                      <a href={clip.url} target="_blank" rel="noopener noreferrer" className="dl-btn">
                        ⬇️ Download
                      </a>
                    </div>
                  ))}
                </div>
              </>
            )}

            {status.status === "error" && (
              <div className="error-box">
                <div className="error-title">❌ Error aaya bhai</div>
                <div className="error-msg">{status.error || "Kuch toh gadbad hai"}</div>
              </div>
            )}
          </div>
        )}

        <div className="hint">Processing time: ~5-10 min per video</div>
      </div>
    </>
  );
}
