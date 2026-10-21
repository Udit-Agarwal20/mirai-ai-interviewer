# LiveKit Cloud Build / Docker deployment for mirai-judge-agent
FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml uv.lock ./
RUN pip install --upgrade pip && \
    pip install "livekit-agents==1.8.8" "livekit-plugins-deepgram==1.8.8" "livekit-plugins-sarvam==1.8.8"

COPY config.py interview.py providers.py timing.py usage.py hosted_agent.py hosted_main.py ./

ENTRYPOINT ["python", "hosted_main.py"]
CMD ["start"]
