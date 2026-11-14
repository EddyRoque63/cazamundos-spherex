"""
Servidor de CazaMundos SPHEREx.

Ejecutar desde la carpeta del proyecto:
    python -m uvicorn backend.app:app --port 8000
y abrir http://localhost:8000
"""
from __future__ import annotations

import base64
import io
import json
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import catalogs, spherex

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
DATA_DIR = Path(__file__).resolve().parent / "data"
DATA_DIR.mkdir(exist_ok=True)
CANDIDATES_FILE = DATA_DIR / "candidatos.json"
_cand_lock = threading.Lock()

app = FastAPI(title="CazaMundos SPHEREx", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/health")
def health():
    return {"ok": True, "app": "CazaMundos SPHEREx", "version": app.version}


@app.get("/api/resolve")
def resolve(q: str = Query(..., min_length=1)):
    try:
        return catalogs.resolve(q)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Error consultando SIMBAD: {exc}") from exc


class CubeRequest(BaseModel):
    ra: float = Field(..., ge=0, lt=360)
    dec: float = Field(..., ge=-90, le=90)
    fov_arcmin: float = Field(6.0, ge=1.0, le=30.0)
    max_images: int = Field(240, ge=10, le=1000)


@app.post("/api/cube")
def cube(req: CubeRequest):
    job_id = spherex.start_job(req.ra, req.dec, req.fov_arcmin, req.max_images)
    return {"job_id": job_id}


@app.get("/api/job/{job_id}")
def job(job_id: str):
    j = spherex.get_job(job_id)
    if j is None:
        raise HTTPException(404, "Trabajo no encontrado")
    j.pop("created", None)
    return j


@app.get("/api/catalog/{kind}")
def catalog(kind: str, ra: float, dec: float, radius_arcmin: float = Query(5, le=30)):
    if kind not in catalogs.CATALOGS:
        raise HTTPException(404, "Catálogo desconocido")
    try:
        rows = catalogs.query_catalog(kind, round(ra, 5), round(dec, 5), round(radius_arcmin, 2))
        return {"kind": kind, "epoch": catalogs.CATALOGS[kind]["epoch"], "sources": rows}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Error consultando VizieR: {exc}") from exc


@app.get("/api/asteroids")
def asteroids(ra: float, dec: float, mjd: float, radius_arcmin: float = Query(5, le=30)):
    try:
        return {"mjd": mjd, "objects": catalogs.query_asteroids(
            round(ra, 4), round(dec, 4), round(radius_arcmin, 2), round(mjd, 2))}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Error consultando SkyBoT: {exc}") from exc


# ---------------------------------------------------------------- candidatos
class Candidate(BaseModel):
    ra: float
    dec: float
    mjd: float | None = None
    field_ra: float | None = None
    field_dec: float | None = None
    note: str = Field("", max_length=500)
    author: str = Field("", max_length=80)


def _load_candidates():
    if CANDIDATES_FILE.exists():
        try:
            return json.loads(CANDIDATES_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return []
    return []


@app.get("/api/candidates")
def list_candidates():
    with _cand_lock:
        return _load_candidates()


@app.post("/api/candidates")
def add_candidate(c: Candidate):
    with _cand_lock:
        items = _load_candidates()
        item = c.model_dump()
        item["id"] = int(time.time() * 1000)
        item["created"] = time.strftime("%Y-%m-%d %H:%M")
        items.append(item)
        CANDIDATES_FILE.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")
    return item


# ---------------------------------------------------------------- GIF
class GifRequest(BaseModel):
    frames: list[str]
    fps: float = Field(2.0, gt=0, le=20)


@app.post("/api/gif")
def make_gif(req: GifRequest):
    from PIL import Image

    if not req.frames or len(req.frames) > 400:
        raise HTTPException(400, "Número de cuadros inválido")
    imgs = []
    for f in req.frames:
        raw = base64.b64decode(f.split(",", 1)[-1])
        imgs.append(Image.open(io.BytesIO(raw)).convert("RGB")
                    .convert("P", palette=Image.ADAPTIVE, colors=255))
    buf = io.BytesIO()
    imgs[0].save(buf, format="GIF", save_all=True, append_images=imgs[1:],
                 duration=int(1000 / req.fps), loop=0, disposal=2)
    return Response(buf.getvalue(), media_type="image/gif",
                    headers={"Content-Disposition": 'attachment; filename="spherex_blink.gif"'})


# La página web (debe montarse al final)
app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
