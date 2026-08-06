import os
import shutil
import tempfile
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Union
from hashlib import sha256
from secrets import compare_digest, token_urlsafe, token_hex

import jwt
from cachetools import TTLCache
from fastapi import (
    FastAPI,
    WebSocket,
    status,
    Request,
    Response,
    WebSocketDisconnect,
    UploadFile,
    File,
    Form,
)
from fastapi.responses import FileResponse, JSONResponse, Response as RawResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.concurrency import run_in_threadpool

from captcha import CaptchaGenerator

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
MODEL_PATH = Path(os.getenv("ASR_MODEL_PATH", str(ROOT / "parakeet_finetuned2.nemo")))
FFMPEG = os.getenv("FFMPEG_BIN", "ffmpeg")
SECRET = os.getenv("APP_SECRET", "development_fallback_secret_key_change_me")
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "ALLOWED_ORIGINS",
        "http://127.0.0.1:8000,http://localhost:8000",
    ).split(",")
    if o.strip()
]
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "0") == "1"
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(500 * 1024 * 1024)))
MAX_CHUNK_BYTES = int(os.getenv("MAX_CHUNK_BYTES", str(25 * 1024 * 1024)))
DEVICE = os.getenv("ASR_DEVICE", "cuda")
WARMUP_ON_START = os.getenv("ASR_WARMUP", "1") == "1"

MIN_SEC = 30.0
MAX_SEC = 60.0

captcha_cache: TTLCache = TTLCache(maxsize=200, ttl=600)
captcha = CaptchaGenerator()
_asr_model = None
_model_ready = False


def load_asr_model():
    global _asr_model, _model_ready
    if _asr_model is not None:
        return _asr_model
    try:
        import nemo.collections.asr as nemo_asr
    except ModuleNotFoundError as e:
        raise RuntimeError(
            "NeMo not found. Install:\n"
            '  pip install "nemo-toolkit[asr,cu13]" '
            "--extra-index-url https://download.pytorch.org/whl/cu132"
        ) from e

    _asr_model = nemo_asr.models.ASRModel.restore_from(
        str(MODEL_PATH),
        map_location=DEVICE,
    )
    _asr_model.eval()
    _model_ready = True
    return _asr_model


def _warmup_infer():
    """Load weights + one tiny pass so first real chunk is not cold."""
    import wave
    import torch

    model = load_asr_model()
    work = Path(tempfile.mkdtemp(prefix="jos_warm_"))
    try:
        wav = work / "warm.wav"
        with wave.open(str(wav), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(b"\x00\x00" * 16000)  # 1s silence
        with torch.inference_mode():
            model.transcribe([str(wav)])
    finally:
        shutil.rmtree(work, ignore_errors=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if WARMUP_ON_START and MODEL_PATH.exists():
        try:
            await run_in_threadpool(_warmup_infer)
            print(f"[jos] ASR ready on {DEVICE}: {MODEL_PATH.name}")
        except Exception as e:
            print(f"[jos] ASR warmup skipped: {e}")
    yield


limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="Jos ASR", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS if ALLOWED_ORIGINS != ["*"] else ["*"],
    allow_credentials=True,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def coop_for_ffmpeg_wasm(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Embedder-Policy"] = "credentialless"
    return response


def get_client_ip(conn: Union[Request, WebSocket]) -> str:
    forwarded_for = conn.headers.get("X-Forwarded-For")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return conn.client.host if conn.client else ""


async def decode_jwt(token: str):
    try:
        return jwt.decode(token, SECRET, algorithms=["HS256"])
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        return None


async def fp_gen(ip: str, useragent: str, captcha_token: str) -> str:
    return sha256(f"{ip}|{useragent}|{captcha_token}".encode()).hexdigest()


async def jwt_verify(ip: str, useragent: str, captchatoken: str, jwt_token: str) -> bool:
    if not jwt_token or not captchatoken:
        return False
    jwtdata = await decode_jwt(jwt_token)
    if not jwtdata:
        return False
    return (await fp_gen(ip, useragent, captchatoken)) == jwtdata.get("fp", "")


async def generate_jwt(ip: str, user_agent: str, captchatoken: str) -> str:
    payload = {
        "ip": ip,
        "ua": sha256(user_agent.encode()).hexdigest(),
        "fp": await fp_gen(ip, user_agent, captchatoken),
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + timedelta(days=1),
        "jti": token_hex(16),
    }
    return jwt.encode(payload, SECRET, algorithm="HS256")


def verify_captcha_answer(token: str, answer: str) -> bool:
    if not token:
        return False
    expected = captcha_cache.get(token)
    if expected is None:
        return False
    return compare_digest(expected, sha256(answer.upper().encode()).digest())


def create_captcha_data():
    captcha_id = token_urlsafe(32)
    img, answer = captcha.generate_base64(blend_factor=0.7)
    captcha_cache[captcha_id] = sha256(answer.upper().encode()).digest()
    return captcha_id, img


async def require_access(request: Request) -> bool:
    ip = get_client_ip(request)
    ua = request.headers.get("user-agent", "")
    return await jwt_verify(
        ip,
        ua,
        request.cookies.get("captcha_token") or "",
        request.cookies.get("ws_token") or "",
    )


def _hyp_text(item) -> str:
    if hasattr(item, "text"):
        return item.text or ""
    if isinstance(item, (list, tuple)) and item:
        return _hyp_text(item[0])
    return str(item) if item is not None else ""


def _sec(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _extract_timed_segments(hyp, offset: float) -> list[dict]:
    """
    Prefer NeMo segment timestamps; else pack word stamps into short phrases.
    Times are absolute to the full media (offset + local).
    """
    ts = getattr(hyp, "timestamp", None)
    if not isinstance(ts, dict):
        return []

    segments = ts.get("segment") or []
    out: list[dict] = []
    for s in segments:
        if not isinstance(s, dict):
            continue
        text = (s.get("segment") or s.get("text") or "").strip()
        if not text:
            continue
        start = offset + _sec(s.get("start", s.get("start_offset")))
        end = offset + _sec(s.get("end", s.get("end_offset")), start + 1.5)
        if end <= start:
            end = start + 1.2
        out.append({"start": round(start, 3), "end": round(end, 3), "text": text})
    if out:
        return out

    words = ts.get("word") or []
    buf: list[dict] = []
    phrases: list[dict] = []

    def flush():
        nonlocal buf
        if not buf:
            return
        text = " ".join(w["text"] for w in buf).strip()
        if text:
            phrases.append({
                "start": round(buf[0]["start"], 3),
                "end": round(buf[-1]["end"], 3),
                "text": text,
            })
        buf = []

    for w in words:
        if not isinstance(w, dict):
            continue
        token = (w.get("word") or w.get("text") or "").strip()
        if not token:
            continue
        start = offset + _sec(w.get("start", w.get("start_offset")))
        end = offset + _sec(w.get("end", w.get("end_offset")), start + 0.25)
        buf.append({"text": token, "start": start, "end": end})
        punct = token[-1] in ".!?" if token else False
        if punct or len(buf) >= 10:
            flush()
    flush()
    return phrases


def transcribe_file(wav_path: Path, offset: float = 0.0) -> tuple[str, list[dict]]:
    import torch

    model = load_asr_model()
    with torch.inference_mode():
        try:
            predictions = model.transcribe([str(wav_path)], timestamps=True)
        except TypeError:
            predictions = model.transcribe([str(wav_path)])

    if not predictions:
        return "", []
    hyp = predictions[0]
    text = _hyp_text(hyp)
    segs = _extract_timed_segments(hyp, offset)
    return text, segs


def ffmpeg_to_wav16k(src: Path, dst: Path) -> None:
    # Native ffmpeg: threads + quiet log → much faster than wasm
    cmd = [
        FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
        "-threads", "0",
        "-i", str(src),
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        str(dst),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not dst.exists():
        raise RuntimeError(proc.stderr[-800:] if proc.stderr else "ffmpeg failed")


class VerifyRequest(BaseModel):
    answer: str = Field(min_length=4, max_length=10)


@app.get("/captcha/generate")
@limiter.limit("6/minute")
async def generate_captcha_route(request: Request, response: Response):
    captcha_id, img = await run_in_threadpool(create_captcha_data)
    response.set_cookie(
        key="captcha_token",
        value=captcha_id,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        max_age=600,
    )
    return {"img": img}


@app.post("/captcha/verify")
@limiter.limit("3/minute")
async def verify_captcha_route(request: Request, data: VerifyRequest, response: Response):
    captcha_token = request.cookies.get("captcha_token")
    user_agent = request.headers.get("user-agent")
    if not captcha_token or not user_agent:
        return JSONResponse({"error": "Session expired. Refresh the captcha."}, status_code=400)

    if verify_captcha_answer(captcha_token, data.answer):
        captcha_cache.pop(captcha_token, None)
        ip = get_client_ip(request)
        ws_token = await generate_jwt(ip, user_agent, captchatoken=captcha_token)
        response.set_cookie(
            key="ws_token",
            value=ws_token,
            httponly=True,
            secure=COOKIE_SECURE,
            samesite="lax",
            max_age=86400,
        )
        return {"status": "OK", "access_hours": 24, "model_ready": _model_ready}

    captcha_cache.pop(captcha_token, None)
    return JSONResponse({"error": "Wrong answer. New captcha loaded."}, status_code=400)


@app.get("/auth/status")
async def auth_status(request: Request):
    ip = get_client_ip(request)
    ua = request.headers.get("user-agent", "")
    captcha_token = request.cookies.get("captcha_token")
    ws_token = request.cookies.get("ws_token")
    ok = await jwt_verify(ip, ua, captcha_token or "", ws_token or "")
    exp = None
    if ok and ws_token:
        data = await decode_jwt(ws_token)
        if data and "exp" in data:
            exp = data["exp"]
    return {
        "ok": ok,
        "expires_at": exp,
        "model_ready": _model_ready,
        "chunking": {
            "min_sec": MIN_SEC,
            "max_sec": MAX_SEC,
            "vad": "webrtc",
            "where": "frontend",
        },
    }


@app.post("/api/warmup")
@limiter.limit("2/minute")
async def warmup_route(request: Request):
    if not await require_access(request):
        return JSONResponse({"error": "Access locked."}, status_code=401)
    if _model_ready:
        return {"status": "ready"}
    await run_in_threadpool(load_asr_model)
    return {"status": "ready"}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    ip = get_client_ip(ws)
    ua = ws.headers.get("user-agent", "")
    if not await jwt_verify(
        ip, ua, ws.cookies.get("captcha_token") or "", ws.cookies.get("ws_token") or ""
    ):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    await ws.accept()
    try:
        while True:
            message = await ws.receive()
            if "text" in message and message["text"] == "ping":
                await ws.send_text("pong")
            elif message.get("type") == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass


@app.post("/api/extract")
@limiter.limit("10/minute")
async def extract_audio(request: Request, file: UploadFile = File(...)):
    if not await require_access(request):
        return JSONResponse({"error": "Access locked. Solve the captcha first."}, status_code=401)

    raw = await file.read()
    if not raw or len(raw) > MAX_UPLOAD_BYTES:
        return JSONResponse({"error": "Invalid file."}, status_code=400)

    suffix = Path(file.filename or "media.bin").suffix or ".bin"
    work = Path(tempfile.mkdtemp(prefix="jos_ex_"))
    try:
        src = work / f"input{suffix}"
        dst = work / "audio.wav"
        src.write_bytes(raw)
        await run_in_threadpool(ffmpeg_to_wav16k, src, dst)
        data = dst.read_bytes()
        return RawResponse(
            content=data,
            media_type="audio/wav",
            headers={"Content-Disposition": 'attachment; filename="audio.wav"'},
        )
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    finally:
        shutil.rmtree(work, ignore_errors=True)


@app.post("/api/transcribe/chunk")
@limiter.limit("120/minute")
async def transcribe_chunk(
    request: Request,
    file: UploadFile = File(...),
    index: int = Form(0),
    start: float = Form(0.0),
    end: float = Form(0.0),
):
    if not await require_access(request):
        return JSONResponse({"error": "Access locked. Solve the captcha first."}, status_code=401)

    raw = await file.read()
    if not raw or len(raw) > MAX_CHUNK_BYTES:
        return JSONResponse({"error": "Invalid chunk."}, status_code=400)

    # Named temp under system temp; keep path short for Windows
    fd, path_str = tempfile.mkstemp(suffix=".wav", prefix="jos_")
    os.close(fd)
    wav = Path(path_str)
    try:
        wav.write_bytes(raw)
        text, segments = await run_in_threadpool(transcribe_file, wav, float(start))
        return {
            "index": index,
            "start": start,
            "end": end,
            "text": text,
            "segments": segments,
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    finally:
        wav.unlink(missing_ok=True)


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


if STATIC.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")
