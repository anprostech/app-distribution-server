FROM python:3.12.1-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY ./requirements.txt ./
# PyFilesystem2 still imports pkg_resources at runtime.
RUN pip install --no-cache-dir setuptools==80.10.2 -r requirements.txt

COPY ./ ./

ARG APP_VERSION
ENV APP_VERSION=$APP_VERSION
ENV STORAGE_URL="osfs:///uploads"

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"

CMD ["uvicorn", "--host=0.0.0.0", "--port=8000", "app_distribution_server.app:app"]
