"""
Servicios auxiliares: resolución de nombres (SIMBAD), catálogos de otros
telescopios (Gaia DR3 y CatWISE2020 vía VizieR) y asteroides conocidos (SkyBoT).
"""
from __future__ import annotations

import re
from functools import lru_cache

import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord

TARGET_EPOCH = 2026.0   # época a la que se propaga el movimiento propio de SIMBAD

_FLOAT_PAIR = re.compile(r"^\s*([+-]?\d+(?:\.\d*)?)\s*[,\s]\s*([+-]?\d+(?:\.\d*)?)\s*$")


def _num(v, default=0.0):
    try:
        if np.ma.is_masked(v):
            return default
        f = float(v)
        return default if not np.isfinite(f) else f
    except (TypeError, ValueError):
        return default


def parse_coords(q: str) -> SkyCoord | None:
    m = _FLOAT_PAIR.match(q)
    if m:
        return SkyCoord(float(m.group(1)), float(m.group(2)), unit="deg")
    try:
        if re.search(r"\d+h\s*\d+m", q):
            return SkyCoord(q)
        if ":" in q or re.match(r"^\s*\d{1,2}\s+\d{1,2}\s+\d", q):
            return SkyCoord(q, unit=(u.hourangle, u.deg))
    except Exception:  # noqa: BLE001
        return None
    return None


@lru_cache(maxsize=256)
def resolve(q: str) -> dict:
    q = q.strip()
    c = parse_coords(q)
    if c is not None:
        return {"name": q, "ra": c.ra.deg, "dec": c.dec.deg, "pmra": 0.0, "pmdec": 0.0,
                "source": "coordenadas"}

    try:
        from astroquery.simbad import Simbad
        s = Simbad()
        s.add_votable_fields("pmra", "pmdec")
        t = s.query_object(q)
    except Exception as exc:  # noqa: BLE001
        t = None
        err = exc
    if t is not None and len(t) > 0:
        cols = {c.lower(): c for c in t.colnames}
        ra_col, dec_col = cols.get("ra"), cols.get("dec")
        if ra_col is not None and t[ra_col].dtype.kind == "f":
            ra, dec = float(t[ra_col][0]), float(t[dec_col][0])
        else:
            cc = SkyCoord(str(t[ra_col][0]), str(t[dec_col][0]), unit=(u.hourangle, u.deg))
            ra, dec = cc.ra.deg, cc.dec.deg
        pmra = _num(t[cols["pmra"]][0]) if "pmra" in cols else 0.0
        pmdec = _num(t[cols["pmdec"]][0]) if "pmdec" in cols else 0.0
        name = str(t[cols.get("main_id", t.colnames[0])][0])
        # Propaga la posición J2000 (época 2000) a la época de los datos SPHEREx
        dt = TARGET_EPOCH - 2000.0
        ra_p = ra + pmra * dt / 3.6e6 / max(np.cos(np.radians(dec)), 1e-6)
        dec_p = dec + pmdec * dt / 3.6e6
        return {"name": name, "ra": ra_p, "dec": dec_p, "pmra": pmra, "pmdec": pmdec,
                "epoch": TARGET_EPOCH, "source": "SIMBAD"}

    # último recurso: Sesame (sin movimiento propio)
    try:
        c = SkyCoord.from_name(q)
        return {"name": q, "ra": c.ra.deg, "dec": c.dec.deg, "pmra": 0.0, "pmdec": 0.0,
                "source": "Sesame"}
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"No se encontró «{q}».") from exc


# --------------------------------------------------------------------------
# Catálogos con movimiento propio
# --------------------------------------------------------------------------
CATALOGS = {
    "gaia": {"vizier": "I/355/gaiadr3", "epoch": 2016.0, "mag": ["Gmag"], "id": ["Source", "DR3Name"]},
    "catwise": {"vizier": "II/365/catwise", "epoch": 2015.4,
                "mag": ["W1mproPM", "W1mpro"], "id": ["Name", "objID"]},
}


def _col(t, names):
    for n in names:
        if n in t.colnames:
            return t[n]
    return None


def _pm_mas(col):
    if col is None:
        return None
    try:
        if col.unit is not None:
            return u.Quantity(col).to_value(u.mas / u.yr)
    except Exception:  # noqa: BLE001
        pass
    return np.asarray(col, dtype=float)


@lru_cache(maxsize=128)
def query_catalog(kind: str, ra: float, dec: float, radius_arcmin: float) -> list[dict]:
    from astroquery.vizier import Vizier

    cfg = CATALOGS[kind]
    v = Vizier(columns=["*", "+_r"], row_limit=3000)
    res = v.query_region(SkyCoord(ra, dec, unit="deg"), radius=radius_arcmin * u.arcmin,
                         catalog=cfg["vizier"])
    if not res:
        return []
    t = res[0]
    ra_c = _col(t, ["RA_ICRS", "RAJ2000", "RAdeg", "RA_ICRS_"])
    de_c = _col(t, ["DE_ICRS", "DEJ2000", "DEdeg", "DE_ICRS_"])
    if ra_c is None or de_c is None:
        return []
    pmra = _pm_mas(_col(t, ["pmRA"]))
    pmde = _pm_mas(_col(t, ["pmDE"]))
    mag = _col(t, cfg["mag"])
    ids = _col(t, cfg["id"])
    out = []
    for i in range(len(t)):
        out.append({
            "ra": _num(ra_c[i]), "dec": _num(de_c[i]),
            "pmra": _num(pmra[i]) if pmra is not None else 0.0,
            "pmdec": _num(pmde[i]) if pmde is not None else 0.0,
            "mag": round(_num(mag[i], np.nan), 2) if mag is not None else None,
            "id": str(ids[i]) if ids is not None else "",
        })
    for o in out:
        if o["mag"] is not None and not np.isfinite(o["mag"]):
            o["mag"] = None
    return out


# --------------------------------------------------------------------------
# Asteroides y cometas conocidos (IMCCE SkyBoT)
# --------------------------------------------------------------------------
@lru_cache(maxsize=256)
def query_asteroids(ra: float, dec: float, radius_arcmin: float, mjd: float) -> list[dict]:
    from astropy.time import Time
    from astroquery.imcce import Skybot

    try:
        t = Skybot.cone_search(SkyCoord(ra, dec, unit="deg"), radius_arcmin * u.arcmin,
                               Time(mjd, format="mjd"), location="500")
    except RuntimeError:
        return []   # SkyBoT lanza error cuando no hay objetos
    out = []
    for r in t:
        out.append({
            "name": str(r["Name"]),
            "ra": float(u.Quantity(r["RA"]).to_value(u.deg)),
            "dec": float(u.Quantity(r["DEC"]).to_value(u.deg)),
            "vmag": _num(r["V"], None) if "V" in t.colnames else None,
            "type": str(r["Type"]) if "Type" in t.colnames else "",
        })
    return out
