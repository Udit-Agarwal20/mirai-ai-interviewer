# LiveKit Cloud Build / Docker deployment for mirai-judge-agent
# Pinned to Python 3.12 with reproducible locked dependencies via uv.lock
# syntax=docker/dockerfile:1

ARG PYTHON_VERSION=3.12
FROM ghcr.io/astral-sh/uv:python${PYTHON_VERSION}-bookworm-slim AS base

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

# --- Build stage ---
FROM base AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    python3-dev \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency specifications first for layer caching
COPY pyproject.toml uv.lock ./

# Install exact pinned dependencies from uv.lock
RUN uv sync --locked --no-dev

# Pre-download required LiveKit plugin models/files to avoid runtime download delays
RUN uv run --module livekit.agents download-files

# Copy application source code (excluded items filtered by .dockerignore)
COPY config.py interview.py providers.py timing.py usage.py hosted_agent.py hosted_main.py ./

# --- Production runner stage ---
FROM base AS runner

ARG UID=10001
RUN adduser \
    --disabled-password \
    --gecos "" \
    --home "/app" \
    --shell "/sbin/nologin" \
    --uid "${UID}" \
    appuser

WORKDIR /app

# Copy application and virtualenv from build stage with non-root ownership
COPY --from=build --chown=appuser:appuser /app /app

# Switch to non-root execution
USER appuser
ENV PATH="/app/.venv/bin:$PATH"

ENTRYPOINT ["python", "hosted_main.py"]
CMD ["start"]
