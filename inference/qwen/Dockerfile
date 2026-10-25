FROM python:3.12-slim-bookworm
WORKDIR /service
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 NODE_ENV=production \
    QWEN_DATA_DIR=/data/qwen HF_HOME=/cache/huggingface
COPY requirements-service.txt requirements-gpu.txt ./
RUN pip install --no-cache-dir -r requirements-gpu.txt \
    && useradd --create-home --uid 10001 qwen \
    && mkdir -p /data/qwen /cache/huggingface \
    && chown -R qwen:qwen /data/qwen /cache/huggingface
COPY --chown=qwen:qwen app.py ./app.py
USER qwen
EXPOSE 8000
# One process owns the SQLite queue and CUDA engine. Do not increase workers.
CMD ["uvicorn", "app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
