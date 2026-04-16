FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    ffmpeg git wget \
    pkg-config \
    nodejs npm \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g n && n lts
RUN ln -sf $(which node) /usr/local/bin/node || true

RUN pip install --upgrade pip setuptools wheel
RUN pip install yt-dlp && pip install --upgrade yt-dlp
RUN yt-dlp --install-deps 2>/dev/null || true

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN touch /tmp/yt_cookies.txt

COPY . .

EXPOSE 8000

CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
