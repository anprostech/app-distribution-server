"""Small, retryable upload requests that fit behind reverse-proxy timeouts."""

import json
import shutil
import tempfile
import time
from threading import RLock
from uuid import UUID, uuid4

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool

from app_distribution_server import storage
from app_distribution_server.errors import UserError
from app_distribution_server.logger import logger
from app_distribution_server.routers.api_router import _upload_app, x_auth_token_validator

CHUNK_SIZE = 1024 * 1024
MAX_FILE_SIZE = 2 * 1024**3
SESSION_TTL = 24 * 60 * 60
TRANSFER_ROOT = "_transfers"
transfer_lock = RLock()
active_jobs: set[str] = set()
router = APIRouter(tags=["Resumable uploads"], dependencies=[Depends(x_auth_token_validator)])


class UploadDescription(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    size: int = Field(gt=0, le=MAX_FILE_SIZE)

    @field_validator("filename")
    def app_extension(cls, value):
        if not value.lower().endswith((".ipa", ".apk")):
            raise ValueError("Choose an .ipa or .apk file.")
        return value


def session_path(session_id: str) -> str:
    return f"{TRANSFER_ROOT}/{session_id}"


def save_session(session_id: str, data: dict):
    data["updated"] = time.time()
    root = session_path(session_id)
    storage.filesystem.writetext(f"{root}/session.tmp", json.dumps(data))
    storage.filesystem.move(f"{root}/session.tmp", f"{root}/session.json", overwrite=True)


def read_session(session_id: str) -> dict:
    filename = f"{session_path(session_id)}/session.json"
    if not storage.filesystem.exists(filename):
        raise HTTPException(404, "Upload session expired. Select the file to start again.")
    data = json.loads(storage.filesystem.readtext(filename))
    if time.time() - data["updated"] > SESSION_TTL:
        raise HTTPException(404, "Upload session expired. Select the file to start again.")
    # A container restart can interrupt processing. The completed parts are still usable.
    if data["status"] == "processing" and session_id not in active_jobs:
        data["status"] = "uploading"
        save_session(session_id, data)
    return data


def public_session(session_id: str, data: dict) -> dict:
    received = []
    if data["status"] == "uploading":
        received = [
            int(entry.name[:-5])
            for entry in storage.filesystem.scandir(session_path(session_id))
            if entry.name.endswith(".part") and entry.name[:-5].isdigit()
        ]
    return {
        "session_id": session_id,
        "chunk_size": CHUNK_SIZE,
        "filename": data["filename"],
        "size": data["size"],
        "status": data["status"],
        "received": sorted(received),
        "build": data.get("build"),
        "error": data.get("error"),
    }


@router.post("/api/transfers", status_code=201)
def create_transfer(description: UploadDescription, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    with transfer_lock:
        storage.filesystem.makedirs(TRANSFER_ROOT, recreate=True)
        # Expired temporary files are removed lazily; completed builds live elsewhere.
        for entry in storage.filesystem.scandir(TRANSFER_ROOT):
            if not entry.is_dir or entry.name in active_jobs:
                continue
            filename = f"{TRANSFER_ROOT}/{entry.name}/session.json"
            if storage.filesystem.exists(filename):
                previous = json.loads(storage.filesystem.readtext(filename))
                if time.time() - previous["updated"] > SESSION_TTL:
                    storage.filesystem.removetree(f"{TRANSFER_ROOT}/{entry.name}")
        session_id = str(uuid4())
        storage.filesystem.makedirs(session_path(session_id))
        data = {**description.model_dump(), "status": "uploading"}
        save_session(session_id, data)
        return public_session(session_id, data)


@router.get("/api/transfers/{session_id}")
def transfer_status(session_id: UUID, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    with transfer_lock:
        return public_session(str(session_id), read_session(str(session_id)))


def persist_part(session_id: str, index: int, content: bytes):
    with transfer_lock:
        data = read_session(session_id)
        if data["status"] != "uploading":
            raise HTTPException(409, "This upload is already being processed.")
        remaining = data["size"] - index * CHUNK_SIZE
        if index < 0 or remaining <= 0 or len(content) != min(CHUNK_SIZE, remaining):
            raise HTTPException(400, "Upload part has an incorrect size or index.")
        root = session_path(session_id)
        # Only fully received parts are visible to resume/finalize requests.
        storage.filesystem.writebytes(f"{root}/{index}.tmp", content)
        storage.filesystem.move(f"{root}/{index}.tmp", f"{root}/{index}.part", overwrite=True)
        save_session(session_id, data)


@router.put("/api/transfers/{session_id}/parts/{index}", status_code=204)
async def upload_part(session_id: UUID, index: int, request: Request):
    content = bytearray()
    async for block in request.stream():
        content.extend(block)
        if len(content) > CHUNK_SIZE:
            raise HTTPException(413, "Upload part is too large.")
    await run_in_threadpool(persist_part, str(session_id), index, bytes(content))
    return Response(status_code=204)


def process_transfer(session_id: str, data: dict):
    started = time.monotonic()
    root = session_path(session_id)
    try:
        with tempfile.TemporaryFile() as assembled:
            for index in range((data["size"] + CHUNK_SIZE - 1) // CHUNK_SIZE):
                with storage.filesystem.openbin(f"{root}/{index}.part") as part:
                    shutil.copyfileobj(part, assembled, length=CHUNK_SIZE)
            assembled.seek(0)
            build = _upload_app(UploadFile(file=assembled, filename=data["filename"]))
        data["build"] = build.model_dump(mode="json")
        data["status"] = "complete"
        logger.info(f"Processed upload {session_id!r} in {time.monotonic() - started:.2f}s")
    except Exception as error:
        logger.exception(f"Failed to process upload {session_id!r}")
        data["status"] = "error"
        data["error"] = (
            error.detail if isinstance(error, UserError) else "Could not process this app build."
        )
    finally:
        with transfer_lock:
            try:
                save_session(session_id, data)
                for entry in storage.filesystem.scandir(root):
                    if entry.name.endswith((".part", ".tmp")):
                        storage.filesystem.remove(f"{root}/{entry.name}")
            finally:
                active_jobs.discard(session_id)


@router.post("/api/transfers/{session_id}/complete", status_code=202)
def complete_transfer(session_id: UUID, background: BackgroundTasks, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    transfer_id = str(session_id)
    with transfer_lock:
        data = read_session(transfer_id)
        if data["status"] == "uploading":
            root = session_path(transfer_id)
            for index in range((data["size"] + CHUNK_SIZE - 1) // CHUNK_SIZE):
                filename = f"{root}/{index}.part"
                expected = min(CHUNK_SIZE, data["size"] - index * CHUNK_SIZE)
                if (
                    not storage.filesystem.exists(filename)
                    or storage.filesystem.getsize(filename) != expected
                ):
                    raise HTTPException(409, "Some upload parts are missing. Resume the upload.")
            data["status"] = "processing"
            save_session(transfer_id, data)
            active_jobs.add(transfer_id)
            background.add_task(process_transfer, transfer_id, data.copy())
        return public_session(transfer_id, data)
