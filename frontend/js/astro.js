/* =========================================================================
   astro.js — utilidades astronómicas y de procesamiento de imágenes
   (proyección TAN, épocas, apilado, fotometría, cuerpo negro, escalas)
   ========================================================================= */
"use strict";

const Astro = (() => {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const MJD_UNIX0 = 40587;               // MJD del 1970-01-01
  const DETECTORS = {
    1: [0.75, 1.09], 2: [1.10, 1.62], 3: [1.63, 2.41],
    4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.00],
  };

  // Combinaciones RGB (rangos de longitud de onda en µm). El canal verde se
  // coloca sobre la banda de absorción y rojo/azul sobre el continuo vecino:
  // los objetos que absorben en esa molécula pierden el verde y se ven
  // MAGENTA o ROJOS (las enanas marrones frías, muy rojas, se ven rojas).
  const PRESETS = {
    detectors: { name: "Detectores", r: [3.83, 5.0], g: [1.63, 3.82], b: [0.75, 1.62] },
    methane:   { name: "Metano 3.3 µm", r: [3.85, 4.20], g: [3.20, 3.45], b: [2.00, 2.35] },
    water:     { name: "Agua 3.0 µm", r: [3.55, 3.85], g: [2.85, 3.15], b: [2.10, 2.40] },
    co2:       { name: "CO₂ 4.27 µm", r: [4.42, 4.58], g: [4.20, 4.34], b: [3.95, 4.12] },
    co:        { name: "CO 4.67 µm", r: [4.80, 5.00], g: [4.58, 4.75], b: [4.38, 4.52] },
  };

  // Bandas moleculares que se marcan en el gráfico del espectro
  const FEATURES = [
    { name: "H₂O", lo: 1.33, hi: 1.48 },
    { name: "H₂O", lo: 1.80, hi: 1.95 },
    { name: "H₂O hielo", lo: 2.90, hi: 3.10 },
    { name: "CH₄", lo: 3.20, hi: 3.45 },
    { name: "CO₂", lo: 4.22, hi: 4.32 },
    { name: "CO", lo: 4.58, hi: 4.75 },
  ];

  // ---------------------------------------------------------- tiempo
  const mjdToDate = (mjd) => new Date((mjd - MJD_UNIX0) * 86400000);
  const mjdToISO = (mjd) => mjdToDate(mjd).toISOString().slice(0, 10);
  const mjdToYear = (mjd) => 1970 + (mjd - MJD_UNIX0) / 365.25;

  // ---------------------------------------------------------- coordenadas
  function parseCoords(str) {
    const s = String(str || "").trim();
    if (!s) return null;
    const nums = s.match(/[+-]?\d+(?:\.\d+)?/g);
    if (!nums) return null;
    const letters = s.replace(/[\d\s.+\-:,hmsd°'"′″]/gi, "");
    if (letters.length > 0) return null;           // contiene un nombre
    const sexa = /[hms:]/i.test(s) || nums.length >= 4;
    if (nums.length === 2 && !sexa) {
      const ra = parseFloat(nums[0]), dec = parseFloat(nums[1]);
      if (ra >= 0 && ra < 360 && Math.abs(dec) <= 90) return { ra, dec };
      return null;
    }
    let ra, dec;
    if (nums.length === 6) {
      ra = (Math.abs(+nums[0]) + +nums[1] / 60 + +nums[2] / 3600) * 15;
      const sign = nums[3].startsWith("-") ? -1 : 1;
      dec = sign * (Math.abs(+nums[3]) + +nums[4] / 60 + +nums[5] / 3600);
    } else if (nums.length === 4) {
      ra = (Math.abs(+nums[0]) + +nums[1] / 60) * 15;
      const sign = nums[2].startsWith("-") ? -1 : 1;
      dec = sign * (Math.abs(+nums[2]) + +nums[3] / 60);
    } else return null;
    if (ra >= 0 && ra < 360 && Math.abs(dec) <= 90) return { ra, dec };
    return null;
  }

  function fmtRA(ra) {
    let h = ra / 15; const hh = Math.floor(h); h = (h - hh) * 60;
    const mm = Math.floor(h); const ss = (h - mm) * 60;
    return `${String(hh).padStart(2, "0")}h${String(mm).padStart(2, "0")}m${ss.toFixed(2).padStart(5, "0")}s`;
  }
  function fmtDec(dec) {
    const sg = dec < 0 ? "-" : "+"; let d = Math.abs(dec); const dd = Math.floor(d);
    d = (d - dd) * 60; const mm = Math.floor(d); const ss = (d - mm) * 60;
    return `${sg}${String(dd).padStart(2, "0")}°${String(mm).padStart(2, "0")}′${ss.toFixed(1).padStart(4, "0")}″`;
  }

  // Proyección gnomónica (TAN) con el norte arriba y el este a la izquierda.
  // Coordenadas de píxel con origen 0 en la esquina inferior izquierda.
  function makeProjection(grid) {
    const a0 = grid.ra * D2R, d0 = grid.dec * D2R;
    const sc = grid.scale_arcsec / 3600 * D2R;
    const x0 = (grid.nx - 1) / 2, y0 = (grid.ny - 1) / 2;
    const sd0 = Math.sin(d0), cd0 = Math.cos(d0);
    return {
      toPix(ra, dec) {
        const a = ra * D2R, d = dec * D2R;
        const cosc = sd0 * Math.sin(d) + cd0 * Math.cos(d) * Math.cos(a - a0);
        const xi = Math.cos(d) * Math.sin(a - a0) / cosc;
        const eta = (cd0 * Math.sin(d) - sd0 * Math.cos(d) * Math.cos(a - a0)) / cosc;
        return { x: x0 - xi / sc, y: y0 + eta / sc };
      },
      toSky(x, y) {
        const xi = -(x - x0) * sc, eta = (y - y0) * sc;
        const rho = Math.hypot(xi, eta);
        if (rho === 0) return { ra: grid.ra, dec: grid.dec };
        const c = Math.atan(rho), sc_ = Math.sin(c), cc = Math.cos(c);
        const dec = Math.asin(cc * sd0 + eta * sc_ * cd0 / rho);
        let ra = a0 + Math.atan2(xi * sc_, rho * cd0 * cc - eta * sd0 * sc_);
        ra = ((ra * R2D) % 360 + 360) % 360;
        return { ra, dec: dec * R2D };
      },
    };
  }

  // Posición propagada con movimiento propio (mas/año; pmra incluye cos δ)
  function propagate(src, fromYear, toYear) {
    const dt = toYear - fromYear;
    const cosd = Math.max(Math.cos(src.dec * D2R), 1e-6);
    return {
      ra: src.ra + (src.pmra || 0) * dt / 3.6e6 / cosd,
      dec: src.dec + (src.pmdec || 0) * dt / 3.6e6,
    };
  }

  // ---------------------------------------------------------- decodificación
  function b64ToBuffer(b64) {
    const bin = atob(b64); const n = bin.length; const buf = new ArrayBuffer(n);
    const u8 = new Uint8Array(buf); for (let i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return buf;
  }
  function decodeVisits(result) {
    return result.visits.map((v, i) => ({
      id: i, mjd: v.mjd, band: v.band, detector: v.detector, wavelength: v.wavelength,
      flag_frac: v.flag_frac, coverage: v.coverage,
      data: v.data instanceof Float32Array ? v.data : new Float32Array(b64ToBuffer(v.data)),
      flags: v.flags instanceof Uint8Array ? v.flags : new Uint8Array(b64ToBuffer(v.flags)),
    }));
  }

  // ---------------------------------------------------------- épocas
  // SPHEREx cubre todo el cielo cada ~6 meses: agrupamos las visitas en
  // "épocas" cuando hay un hueco de más de `gapDays` días.
  function groupEpochs(visits, gapDays = 30) {
    const idx = visits.map((v, i) => i).sort((a, b) => visits[a].mjd - visits[b].mjd);
    const epochs = []; let cur = null, last = -Infinity;
    for (const i of idx) {
      const m = visits[i].mjd;
      if (m - last > gapDays) { cur = { visits: [], start: m, end: m }; epochs.push(cur); }
      cur.visits.push(i); cur.end = m; last = m;
    }
    epochs.forEach((e, k) => {
      e.index = k;
      e.mid = e.visits.reduce((s, i) => s + visits[i].mjd, 0) / e.visits.length;
    });
    return epochs;
  }

  // ---------------------------------------------------------- apilado
  // Mediana píxel a píxel ignorando NaN (y opcionalmente píxeles con banderas).
  function stackMedian(arrays, masks, npix, useMask) {
    const out = new Float32Array(npix);
    const flagOut = new Uint8Array(npix);
    const k = arrays.length;
    if (k === 0) { out.fill(NaN); return { data: out, flags: flagOut }; }
    const vals = new Float64Array(k);
    for (let p = 0; p < npix; p++) {
      let n = 0, nf = 0, ntot = 0;
      for (let j = 0; j < k; j++) {
        const v = arrays[j][p];
        if (v !== v) continue;                      // NaN
        ntot++;
        const flagged = masks[j][p] !== 0;
        if (flagged) nf++;
        if (useMask && flagged) continue;
        vals[n++] = v;
      }
      flagOut[p] = ntot > 0 && nf / ntot > 0.5 ? 1 : 0;
      if (n === 0) { out[p] = NaN; continue; }
      const sub = vals.subarray(0, n).sort();
      out[p] = n % 2 ? sub[(n - 1) >> 1] : 0.5 * (sub[n / 2 - 1] + sub[n / 2]);
    }
    return { data: out, flags: flagOut };
  }

  // ---------------------------------------------------------- estadística
  function samplePercentiles(arrays, ps, maxSamples = 60000, absolute = false) {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const step = Math.max(1, Math.floor(total / maxSamples));
    const vals = [];
    let c = 0;
    for (const a of arrays) for (let i = 0; i < a.length; i++, c++) {
      if (c % step) continue;
      const v = a[i]; if (v === v) vals.push(absolute ? Math.abs(v) : v);
    }
    if (!vals.length) return ps.map(() => 0);
    vals.sort((x, y) => x - y);
    return ps.map((p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p / 100 * (vals.length - 1))))]);
  }

  function stretchFn(kind) {
    const A = 12;
    if (kind === "linear") return (t) => t;
    if (kind === "log") return (t) => Math.log10(1 + 999 * t) / 3;
    return (t) => Math.asinh(A * t) / Math.asinh(A);
  }

  // ---------------------------------------------------------- fotometría
  // Fotometría de apertura en la cuadrícula común. Devuelve µJy.
  function aperturePhot(data, grid, cx, cy, opts = {}) {
    const nx = grid.nx, ny = grid.ny;
    const rAp = opts.rAp ?? Math.max(1.5, 9 / grid.scale_arcsec);
    const rIn = rAp * 2.2, rOut = rAp * 3.6;
    let x = cx, y = cy;
    if (opts.recenter) {                       // centroide ponderado (±2 px)
      const r = rAp + 0.5; let sw = 0, sx = 0, sy = 0;
      const bk = localMedian(data, nx, ny, cx, cy, rIn, rOut);
      for (let j = Math.floor(cy - r); j <= Math.ceil(cy + r); j++)
        for (let i = Math.floor(cx - r); i <= Math.ceil(cx + r); i++) {
          if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
          if ((i - cx) ** 2 + (j - cy) ** 2 > r * r) continue;
          const v = data[j * nx + i] - bk; if (!(v > 0)) continue;
          sw += v; sx += v * i; sy += v * j;
        }
      if (sw > 0) {
        const nxp = sx / sw, nyp = sy / sw;
        if (Math.hypot(nxp - cx, nyp - cy) <= 1.5) { x = nxp; y = nyp; }
      }
    }
    const bkg = localMedian(data, nx, ny, x, y, rIn, rOut, true);
    let sum = 0, n = 0, bad = 0;
    for (let j = Math.floor(y - rAp); j <= Math.ceil(y + rAp); j++)
      for (let i = Math.floor(x - rAp); i <= Math.ceil(x + rAp); i++) {
        if (i < 0 || j < 0 || i >= nx || j >= ny) { bad++; continue; }
        if ((i - x) ** 2 + (j - y) ** 2 > rAp * rAp) continue;
        const v = data[j * nx + i];
        if (v !== v) { bad++; continue; }
        sum += v - bkg.median; n++;
      }
    if (n === 0 || bad > n * 0.3) return null;
    const pixSr = (grid.scale_arcsec / 206264.806) ** 2;
    const toUJy = pixSr * 1e12;                // MJy/sr·sr → µJy
    return {
      flux: sum * toUJy,
      err: Math.sqrt(n) * bkg.std * toUJy * 1.25,
      x, y,
    };
  }

  function localMedian(data, nx, ny, x, y, rIn, rOut, withStd = false) {
    const vals = [];
    for (let j = Math.floor(y - rOut); j <= Math.ceil(y + rOut); j++)
      for (let i = Math.floor(x - rOut); i <= Math.ceil(x + rOut); i++) {
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const d2 = (i - x) ** 2 + (j - y) ** 2;
        if (d2 < rIn * rIn || d2 > rOut * rOut) continue;
        const v = data[j * nx + i]; if (v === v) vals.push(v);
      }
    if (!vals.length) return withStd ? { median: 0, std: 0 } : 0;
    vals.sort((a, b) => a - b);
    const med = vals[vals.length >> 1];
    if (!withStd) return med;
    const dev = vals.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    return { median: med, std: 1.4826 * dev[dev.length >> 1] };
  }

  // ---------------------------------------------------------- cuerpo negro
  // Forma de Fν(λ) para un cuerpo negro de temperatura T (unidades arbitrarias)
  function planckNu(lamUm, T) {
    const h = 6.62607015e-34, c = 2.99792458e8, k = 1.380649e-23;
    const nu = c / (lamUm * 1e-6);
    const x = h * nu / (k * T);
    if (x > 700) return 0;
    return nu ** 3 / Math.expm1(x);
  }
  function fitScale(lams, fluxes, model) {
    let sxy = 0, sxx = 0;
    for (let i = 0; i < lams.length; i++) {
      const m = model(lams[i]); if (!isFinite(m) || !isFinite(fluxes[i])) continue;
      sxy += m * fluxes[i]; sxx += m * m;
    }
    return sxx > 0 ? sxy / sxx : 0;
  }

  return {
    DETECTORS, PRESETS, FEATURES, mjdToDate, mjdToISO, mjdToYear, parseCoords, fmtRA, fmtDec,
    makeProjection, propagate, decodeVisits, groupEpochs, stackMedian, samplePercentiles,
    stretchFn, aperturePhot, planckNu, fitScale,
  };
})();
