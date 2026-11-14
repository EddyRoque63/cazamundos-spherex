"""
Acceso a datos SPHEREx en IRSA (NASA/IPAC Infrared Science Archive).

Flujo:
  1. Consulta SIA2 a IRSA (colección DR1 y otras): qué imágenes cubren (RA, Dec).
  2. Descarga recortes ("cutouts") de cada imagen (con caché en disco).
  3. Resta la luz zodiacal (extensión ZODI) y reproyecta cada recorte a una
     cuadrícula común (proyección TAN centrada en el objetivo) para que todas
     las imágenes queden alineadas píxel a píxel.
  4. Calcula la longitud de onda central de cada imagen en la posición del
     objetivo (SPHEREx usa filtros lineales variables: la longitud de onda
     cambia a lo largo del detector).

Como siempre se consulta el archivo en vivo, las nuevas entregas semanales de
SPHEREx aparecen automáticamente sin cambiar el código.
"""
from __future__ import annotations

import base64
import hashlib
import math
import os
import threading
import time
import uuid
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import requests
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

warnings.filterwarnings("ignore", category=FITSFixedWarning)
warnings.filterwarnings("ignore", message=".*datfix.*")

IRSA = "https://irsa.ipac.caltech.edu"
CACHE_DIR = Path(__file__).resolve().parent / "cache" / "cutouts"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

NATIVE_PIX_ARCSEC = 6.15      # tamaño de píxel nativo de SPHEREx
MAX_GRID_PIX = 160            # tamaño máximo de la cuadrícula de salida
MIN_COVERAGE = 0.25           # descarta recortes que cubren menos del 25 %
DOWNLOAD_THREADS = 8

# Rangos aproximados de longitud de onda (µm) de los 6 detectores
DETECTORS = {
    1: (0.75, 1.09),
    2: (1.10, 1.62),
    3: (1.63, 2.41),
    4: (2.42, 3.82),
    5: (3.83, 4.41),
    6: (4.42, 5.00),
}


# --------------------------------------------------------------------------
# Consulta de metadatos
# --------------------------------------------------------------------------
# Colecciones de IRSA a consultar, en orden de preferencia. IRSA reorganiza
# los lanzamientos de SPHEREx (QR → DR1 → …): se puede cambiar sin tocar el
# código con la variable de entorno SPHEREX_COLLECTIONS.
COLLECTIONS = [c.strip() for c in os.environ.get(
    "SPHEREX_COLLECTIONS", "spherex_dr1,spherex_qr3,spherex_qr2,spherex_qr").split(",") if c.strip()]
SIA_URL = IRSA + "/SIA"


def _sia(collection: str, ra: float, dec: float) -> list[dict]:
    """Consulta SIA2 (rápida) de una colección SPHEREx en IRSA."""
    import io
    from astropy.io.votable import parse_single_table

    params = {
        "COLLECTION": collection,
        "POS": f"circle {ra:.8f} {dec:.8f} 0.0005",
        "RESPONSEFORMAT": "VOTABLE",
        "MAXREC": "20000",
    }
    r = requests.get(SIA_URL, params=params, timeout=120)
    r.raise_for_status()
    table = parse_single_table(io.BytesIO(r.content)).to_table()
    rows = []
    for row in table:
        try:
            url = str(row["access_url"]).strip()
            band = str(row["energy_bandpassname"]).strip()
            mjd = float(row["t_min"])
            obs = str(row["obs_id"]).strip()
        except (KeyError, TypeError, ValueError):
            continue
        sub = str(row["dataproduct_subtype"]).strip().lower() if "dataproduct_subtype" in table.colnames else "science"
        if not url.lower().endswith(".fits") or "spherex-d" not in band.lower() or sub not in ("science", ""):
            continue
        rows.append({"base": url, "mjd": mjd, "band": band, "obs": obs, "collection": collection})
    return rows


def query_images(ra: float, dec: float, size_deg: float) -> list[dict]:
    """Lista de imágenes SPHEREx que contienen (ra, dec), de la más antigua a la más reciente."""
    found, errors = [], []
    for col in COLLECTIONS:
        try:
            found.extend(_sia(col, ra, dec))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{col}: {exc}")
            print("Aviso SIA", col, exc)
    if not found and errors and len(errors) == len(COLLECTIONS):
        raise RuntimeError("No se pudo consultar IRSA: " + "; ".join(errors))

    rows, seen = [], set()
    for f in found:                       # la primera colección (más reciente) tiene prioridad
        key = (f["obs"], f["band"])
        if key in seen:
            continue
        seen.add(key)
        try:
            det = int(f["band"].lower().split("spherex-d")[1][:1])
        except (IndexError, ValueError):
            det = 0
        url = f"{f['base']}?center={ra:.8f},{dec:.8f}d&size={size_deg:.5f}"
        rows.append({"url": url, "mjd": f["mjd"], "band": f["band"], "detector": det,
                     "collection": f["collection"]})
    rows.sort(key=lambda r: r["mjd"])
    return rows


def subsample(rows: list[dict], max_images: int) -> list[dict]:
    """Si hay demasiadas imágenes, toma una muestra uniforme en el tiempo."""
    if len(rows) <= max_images:
        return rows
    idx = np.unique(np.linspace(0, len(rows) - 1, max_images).round().astype(int))
    return [rows[i] for i in idx]


# --------------------------------------------------------------------------
# Descarga con caché
# --------------------------------------------------------------------------
def fetch_cutout(url: str, retries: int = 2) -> Path:
    key = hashlib.sha1(url.encode()).hexdigest()
    path = CACHE_DIR / f"{key}.fits"
    if path.exists() and path.stat().st_size > 2880:
        return path
    last = None
    for attempt in range(retries + 1):
        try:
            r = requests.get(url, timeout=180)
            r.raise_for_status()
            tmp = path.with_suffix(".part")
            tmp.write_bytes(r.content)
            tmp.replace(path)
            return path
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"No se pudo descargar el recorte: {last}")


# --------------------------------------------------------------------------
# Cuadrícula común y procesamiento
# --------------------------------------------------------------------------
def make_grid(ra: float, dec: float, fov_arcmin: float) -> tuple[WCS, tuple[int, int], float]:
    fov_arcsec = fov_arcmin * 60.0
    scale = max(NATIVE_PIX_ARCSEC, fov_arcsec / MAX_GRID_PIX)
    n = int(math.ceil(fov_arcsec / scale))
    n += (n + 1) % 2                     # número impar: el objetivo cae en el píxel central
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2.0, (n + 1) / 2.0]
    w.wcs.cdelt = [-scale / 3600.0, scale / 3600.0]
    return w, (n, n), scale


def _hdu(hdul, name):
    try:
        return hdul[name]
    except KeyError:
        return None


def central_wavelength(hdul, header, ra, dec, detector) -> float:
    """Longitud de onda (µm) de la imagen en la posición del objetivo."""
    try:
        cel = WCS(header).celestial
        x, y = cel.world_to_pixel(SkyCoord(ra, dec, unit="deg"))
        swcs = WCS(header, fobj=hdul, key="W")
        swcs.sip = None
        out = swcs.pixel_to_world(x, y)
        lam = out[0] if isinstance(out, (list, tuple)) else out
        lam = u.Quantity(lam).to(u.micrometer).value
        lam = float(np.ravel(lam)[0])
        if 0.5 < lam < 5.5:
            return lam
    except Exception:  # noqa: BLE001
        pass
    lo, hi = DETECTORS.get(detector, (0.75, 5.0))
    return (lo + hi) / 2.0


def process_cutout(path: Path, grid_wcs: WCS, shape, ra, dec, detector) -> dict | None:
    from reproject import reproject_interp

    with fits.open(path, memmap=False) as hdul:
        img = _hdu(hdul, "IMAGE")
        if img is None or img.data is None:
            return None
        data = np.asarray(img.data, dtype=np.float32)
        zodi = _hdu(hdul, "ZODI")
        if zodi is not None and zodi.data is not None and zodi.data.shape == data.shape:
            data = data - np.asarray(zodi.data, dtype=np.float32)
        flags_hdu = _hdu(hdul, "FLAGS")
        flags = None
        if flags_hdu is not None and flags_hdu.data is not None:
            flags = (np.asarray(flags_hdu.data) != 0).astype(np.float32)

        cel = WCS(img.header).celestial
        lam = central_wavelength(hdul, img.header, ra, dec, detector)

    out, foot = reproject_interp((data, cel), grid_wcs, shape_out=shape)
    out = out.astype(np.float32)
    out[foot <= 0] = np.nan
    coverage = float(np.mean(np.isfinite(out)))
    if coverage < MIN_COVERAGE:
        return None

    if flags is not None:
        fmask, _ = reproject_interp((flags, cel), grid_wcs, shape_out=shape, order="nearest-neighbor")
        fmask = np.nan_to_num(fmask) > 0.5
    else:
        fmask = np.zeros(shape, dtype=bool)

    return {
        "data": out,
        "flags": fmask.astype(np.uint8),
        "wavelength": lam,
        "coverage": coverage,
        "flag_frac": float(fmask[np.isfinite(out)].mean()) if np.isfinite(out).any() else 0.0,
    }


def b64(arr: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode("ascii")


# --------------------------------------------------------------------------
# Trabajos en segundo plano (la descarga puede tardar uno o dos minutos)
# --------------------------------------------------------------------------
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()


def _set(job_id, **kw):
    with JOBS_LOCK:
        JOBS[job_id].update(kw)


def build_cube(job_id: str, ra: float, dec: float, fov_arcmin: float, max_images: int):
    try:
        grid_wcs, shape, scale = make_grid(ra, dec, fov_arcmin)
        size_deg = fov_arcmin / 60.0 * 1.45 + 2 * NATIVE_PIX_ARCSEC / 3600.0

        _set(job_id, message="Consultando el archivo IRSA…")
        rows = query_images(ra, dec, size_deg)
        total_found = len(rows)
        if not rows:
            _set(job_id, status="done", result={
                "grid": _grid_info(ra, dec, scale, shape), "visits": [],
                "total_found": 0, "source": "IRSA SPHEREx"})
            return
        rows = subsample(rows, max_images)
        _set(job_id, total=len(rows), progress=0,
             message=f"Descargando {len(rows)} recortes de {total_found} imágenes…")

        visits, done = [], 0
        with ThreadPoolExecutor(max_workers=DOWNLOAD_THREADS) as pool:
            futures = {pool.submit(fetch_cutout, r["url"]): r for r in rows}
            for fut in as_completed(futures):
                row = futures[fut]
                done += 1
                try:
                    p = fut.result()
                    res = process_cutout(p, grid_wcs, shape, ra, dec, row["detector"])
                    if res is not None:
                        visits.append({
                            "mjd": row["mjd"], "band": row["band"], "detector": row["detector"],
                            "wavelength": round(res["wavelength"], 4),
                            "coverage": round(res["coverage"], 3),
                            "flag_frac": round(res["flag_frac"], 4),
                            "data": b64(res["data"]), "flags": b64(res["flags"]),
                        })
                except Exception as exc:  # noqa: BLE001
                    print("Aviso:", exc)
                _set(job_id, progress=done)

        visits.sort(key=lambda v: v["mjd"])
        _set(job_id, status="done", result={
            "grid": _grid_info(ra, dec, scale, shape),
            "visits": visits, "total_found": total_found,
            "source": "IRSA SPHEREx (" + ", ".join(sorted({r.get("collection", "") for r in rows})) + ")"})
    except Exception as exc:  # noqa: BLE001
        _set(job_id, status="error", error=str(exc))


def _grid_info(ra, dec, scale, shape):
    return {"ra": ra, "dec": dec, "scale_arcsec": scale, "nx": shape[1], "ny": shape[0]}


def start_job(ra, dec, fov_arcmin, max_images) -> str:
    job_id = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        # limpia trabajos viejos
        now = time.time()
        for k in [k for k, v in JOBS.items() if now - v["created"] > 3600]:
            del JOBS[k]
        JOBS[job_id] = {"status": "running", "progress": 0, "total": 0,
                        "message": "Iniciando…", "created": now}
    threading.Thread(target=build_cube, args=(job_id, ra, dec, fov_arcmin, max_images),
                     daemon=True).start()
    return job_id


def get_job(job_id: str) -> dict | None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        return dict(job) if job else None
