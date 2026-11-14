/* =========================================================================
   app.js — interfaz de CazaMundos SPHEREx
   ========================================================================= */
"use strict";

const $ = (id) => document.getElementById(id);

const S = {
  live: false, forceDemo: false,
  target: null, grid: null, proj: null, visits: [], epochs: [], source: "", totalFound: 0,
  frames: [], cur: 0, playing: false, timer: null, fps: 2,
  mode: "normal", group: "epoch", detector: "all", diffRef: "median", preset: "detectors",
  stretch: "asinh", contrast: 99.5, invert: false, maskFlags: false,
  layers: { gaia: false, catwise: false, asteroids: false, flags: false, reticle: true },
  catalogs: {}, catPending: {}, asteroids: new Map(), astPending: new Set(),
  demo: null, sel: null, scaling: null, stackCache: new Map(), aladin: null, alOverlay: null,
  loading: false, lastFov: 6,
};

// ------------------------------------------------------------------ util
function toast(msg, ms = 3500) {
  const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
function setProgress(show, text = "", frac = null) {
  $("progress").classList.toggle("hidden", !show);
  $("progressText").textContent = text;
  $("progressFill").style.width = frac == null ? "15%" : `${Math.round(frac * 100)}%`;
}
async function api(path, opts = {}, timeoutMs = 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, { ...opts, signal: ctl.signal });
    if (!r.ok) {
      let msg = `${r.status}`;
      try { const j = await r.json(); msg = j.detail || msg; } catch (_) { /* nada */ }
      throw new Error(msg);
    }
    return r;
  } finally { clearTimeout(t); }
}
const isLive = () => S.live && !S.forceDemo;

async function checkBackend() {
  try {
    if (location.protocol === "file:") throw new Error("file");
    const r = await api("/api/health", {}, 2500);
    const j = await r.json(); S.live = !!j.ok;
  } catch (_) { S.live = false; }
  updateStatusChip();
}
function updateStatusChip() {
  const c = $("statusChip");
  if (isLive()) { c.textContent = "● IRSA en vivo"; c.className = "chip live"; c.title = "Datos reales de SPHEREx desde NASA/IPAC IRSA"; }
  else { c.textContent = "● DEMO · datos simulados"; c.className = "chip demo";
         c.title = S.live ? "Modo demo forzado" : "No se encontró el servidor Python: se usan datos simulados"; }
}

// ------------------------------------------------------------------ carga
async function load(q, fov, displayName) {
  if (S.loading) return;
  q = String(q || "").trim(); if (!q) return;
  S.loading = true; stop();
  fov = +fov || +$("fov").value; S.lastFov = fov; $("fov").value = String(fov);
  try {
    setProgress(true, "Buscando el objeto…");
    let target;
    if (isLive()) target = await (await api(`/api/resolve?q=${encodeURIComponent(q)}`, {}, 30000)).json();
    else target = Demo.resolve(q);
    target.query = q;
    if (displayName) target.name = displayName;
    S.target = target;

    let result;
    if (isLive()) {
      const r = await api("/api/cube", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ra: target.ra, dec: target.dec, fov_arcmin: fov, max_images: 240 }),
      });
      const { job_id } = await r.json();
      result = await pollJob(job_id);
      S.demo = null;
    } else {
      setProgress(true, "Generando datos simulados…", 0.5);
      await new Promise((res) => setTimeout(res, 30));
      S.demo = Demo.generate(target.ra, target.dec, fov);
      result = S.demo.result;
    }
    if (!result.visits || !result.visits.length) {
      setProgress(false);
      toast("SPHEREx todavía no tiene imágenes publicadas de esta zona. Prueba otra posición o vuelve pronto: el archivo se actualiza cada semana.", 7000);
      showTarget(); return;
    }
    setData(result);
    setProgress(false);
  } catch (err) {
    setProgress(false);
    toast(`Error: ${err.message}`, 6000);
    console.error(err);
  } finally { S.loading = false; }
}

async function pollJob(id) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const j = await (await api(`/api/job/${id}`, {}, 20000)).json();
    if (j.status === "error") throw new Error(j.error || "falló la descarga");
    const frac = j.total ? j.progress / j.total : null;
    setProgress(true, j.total ? `${j.message} (${j.progress}/${j.total})` : j.message, frac);
    if (j.status === "done") return j.result;
  }
}

function setData(result) {
  S.grid = result.grid; S.proj = Astro.makeProjection(S.grid);
  S.visits = Astro.decodeVisits(result);
  S.epochs = Astro.groupEpochs(S.visits);
  S.source = result.source; S.totalFound = result.total_found;
  S.stackCache.clear(); S.asteroids.clear(); S.astPending.clear();
  S.catalogs = S.demo ? { ...S.demo.catalogs } : {};
  S.sel = null; S.cur = 0;
  $("emptyMsg").classList.add("hidden");
  $("frameBadge").classList.remove("hidden");
  showTarget();
  computeFrames();
  clearPlots();
  updateURL();
  updateAladin();
  for (const k of ["gaia", "catwise"]) if (S.layers[k]) ensureCatalog(k);
  if (S.frames.length > 1) play();
}

function showTarget() {
  const t = S.target; if (!t) return;
  $("targetName").textContent = t.name || t.query;
  $("targetCoords").textContent = `${Astro.fmtRA(t.ra)} ${Astro.fmtDec(t.dec)} · RA ${t.ra.toFixed(5)}° Dec ${t.dec.toFixed(5)}°`;
  document.title = `${t.name || t.query} · CazaMundos SPHEREx`;
}

// ------------------------------------------------------------------ cuadros
function stackOf(indices, key) {
  const k = `${key}|${S.maskFlags ? 1 : 0}`;
  if (S.stackCache.has(k)) return S.stackCache.get(k);
  const npix = S.grid.nx * S.grid.ny;
  const st = Astro.stackMedian(indices.map((i) => S.visits[i].data), indices.map((i) => S.visits[i].flags), npix, S.maskFlags);
  S.stackCache.set(k, st);
  return st;
}
const detOk = (v) => S.detector === "all" || v.detector === +S.detector;

function computeFrames() {
  if (!S.grid) return;
  const V = S.visits, frames = [];
  const nEp = S.epochs.length;
  if (S.mode === "color") {
    const P = Astro.PRESETS[S.preset];
    for (const e of S.epochs) {
      const chans = [P.r, P.g, P.b].map((rg, c) => {
        const idx = e.visits.filter((i) => V[i].wavelength >= rg[0] && V[i].wavelength <= rg[1]);
        return { idx, st: idx.length ? stackOf(idx, `E${e.index}|L${rg[0]}-${rg[1]}`) : null, c };
      });
      if (chans.every((c) => !c.st)) continue;
      const nv = chans.reduce((s, c) => s + c.idx.length, 0);
      frames.push({
        kind: "rgb", rgb: chans.map((c) => (c.st ? c.st.data : null)),
        flags: (chans.find((c) => c.st) || {}).st.flags,
        mjd: e.mid, start: e.start, end: e.end, nvis: nv,
        label: `Época ${e.index + 1}/${nEp}`, sub: `${Astro.mjdToISO(e.start)} → ${Astro.mjdToISO(e.end)} · ${P.name}`,
      });
    }
  } else if (S.group === "epoch") {
    for (const e of S.epochs) {
      const idx = e.visits.filter((i) => detOk(V[i]));
      if (!idx.length) continue;
      const st = stackOf(idx, `E${e.index}|D${S.detector}`);
      const lams = idx.map((i) => V[i].wavelength);
      frames.push({
        kind: "gray", data: st.data, flags: st.flags, nvis: idx.length,
        mjd: idx.reduce((s, i) => s + V[i].mjd, 0) / idx.length, start: e.start, end: e.end,
        label: `Época ${e.index + 1}/${nEp}`,
        sub: `${Astro.mjdToISO(e.start)} → ${Astro.mjdToISO(e.end)} · ${idx.length} imágenes · ${Math.min(...lams).toFixed(2)}–${Math.max(...lams).toFixed(2)} µm`,
      });
    }
  } else {
    const idx = V.map((v, i) => i).filter((i) => detOk(V[i]));
    idx.forEach((i, k) => {
      const v = V[i];
      frames.push({
        kind: "gray", data: v.data, flags: v.flags, nvis: 1, mjd: v.mjd, start: v.mjd, end: v.mjd,
        label: `Visita ${k + 1}/${idx.length}`,
        sub: `${Astro.mjdToISO(v.mjd)} · D${v.detector} · ${v.wavelength.toFixed(3)} µm · banderas ${(v.flag_frac * 100).toFixed(1)} %`,
      });
    });
  }

  if (S.mode === "diff" && frames.length > 1) {
    const npix = S.grid.nx * S.grid.ny;
    let template = null;
    if (S.diffRef === "median") {
      template = Astro.stackMedian(frames.map((f) => f.data), frames.map((f) => f.flags), npix, false).data;
    }
    const diffs = frames.map((f, k) => {
      const ref = S.diffRef === "median" ? template
        : S.diffRef === "first" ? frames[0].data
        : frames[k === 0 ? 1 : k - 1].data;
      const out = new Float32Array(npix);
      for (let p = 0; p < npix; p++) out[p] = f.data[p] - ref[p];
      return out;
    });
    frames.forEach((f, k) => { f.kind = "diff"; f.data = diffs[k]; });
  }

  S.frames = frames;
  if (S.cur >= frames.length) S.cur = 0;
  computeScaling();
  buildTimeline();
  render();
  updateMeta();
}

function computeScaling() {
  const F = S.frames; if (!F.length) { S.scaling = null; return; }
  const hiP = S.contrast;
  if (F[0].kind === "rgb") {
    S.scaling = [0, 1, 2].map((c) => {
      const arrs = F.map((f) => f.rgb[c]).filter(Boolean);
      const [lo, hi] = Astro.samplePercentiles(arrs, [25, hiP]);
      return { lo, hi: hi > lo ? hi : lo + 1e-6 };
    });
  } else if (F[0].kind === "diff") {
    const [s] = Astro.samplePercentiles(F.map((f) => f.data), [hiP], 60000, true);
    S.scaling = { s: s > 0 ? s : 1e-6 };
  } else {
    const [lo, hi] = Astro.samplePercentiles(F.map((f) => f.data), [5, hiP]);
    S.scaling = { lo, hi: hi > lo ? hi : lo + 1e-6 };
  }
}

// ------------------------------------------------------------------ dibujo
const canvas = $("sky"), ctx = canvas.getContext("2d");
const off = document.createElement("canvas"), offCtx = off.getContext("2d");

function render(target = ctx, W = canvas.width) {
  const f = S.frames[S.cur];
  if (!f || !S.grid) { target.fillStyle = "#000"; target.fillRect(0, 0, W, W); return; }
  const { nx, ny } = S.grid;
  if (off.width !== nx || off.height !== ny) { off.width = nx; off.height = ny; }
  const img = offCtx.createImageData(nx, ny); const px = img.data;
  const sfn = Astro.stretchFn(S.stretch);
  const sc = S.scaling, inv = S.invert, showFlags = S.layers.flags;
  const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
  for (let y = 0; y < ny; y++) {
    const row = ny - 1 - y;                      // norte arriba
    for (let x = 0; x < nx; x++) {
      const p = y * nx + x, o = (row * nx + x) * 4;
      let r, g, b;
      if (f.kind === "rgb") {
        const ch = [0, 1, 2].map((c) => {
          const a = f.rgb[c]; if (!a) return 0;
          const v = a[p]; if (v !== v) return 0;
          return 255 * sfn(clamp01((v - sc[c].lo) / (sc[c].hi - sc[c].lo)));
        });
        [r, g, b] = ch;
      } else {
        const v = f.data[p];
        if (v !== v) { r = 18; g = 22; b = 38; }
        else {
          let t;
          if (f.kind === "diff") {
            const u = Math.max(-1, Math.min(1, v / sc.s));
            t = 0.5 + 0.5 * Math.sign(u) * sfn(Math.abs(u));
          } else t = sfn(clamp01((v - sc.lo) / (sc.hi - sc.lo)));
          if (inv) t = 1 - t;
          r = g = b = 255 * t;
        }
      }
      if (showFlags && f.flags && f.flags[p]) { r = r * 0.45 + 255 * 0.55; g = g * 0.45 + 93 * 0.55; b = b * 0.45 + 115 * 0.55; }
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
  }
  offCtx.putImageData(img, 0, 0);
  target.imageSmoothingEnabled = false;
  target.drawImage(off, 0, 0, W, W);
  drawOverlays(target, W, f);
  if (target === ctx) {
    $("frameBadge").innerHTML = `<b>${f.label}</b> · ${modeName()}<br>${f.sub}`;
    [...$("timeline").children].forEach((el, k) => el.classList.toggle("on", k === S.cur));
  } else {
    target.fillStyle = "#000000b0"; target.fillRect(0, 0, W, 26);
    target.fillStyle = "#fff"; target.font = `${Math.round(W / 34)}px system-ui`;
    target.fillText(`${(S.target && S.target.name) || ""} · ${f.label} · ${Astro.mjdToISO(f.mjd)} · SPHEREx`, 8, 18);
  }
}
const modeName = () => ({ normal: "Normal", diff: "Resta", color: "Color" }[S.mode]);

function drawOverlays(c, W, f) {
  const { nx, ny } = S.grid; const k = W / nx;
  const toCanvas = (p) => ({ X: (p.x + 0.5) * k, Y: (ny - 1 - p.y + 0.5) * k });
  const year = Astro.mjdToYear(f.mjd);
  c.lineWidth = Math.max(1.5, W / 400);

  if (S.layers.reticle) {
    const cc = toCanvas({ x: (nx - 1) / 2, y: (ny - 1) / 2 });
    c.strokeStyle = "#9fffb0cc"; const g = W * 0.025, L = W * 0.06;
    c.beginPath();
    c.moveTo(cc.X - g - L, cc.Y); c.lineTo(cc.X - g, cc.Y); c.moveTo(cc.X + g, cc.Y); c.lineTo(cc.X + g + L, cc.Y);
    c.moveTo(cc.X, cc.Y - g - L); c.lineTo(cc.X, cc.Y - g); c.moveTo(cc.X, cc.Y + g); c.lineTo(cc.X, cc.Y + g + L);
    c.stroke();
    // brújula
    c.fillStyle = "#9fffb0"; c.font = `${Math.round(W / 45)}px system-ui`;
    c.fillText("N ↑", W - 46, 22); c.fillText("← E", W - 52, 40);
    // barra de escala de 1′
    const len = 60 / S.grid.scale_arcsec * k;
    if (len < W * 0.6) {
      c.strokeStyle = "#ffffffcc"; c.beginPath(); c.moveTo(12, W - 14); c.lineTo(12 + len, W - 14); c.stroke();
      c.fillStyle = "#fff"; c.fillText("1′", 12 + len / 2 - 5, W - 20);
    }
  }

  const drawCat = (kind, color, shape) => {
    const cat = S.catalogs[kind]; if (!cat) return;
    c.strokeStyle = color; c.fillStyle = color;
    const R = Math.max(6, k * 1.4);
    for (const s of cat.sources) {
      const pos = Astro.propagate(s, cat.epoch, year);
      const p = S.proj.toPix(pos.ra, pos.dec);
      if (p.x < -2 || p.y < -2 || p.x > nx + 1 || p.y > ny + 1) continue;
      const { X, Y } = toCanvas(p);
      c.beginPath();
      if (shape === "circle") c.arc(X, Y, R, 0, 2 * Math.PI); else c.rect(X - R, Y - R, 2 * R, 2 * R);
      c.stroke();
      const pm = Math.hypot(s.pmra || 0, s.pmdec || 0);
      if (pm > 80) {          // flecha: hacia dónde se moverá en 10 años
        const fut = Astro.propagate(s, cat.epoch, year + 10);
        const q = toCanvas(S.proj.toPix(fut.ra, fut.dec));
        let dx = q.X - X, dy = q.Y - Y; const L = Math.hypot(dx, dy) || 1;
        const minL = R * 2.5; if (L < minL) { dx *= minL / L; dy *= minL / L; }
        const ex = X + dx, ey = Y + dy;
        c.beginPath(); c.moveTo(X, Y); c.lineTo(ex, ey); c.stroke();
        const a = Math.atan2(dy, dx);
        c.beginPath(); c.moveTo(ex, ey);
        c.lineTo(ex - 8 * Math.cos(a - 0.4), ey - 8 * Math.sin(a - 0.4));
        c.lineTo(ex - 8 * Math.cos(a + 0.4), ey - 8 * Math.sin(a + 0.4)); c.closePath(); c.fill();
        c.font = `${Math.round(W / 50)}px system-ui`;
        c.fillText(`${(pm / 1000).toFixed(pm > 1000 ? 1 : 2)}″/año`, X + R + 3, Y - R);
      }
    }
  };
  if (S.layers.gaia) drawCat("gaia", "#4fd1ffd0", "circle");
  if (S.layers.catwise) drawCat("catwise", "#ff9f43d0", "square");

  if (S.layers.asteroids) {
    const list = getAsteroids(f);
    c.strokeStyle = "#ffe066"; c.fillStyle = "#ffe066"; c.font = `${Math.round(W / 48)}px system-ui`;
    for (const a of list || []) {
      const { X, Y } = toCanvas(S.proj.toPix(a.ra, a.dec)); const R = Math.max(7, k * 1.6);
      c.beginPath(); c.moveTo(X, Y - R); c.lineTo(X + R, Y); c.lineTo(X, Y + R); c.lineTo(X - R, Y); c.closePath(); c.stroke();
      c.fillText(a.name, X + R + 3, Y + 4);
    }
  }

  if (S.sel) {
    const { X, Y } = toCanvas(S.sel);
    const rAp = Math.max(1.5, 9 / S.grid.scale_arcsec) * k;
    c.strokeStyle = "#3ddc97"; c.setLineDash([5, 4]);
    c.beginPath(); c.arc(X, Y, rAp, 0, 2 * Math.PI); c.stroke(); c.setLineDash([]);
  }
}

// ------------------------------------------------------------------ asteroides / catálogos
function astKey(f) { return S.group === "visit" && S.mode !== "color" ? Math.round(f.mjd * 2) / 2 : Math.round(f.mjd * 10) / 10; }
function getAsteroids(f) {
  if (S.demo) return S.demo.asteroidAt(f.mjd);
  if (!isLive()) return [];
  const key = astKey(f);
  if (S.asteroids.has(key)) return S.asteroids.get(key);
  if (!S.astPending.has(key)) {
    S.astPending.add(key);
    const rad = S.grid.nx * S.grid.scale_arcsec / 60 * 0.75;
    api(`/api/asteroids?ra=${S.grid.ra}&dec=${S.grid.dec}&mjd=${key}&radius_arcmin=${rad.toFixed(2)}`, {}, 60000)
      .then((r) => r.json()).then((j) => { S.asteroids.set(key, j.objects); render(); })
      .catch((e) => { S.asteroids.set(key, []); toast(`SkyBoT: ${e.message}`); })
      .finally(() => S.astPending.delete(key));
  }
  return [];
}
async function ensureCatalog(kind) {
  if (!S.grid || S.catalogs[kind] || S.catPending[kind]) return;
  if (!isLive()) return;
  S.catPending[kind] = true;
  try {
    const rad = S.grid.nx * S.grid.scale_arcsec / 60 * 0.75;
    const j = await (await api(`/api/catalog/${kind}?ra=${S.grid.ra}&dec=${S.grid.dec}&radius_arcmin=${rad.toFixed(2)}`, {}, 60000)).json();
    S.catalogs[kind] = { epoch: j.epoch, sources: j.sources };
    toast(`${kind === "gaia" ? "Gaia DR3" : "CatWISE2020"}: ${j.sources.length} fuentes`);
    render();
  } catch (e) { toast(`No se pudo cargar el catálogo: ${e.message}`); }
  finally { S.catPending[kind] = false; }
}

// ------------------------------------------------------------------ reproducción
function play() {
  if (S.frames.length < 2) return;
  S.playing = true; $("playBtn").textContent = "⏸";
  clearInterval(S.timer);
  S.timer = setInterval(() => step(1), 1000 / S.fps);
}
function stop() { S.playing = false; $("playBtn").textContent = "▶"; clearInterval(S.timer); }
function step(d) {
  if (!S.frames.length) return;
  S.cur = (S.cur + d + S.frames.length) % S.frames.length;
  render(); updateMeta();
}
function buildTimeline() {
  const tl = $("timeline"); tl.innerHTML = "";
  tl.classList.toggle("dense", S.frames.length > 40);
  S.frames.forEach((f, k) => {
    const b = document.createElement("button"); b.className = "tick";
    b.title = `${f.label} · ${Astro.mjdToISO(f.mjd)}`;
    b.onclick = () => { stop(); S.cur = k; render(); updateMeta(); };
    tl.appendChild(b);
  });
}
function updateMeta() {
  const f = S.frames[S.cur]; if (!f) { $("frameMeta").textContent = ""; return; }
  let ff = 0; if (f.flags) { for (let i = 0; i < f.flags.length; i++) ff += f.flags[i]; ff /= f.flags.length; }
  $("frameMeta").textContent =
    `Fuente: ${S.source} · ${S.visits.length} imágenes usadas (${S.totalFound} encontradas) · ` +
    `${S.epochs.length} épocas · píxel ${S.grid.scale_arcsec.toFixed(2)}″ · campo ${(S.grid.nx * S.grid.scale_arcsec / 60).toFixed(1)}′ · ` +
    `píxeles con banderas en este cuadro: ${(ff * 100).toFixed(1)} %`;
}

// ------------------------------------------------------------------ selección → espectro y curva de luz
function canvasToPix(ev) {
  const rect = canvas.getBoundingClientRect();
  const X = (ev.clientX - rect.left) / rect.width * S.grid.nx;
  const Y = (ev.clientY - rect.top) / rect.height * S.grid.ny;
  return { x: X - 0.5, y: S.grid.ny - Y - 0.5 };
}
canvas.addEventListener("click", (ev) => {
  if (!S.grid) return;
  const p = canvasToPix(ev); const s = S.proj.toSky(p.x, p.y);
  S.sel = { x: p.x, y: p.y, ra: s.ra, dec: s.dec };
  render(); analyzeSelection(); updateAladin();
});
canvas.addEventListener("mousemove", (ev) => {
  if (!S.grid) return;
  const p = canvasToPix(ev); const s = S.proj.toSky(p.x, p.y);
  const f = S.frames[S.cur]; const ix = Math.round(p.x), iy = Math.round(p.y);
  let val = "";
  if (f && f.kind !== "rgb" && ix >= 0 && iy >= 0 && ix < S.grid.nx && iy < S.grid.ny) {
    const v = f.data[iy * S.grid.nx + ix]; if (v === v) val = ` · ${v.toExponential(2)} MJy/sr`;
  }
  const h = $("hoverInfo"); h.classList.remove("hidden");
  h.textContent = `${s.ra.toFixed(5)}°, ${s.dec.toFixed(5)}°${val}`;
});
canvas.addEventListener("mouseleave", () => $("hoverInfo").classList.add("hidden"));

function analyzeSelection() {
  if (!S.sel) return;
  const recenter = $("recenter").checked;
  const pts = [];
  S.visits.forEach((v) => {
    const r = Astro.aperturePhot(v.data, S.grid, S.sel.x, S.sel.y, { recenter });
    if (!r) return;
    const ep = S.epochs.findIndex((e) => e.visits.includes(v.id));
    pts.push({ lam: v.wavelength, flux: r.flux, err: r.err, mjd: v.mjd, det: v.detector, ep });
  });
  S.points = pts;
  $("selInfo").textContent = `RA ${S.sel.ra.toFixed(5)}°, Dec ${S.sel.dec.toFixed(5)}° · ${pts.length} medidas`;
  drawSpectrum(); drawLightCurve();
}

const PLOT_LAYOUT = () => ({
  paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
  font: { color: "#cfd8ee", size: 11 }, margin: { l: 55, r: 12, t: 10, b: 40 },
  legend: { orientation: "h", y: -0.25, font: { size: 10 } },
  xaxis: { gridcolor: "#22304f", zerolinecolor: "#22304f" },
  yaxis: { gridcolor: "#22304f", zerolinecolor: "#22304f" },
});
const EPOCH_COLORS = ["#4fd1ff", "#ff9f43", "#3ddc97", "#c792ea", "#ff5d73", "#ffe066", "#8ab4ff"];
const DET_COLORS = { 1: "#8ab4ff", 2: "#4fd1ff", 3: "#3ddc97", 4: "#ffe066", 5: "#ff9f43", 6: "#ff5d73" };

function clearPlots() {
  S.points = null;
  $("selInfo").textContent = "Haz clic en una fuente de la imagen";
  if (!window.Plotly) {
    for (const id of ["specPlot", "lcPlot"]) $(id).innerHTML = '<p class="muted" style="padding:12px">Los gráficos necesitan internet (Plotly no se pudo cargar).</p>';
    return;
  }
  const msg = (t) => ({ ...PLOT_LAYOUT(), xaxis: { visible: false }, yaxis: { visible: false },
    annotations: [{ text: t, showarrow: false, font: { color: "#8a9abb", size: 13 } }] });
  Plotly.react("specPlot", [], msg("Haz clic en un objeto para ver su espectro (102 bandas)"), { displayModeBar: false, responsive: true });
  Plotly.react("lcPlot", [], msg("…y aquí su brillo a lo largo del tiempo"), { displayModeBar: false, responsive: true });
}

function drawSpectrum() {
  if (!window.Plotly || !S.points) return;
  const pts = S.points, traces = [];
  const byEp = {};
  pts.forEach((p) => (byEp[p.ep] = byEp[p.ep] || []).push(p));
  Object.keys(byEp).sort((a, b) => a - b).forEach((e) => {
    const arr = byEp[e].sort((a, b) => a.lam - b.lam);
    const ep = S.epochs[e];
    traces.push({
      x: arr.map((p) => p.lam), y: arr.map((p) => p.flux),
      error_y: { type: "data", array: arr.map((p) => p.err), visible: true, thickness: 1, width: 0, color: EPOCH_COLORS[e % 7] + "88" },
      mode: "markers", type: "scatter", marker: { size: 5, color: EPOCH_COLORS[e % 7] },
      name: `Época ${+e + 1} (${ep ? Astro.mjdToISO(ep.start).slice(0, 7) : ""})`,
    });
  });
  // espectro promedio en bins de resolución R≈40
  const sorted = [...pts].sort((a, b) => a.lam - b.lam); const bx = [], by = [];
  for (let i = 0; i < sorted.length;) {
    const l0 = sorted[i].lam, w = l0 / 40; const vals = [];
    let j = i; while (j < sorted.length && sorted[j].lam < l0 + w) vals.push(sorted[j++].flux);
    vals.sort((a, b) => a - b);
    bx.push(sorted[Math.floor((i + j - 1) / 2)].lam); by.push(vals[vals.length >> 1]); i = j;
  }
  traces.push({ x: bx, y: by, mode: "lines", type: "scatter", line: { color: "#ffffffaa", width: 2 }, name: "Promedio" });

  if ($("bbToggle").checked) {
    const T = +$("bbT").value;
    const scale = Astro.fitScale(bx, by, (l) => Astro.planckNu(l, T));
    const xs = []; for (let l = 0.75; l <= 5.0; l += 0.02) xs.push(l);
    traces.push({ x: xs, y: xs.map((l) => scale * Astro.planckNu(l, T)), mode: "lines", type: "scatter",
                  line: { color: "#ff9f43", dash: "dash", width: 1.5 }, name: `Cuerpo negro ${T} K` });
  }
  const lay = PLOT_LAYOUT();
  lay.xaxis = { ...lay.xaxis, title: { text: "Longitud de onda (µm)" }, range: [0.7, 5.05] };
  lay.yaxis = { ...lay.yaxis, title: { text: "Flujo (µJy)" } };
  lay.shapes = Astro.FEATURES.map((f) => ({ type: "rect", xref: "x", yref: "paper", x0: f.lo, x1: f.hi, y0: 0, y1: 1,
                                             fillcolor: "#c792ea", opacity: 0.12, line: { width: 0 } }));
  lay.annotations = Astro.FEATURES.map((f) => ({ x: (f.lo + f.hi) / 2, y: 1, xref: "x", yref: "paper", yanchor: "bottom",
                                                  text: f.name, showarrow: false, font: { size: 9, color: "#c792ea" } }));
  lay.margin.t = 18;
  Plotly.react("specPlot", traces, lay, { displayModeBar: false, responsive: true });
}

function drawLightCurve() {
  if (!window.Plotly || !S.points) return;
  const norm = $("normLc").checked; const traces = [];
  for (let d = 1; d <= 6; d++) {
    const arr = S.points.filter((p) => p.det === d).sort((a, b) => a.mjd - b.mjd);
    if (!arr.length) continue;
    const med = [...arr.map((p) => p.flux)].sort((a, b) => a - b)[arr.length >> 1] || 1;
    const k = norm && med !== 0 ? 1 / med : 1;
    traces.push({
      x: arr.map((p) => Astro.mjdToDate(p.mjd)), y: arr.map((p) => p.flux * k),
      mode: "markers", type: "scatter", marker: { size: 5, color: DET_COLORS[d] }, name: `D${d}`,
      text: arr.map((p) => `${p.lam.toFixed(2)} µm`), hovertemplate: "%{x|%Y-%m-%d}<br>%{y:.3g}<br>%{text}<extra>D" + d + "</extra>",
    });
  }
  const lay = PLOT_LAYOUT();
  lay.xaxis = { ...lay.xaxis, type: "date" };
  lay.yaxis = { ...lay.yaxis, title: { text: norm ? "Flujo / mediana" : "Flujo (µJy)" } };
  Plotly.react("lcPlot", traces, lay, { displayModeBar: false, responsive: true });
}

// ------------------------------------------------------------------ Aladin Lite
function initAladin() {
  if (!window.A) { $("aladin").innerHTML = '<p class="muted" style="padding:12px">Aladin Lite no está disponible (¿sin internet?).</p>'; return; }
  A.init.then(() => {
    S.aladin = A.aladin("#aladin", {
      survey: $("survey").value, fov: 0.2, target: "0 0", showReticle: false,
      showLayersControl: false, showGotoControl: false, showFrame: false,
      showFullscreenControl: true, showCooGridControl: false, showSimbadPointerControl: true,
    });
    S.alOverlay = A.graphicOverlay({ color: "#4fd1ff", lineWidth: 2 });
    S.aladin.addOverlay(S.alOverlay);
    updateAladin();
  }).catch((e) => console.warn("Aladin", e));
}
function updateAladin() {
  if (!S.aladin || !S.grid) return;
  try {
    S.aladin.gotoRaDec(S.grid.ra, S.grid.dec);
    S.aladin.setFoV(S.grid.nx * S.grid.scale_arcsec / 3600 * 1.6);
    S.alOverlay.removeAll();
    const { nx, ny } = S.grid;
    const corners = [[-0.5, -0.5], [nx - 0.5, -0.5], [nx - 0.5, ny - 0.5], [-0.5, ny - 0.5]]
      .map(([x, y]) => { const s = S.proj.toSky(x, y); return [s.ra, s.dec]; });
    S.alOverlay.add(A.polygon(corners));
    if (S.sel) S.alOverlay.add(A.circle(S.sel.ra, S.sel.dec, 12 / 3600, { color: "#3ddc97" }));
  } catch (e) { console.warn("Aladin", e); }
}

// ------------------------------------------------------------------ URL, enlaces e incrustación
function currentParams(extra = {}) {
  const p = new URLSearchParams();
  if (S.target) {
    p.set("ra", S.target.ra.toFixed(6)); p.set("dec", S.target.dec.toFixed(6));
    if (S.target.name) p.set("name", S.target.name);
  }
  p.set("fov", String(S.lastFov));
  if (S.mode !== "normal") p.set("mode", S.mode);
  if (S.group !== "epoch") p.set("group", S.group);
  if (S.detector !== "all") p.set("det", S.detector);
  if (S.mode === "color") p.set("preset", S.preset);
  if (S.forceDemo) p.set("demo", "1");
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p;
}
function shareURL(extra) { return `${location.origin}${location.pathname}?${currentParams(extra)}`; }
function updateURL() { if (S.target) history.replaceState(null, "", `?${currentParams()}`); }
async function copy(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch (_) { window.prompt("Copia este texto:", text); }
}

// ------------------------------------------------------------------ exportar animación
async function exportAnimation() {
  if (!S.frames.length) return toast("Primero carga un objeto.");
  stop();
  const W = 480; const tmp = document.createElement("canvas"); tmp.width = tmp.height = W;
  const tctx = tmp.getContext("2d"); const saved = S.cur;
  const urls = [];
  for (let k = 0; k < S.frames.length && k < 300; k++) { S.cur = k; render(tctx, W); urls.push(tmp.toDataURL("image/png")); }
  S.cur = saved; render();
  if (isLive()) {
    try {
      setProgress(true, "Creando GIF…", 0.6);
      const r = await api("/api/gif", { method: "POST", headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ frames: urls, fps: S.fps }) }, 120000);
      download(await r.blob(), `spherex_${slug()}.gif`); setProgress(false); return;
    } catch (e) { setProgress(false); toast(`GIF: ${e.message}. Probando como video…`); }
  }
  // sin servidor: video WebM en el navegador
  if (!tmp.captureStream || !window.MediaRecorder) return toast("Tu navegador no permite grabar video.");
  const stream = tmp.captureStream(30); const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
  const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = () => download(new Blob(chunks, { type: "video/webm" }), `spherex_${slug()}.webm`);
  rec.start(); toast("Grabando video…");
  const imgs = await Promise.all(urls.map((u) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = u; })));
  for (let loop = 0; loop < 2; loop++)
    for (const im of imgs) { tctx.drawImage(im, 0, 0); await new Promise((r) => setTimeout(r, 1000 / S.fps)); }
  rec.stop();
}
function download(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
const slug = () => ((S.target && S.target.name) || "campo").replace(/[^\w]+/g, "_").slice(0, 40);

// ------------------------------------------------------------------ candidatos
const LS_KEY = "cazamundos_candidatos";
async function listCandidates() {
  let items = [];
  if (isLive()) { try { items = await (await api("/api/candidates")).json(); } catch (_) { items = []; } }
  else { try { items = JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch (_) { items = []; } }
  const tb = $("candBody"); tb.innerHTML = "";
  if (!items.length) { tb.innerHTML = '<tr><td colspan="6" class="muted">Aún no hay candidatos.</td></tr>'; return; }
  for (const c of items.slice().reverse()) {
    const tr = document.createElement("tr");
    const cells = [c.created || "", (+c.ra).toFixed(5), (+c.dec).toFixed(5), c.note || "", c.author || ""];
    cells.forEach((t, i) => { const td = document.createElement("td"); td.textContent = t; if (i === 1 || i === 2) td.className = "mono"; tr.appendChild(td); });
    const td = document.createElement("td"); const b = document.createElement("button");
    b.className = "btn"; b.textContent = "Ver"; b.onclick = () => load(`${(+c.ra).toFixed(6)} ${(+c.dec).toFixed(6)}`, S.lastFov, `Candidato: ${c.note.slice(0, 30)}`);
    td.appendChild(b); tr.appendChild(td); $("candBody").appendChild(tr);
  }
}
async function saveCandidate(note, author) {
  const f = S.frames[S.cur];
  const item = { ra: S.sel.ra, dec: S.sel.dec, mjd: f ? f.mjd : null, field_ra: S.grid.ra, field_dec: S.grid.dec, note, author };
  if (isLive()) await api("/api/candidates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item) });
  else {
    const items = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    items.push({ ...item, id: Date.now(), created: new Date().toISOString().slice(0, 16).replace("T", " ") });
    localStorage.setItem(LS_KEY, JSON.stringify(items));
  }
  toast("¡Candidato guardado! Gracias por contribuir.");
  listCandidates();
}

// ------------------------------------------------------------------ modo guiado
const TUTORIAL = [
  { t: "Bienvenido, cazador de mundos", x: "SPHEREx fotografía todo el cielo cada 6 meses en 102 colores infrarrojos. Comparando imágenes de distintas fechas podemos descubrir objetos que se mueven: asteroides, cometas y enanas marrones. Empecemos con WISE 0855, la enana marrón más fría conocida.",
    a: "Cargar WISE 0855", fn: () => document.querySelector('.ex[data-label="WISE 0855"]').click() },
  { t: "Mira el parpadeo", x: "Cada cuadro es una pasada de SPHEREx (una «época»). Las estrellas lejanas quedan quietas; un objeto cercano salta de posición entre cuadros. Ajusta la velocidad si quieres.",
    a: "▶ Reproducir", fn: () => play() },
  { t: "Activa la resta", x: "En modo Resta se quita el cielo promedio: todo lo que no cambia desaparece. Un objeto en movimiento aparece como una mancha blanca (dónde está ahora) y una negra (dónde estaba).",
    a: "Activar Resta", fn: () => setMode("diff") },
  { t: "Haz clic sobre el objeto", x: "Al hacer clic se mide su brillo en las 102 bandas. Las enanas marrones muestran una gran caída en 3.3 µm por el metano, algo que solo un telescopio como SPHEREx puede ver de forma tan completa.",
    a: "Volver a Normal", fn: () => setMode("normal") },
  { t: "Compara con otros telescopios", x: "La capa Gaia muestra las estrellas conocidas con flechas de movimiento propio. Si algo se mueve y no tiene contraparte en Gaia, ¡puede ser algo frío y nuevo!",
    a: "Mostrar Gaia", fn: () => { const el = document.querySelector('[data-layer="gaia"]'); if (!el.checked) el.click(); } },
  { t: "¿Encontraste algo?", x: "Márcalo como candidato con una nota. Los candidatos quedan en la tabla para que la comunidad y los astrónomos los revisen. ¡Así se descubrieron muchas enanas marrones!",
    a: "Marcar candidato", fn: () => $("markBtn").click() },
];
let tutI = 0;
function showTut(i) {
  tutI = i; const s = TUTORIAL[i];
  $("tutorial").classList.remove("hidden");
  $("tutStep").textContent = `Paso ${i + 1} de ${TUTORIAL.length}`;
  $("tutTitle").textContent = s.t; $("tutText").textContent = s.x;
  $("tutAction").textContent = s.a; $("tutAction").onclick = s.fn;
  $("tutNext").textContent = i === TUTORIAL.length - 1 ? "Terminar" : "Siguiente →";
}

// ------------------------------------------------------------------ controles
function setSeg(id, attr, val) { document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle("on", b.dataset[attr] === val)); }
function setMode(m) {
  S.mode = m; setSeg("modeSeg", "mode", m);
  $("diffGroup").classList.toggle("hidden", m !== "diff");
  $("colorGroup").classList.toggle("hidden", m !== "color");
  $("detGroup").classList.toggle("hidden", m === "color");
  document.querySelectorAll("#groupSeg button").forEach((b) => (b.disabled = m === "color"));
  computeFrames(); updateURL();
}
function setGroup(g) { S.group = g; setSeg("groupSeg", "group", g); computeFrames(); updateURL(); }

function bindUI() {
  $("searchForm").addEventListener("submit", (e) => { e.preventDefault(); load($("q").value, $("fov").value); });
  document.querySelectorAll(".ex").forEach((b) => b.addEventListener("click", () => {
    $("q").value = b.dataset.q; load(b.dataset.q, b.dataset.fov, b.dataset.label || b.textContent.replace(/^\S+\s/, ""));
  }));
  $("playBtn").onclick = () => (S.playing ? stop() : play());
  $("prevBtn").onclick = () => { stop(); step(-1); };
  $("nextBtn").onclick = () => { stop(); step(1); };
  $("fps").oninput = (e) => { S.fps = +e.target.value; $("fpsVal").textContent = S.fps; if (S.playing) play(); };
  document.querySelectorAll("#modeSeg button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  document.querySelectorAll("#groupSeg button").forEach((b) => (b.onclick = () => setGroup(b.dataset.group)));
  $("detector").onchange = (e) => { S.detector = e.target.value; computeFrames(); updateURL(); };
  $("diffRef").onchange = (e) => { S.diffRef = e.target.value; computeFrames(); };
  $("preset").onchange = (e) => { S.preset = e.target.value; computeFrames(); updateURL(); };
  $("stretch").onchange = (e) => { S.stretch = e.target.value; render(); };
  $("contrast").oninput = (e) => { S.contrast = +e.target.value; computeScaling(); render(); };
  $("invert").onchange = (e) => { S.invert = e.target.checked; render(); };
  $("maskFlags").onchange = (e) => { S.maskFlags = e.target.checked; computeFrames(); };
  document.querySelectorAll("[data-layer]").forEach((el) => (el.onchange = () => {
    S.layers[el.dataset.layer] = el.checked;
    if (el.checked && (el.dataset.layer === "gaia" || el.dataset.layer === "catwise")) ensureCatalog(el.dataset.layer);
    render();
  }));
  $("bbT").oninput = (e) => { $("bbTVal").textContent = `${e.target.value} K`; drawSpectrum(); };
  $("bbToggle").onchange = drawSpectrum;
  $("recenter").onchange = analyzeSelection;
  $("normLc").onchange = drawLightCurve;
  $("survey").onchange = (e) => { try { S.aladin && S.aladin.setImageSurvey(e.target.value); } catch (err) { console.warn(err); } };

  $("linkBtn").onclick = () => S.target ? copy(shareURL(), "Enlace copiado: cualquiera que lo abra verá este mismo campo.") : toast("Primero carga un objeto.");
  $("embedBtn").onclick = () => S.target
    ? copy(`<iframe src="${shareURL({ embed: "1" })}" width="660" height="780" style="border:0;border-radius:12px" title="SPHEREx · ${S.target.name || ""}"></iframe>`, "Código <iframe> copiado.")
    : toast("Primero carga un objeto.");
  $("gifBtn").onclick = exportAnimation;
  $("demoToggle").onchange = (e) => {
    S.forceDemo = e.target.checked; updateStatusChip(); listCandidates();
    if (S.target) load(S.target.query || `${S.target.ra} ${S.target.dec}`, S.lastFov, S.target.name);
  };

  $("markBtn").onclick = () => {
    if (!S.sel) return toast("Primero haz clic sobre el objeto que te parece interesante.");
    $("candPos").textContent = `${Astro.fmtRA(S.sel.ra)} ${Astro.fmtDec(S.sel.dec)}`;
    $("candForm").classList.remove("hidden"); $("candNote").focus();
    $("candForm").scrollIntoView({ behavior: "smooth", block: "center" });
  };
  $("candCancel").onclick = () => $("candForm").classList.add("hidden");
  $("candForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await saveCandidate($("candNote").value.trim(), $("candAuthor").value.trim());
          $("candForm").classList.add("hidden"); $("candNote").value = ""; }
    catch (err) { toast(`No se pudo guardar: ${err.message}`); }
  });

  $("tutorialBtn").onclick = () => showTut(0);
  $("tutNext").onclick = () => (tutI < TUTORIAL.length - 1 ? showTut(tutI + 1) : $("tutorial").classList.add("hidden"));
  $("tutClose").onclick = () => $("tutorial").classList.add("hidden");

  document.addEventListener("keydown", (e) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    if (e.code === "Space") { e.preventDefault(); S.playing ? stop() : play(); }
    else if (e.code === "ArrowRight") { stop(); step(1); }
    else if (e.code === "ArrowLeft") { stop(); step(-1); }
  });
}

// ------------------------------------------------------------------ inicio
document.addEventListener("DOMContentLoaded", async () => {
  bindUI();
  render();
  const P = new URLSearchParams(location.search);
  if (P.get("embed") === "1") document.body.classList.add("embed");
  if (P.get("demo") === "1") { S.forceDemo = true; $("demoToggle").checked = true; }
  await checkBackend();
  initAladin();
  clearPlots();
  listCandidates();
  if (P.get("mode")) { S.mode = P.get("mode"); setSeg("modeSeg", "mode", S.mode); }
  if (P.get("group")) { S.group = P.get("group"); setSeg("groupSeg", "group", S.group); }
  if (P.get("det")) { S.detector = P.get("det"); $("detector").value = S.detector; }
  if (P.get("preset")) { S.preset = P.get("preset"); $("preset").value = S.preset; }
  $("diffGroup").classList.toggle("hidden", S.mode !== "diff");
  $("colorGroup").classList.toggle("hidden", S.mode !== "color");
  $("detGroup").classList.toggle("hidden", S.mode === "color");
  const fov = P.get("fov") || "6";
  if (P.get("ra") && P.get("dec")) {
    const q = `${P.get("ra")} ${P.get("dec")}`; $("q").value = P.get("name") || q;
    load(q, fov, P.get("name") || undefined);
  } else if (P.get("q")) { $("q").value = P.get("q"); load(P.get("q"), fov); }
  else {
    let seen = true;
    try { seen = !!localStorage.getItem("cazamundos_visto"); localStorage.setItem("cazamundos_visto", "1"); } catch (_) { /* nada */ }
    if (!seen) showTut(0);
  }
});
