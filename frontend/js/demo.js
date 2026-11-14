/* =========================================================================
   demo.js — datos SIMULADOS con el mismo formato que el servidor.
   Sirve para presentar la herramienta sin internet o sin el servidor Python.
   Incluye: un campo de estrellas, una "enana marrón" que se mueve rápido
   (sin contraparte en Gaia), una estrella variable y un asteroide.
   ========================================================================= */
"use strict";

const Demo = (() => {
  const KNOWN = {
    "barnard's star": { ra: 269.4486, dec: 4.7375, name: "Estrella de Barnard" },
    "barnards star": { ra: 269.4486, dec: 4.7375, name: "Estrella de Barnard" },
    "eps ind b": { ra: 330.8710, dec: -56.7990, name: "Epsilon Indi B" },
    "rw aur": { ra: 76.9563, dec: 30.4013, name: "RW Aurigae" },
    "r dra": { ra: 248.1672, dec: 66.7551, name: "R Draconis" },
    "wise 0855": { ra: 133.7951, dec: -7.2452, name: "WISE 0855−0714" },
  };

  function rng(seed) {             // Mulberry32
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0; let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const gauss = (r) => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  function resolve(q) {
    const c = Astro.parseCoords(q);
    if (c) return { name: q, ra: c.ra, dec: c.dec, pmra: 0, pmdec: 0, source: "coordenadas" };
    const k = q.trim().toLowerCase().replace(/\s+/g, " ");
    if (KNOWN[k]) return { ...KNOWN[k], pmra: 0, pmdec: 0, source: "DEMO" };
    // cualquier otro nombre: posición pseudoaleatoria reproducible
    let h = 0; for (const ch of k) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const r = rng(h);
    return { name: q, ra: r() * 360, dec: (r() - 0.5) * 140, pmra: 0, pmdec: 0, source: "DEMO" };
  }

  // Espectro de juguete de una enana T: cuerpo negro frío con absorciones
  function tDwarf(lam) {
    let f = Astro.planckNu(lam, 900) / Astro.planckNu(4.2, 900);
    const dip = (c, w, d) => 1 - d * Math.exp(-0.5 * ((lam - c) / w) ** 2);
    f *= dip(1.15, 0.05, 0.6) * dip(1.4, 0.08, 0.85) * dip(1.85, 0.1, 0.85) *
         dip(2.25, 0.12, 0.6) * dip(3.3, 0.22, 0.9) * dip(4.65, 0.12, 0.3);
    return f;
  }
  const star = (T) => (lam) => Astro.planckNu(lam, T) / Astro.planckNu(2.0, T);

  function generate(ra, dec, fovArcmin) {
    const NATIVE = 6.15, MAXPIX = 160;
    const scale = Math.max(NATIVE, fovArcmin * 60 / MAXPIX);
    let n = Math.ceil(fovArcmin * 60 / scale); if (n % 2 === 0) n++;
    const grid = { ra, dec, scale_arcsec: scale, nx: n, ny: n };
    const proj = Astro.makeProjection(grid);
    const r = rng(Math.round(ra * 1000) ^ Math.round((dec + 90) * 7919));
    const pixSr = (scale / 206264.806) ** 2;
    const uJyToMJysr = 1e-12 / pixSr;                 // flujo en 1 px → MJy/sr
    const sigmaPsf = 0.9 * NATIVE / scale;
    const noise = 18 * uJyToMJysr;

    // ----- objetos -----
    const yr0 = Astro.mjdToYear(60810);               // época de referencia
    // enana marrón rápida (movimiento exagerado para la demo: ~30″/año)
    const bdX = (n - 1) / 2 - n * 0.12, bdY = (n - 1) / 2 + n * 0.08;
    const bd0 = proj.toSky(bdX, bdY);
    const bd = { ra: bd0.ra, dec: bd0.dec, flux2: 0, f42: 2600, spec: tDwarf,
                 pmra: 26000, pmdec: -15000, kind: "bd" };
    const vX = n * 0.28, vY = n * 0.70;
    const stars = [];
    const nStars = Math.round(1.6 * fovArcmin * fovArcmin) + 12;
    for (let i = 0, tries = 0; i < nStars && tries < nStars * 20; tries++) {
      const x = r() * (n - 1), y = r() * (n - 1);
      // deja libre la trayectoria de la enana marrón y la estrella variable
      if (Math.hypot(x - bdX, y - bdY) < 7 || Math.hypot(x - vX, y - vY) < 4) continue;
      const s = proj.toSky(x, y);
      stars.push({
        ra: s.ra, dec: s.dec, flux2: Math.exp(Math.log(150) + r() * Math.log(400)),
        spec: star(3000 + r() * 6000), pmra: gauss(r) * 8, pmdec: gauss(r) * 8, kind: "star",
      });
      i++;
    }
    // estrella variable (tipo Mira, periodo ~250 d)
    const vpos = proj.toSky(vX, vY);
    stars.push({ ra: vpos.ra, dec: vpos.dec, flux2: 9000, spec: star(2600), pmra: 3, pmdec: -2,
                 kind: "variable", period: 250, amp: 0.45 });

    // ----- visitas: 3 épocas × 6 detectores × 8 longitudes de onda -----
    const epochStarts = [60810, 60995, 61180];
    const visits = [];
    const npix = n * n;
    const astIdx = 1;                                   // asteroide en la época 2
    epochStarts.forEach((m0, e) => {
      let k = 0;
      for (let d = 1; d <= 6; d++) {
        const [lo, hi] = Astro.DETECTORS[d];
        for (let j = 0; j < 8; j++, k++) {
          const lam = lo + (j + 0.5) / 8 * (hi - lo) + (r() - 0.5) * 0.01;
          const mjd = m0 + k * 0.21 + r() * 0.05;
          const data = new Float32Array(npix);
          const flags = new Uint8Array(npix);
          for (let p = 0; p < npix; p++) data[p] = gauss(r) * noise;
          const yr = Astro.mjdToYear(mjd);
          const add = (sra, sdec, fluxUJy) => {
            const pp = proj.toPix(sra, sdec);
            const amp = fluxUJy * uJyToMJysr / (2 * Math.PI * sigmaPsf * sigmaPsf);
            const R = Math.ceil(sigmaPsf * 4);
            for (let yy = Math.floor(pp.y - R); yy <= pp.y + R; yy++)
              for (let xx = Math.floor(pp.x - R); xx <= pp.x + R; xx++) {
                if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
                data[yy * n + xx] += amp * Math.exp(-((xx - pp.x) ** 2 + (yy - pp.y) ** 2) / (2 * sigmaPsf * sigmaPsf));
              }
          };
          for (const s of stars) {
            const pos = Astro.propagate(s, yr0, yr);
            let f = s.flux2 * s.spec(lam);
            if (s.kind === "variable") f *= 1 + s.amp * Math.sin(2 * Math.PI * (mjd - 60810) / s.period);
            add(pos.ra, pos.dec, f);
          }
          const bp = Astro.propagate(bd, yr0, yr);
          add(bp.ra, bp.dec, bd.f42 * bd.spec(lam));
          if (e === astIdx) {                         // asteroide: cruza el campo en ~10 días
            const t = (mjd - m0) / 10;
            const a = proj.toSky(n * (0.05 + 0.9 * t), n * (0.15 + 0.35 * t));
            add(a.ra, a.dec, 900 * star(5800)(lam) * (lam > 3.5 ? 1 + (lam - 3.5) * 1.5 : 1));
          }
          // rayos cósmicos y luz difusa (marcados con banderas)
          const ncr = 2 + Math.floor(r() * 4);
          for (let c = 0; c < ncr; c++) {
            const p = Math.floor(r() * npix); data[p] += 40 * noise; flags[p] = 1;
          }
          if (r() < 0.12) { for (let yy = 0; yy < n; yy++) for (let xx = 0; xx < 3; xx++) flags[yy * n + xx] = 1; }
          let ff = 0; for (let p = 0; p < npix; p++) ff += flags[p];
          visits.push({ mjd, band: `SPHEREx-D${d}`, detector: d, wavelength: +lam.toFixed(4),
                        coverage: 1, flag_frac: ff / npix, data, flags });
        }
      }
    });
    visits.sort((a, b) => a.mjd - b.mjd);

    // ----- catálogos simulados -----
    const gaia = stars.map((s) => {
      const p = Astro.propagate(s, yr0, 2016.0);
      return { ra: p.ra, dec: p.dec, pmra: s.pmra, pmdec: s.pmdec,
               mag: +(20 - 2.5 * Math.log10(s.flux2 / 10)).toFixed(2), id: "demo" };
    }); // la enana marrón NO está en Gaia (es demasiado fría y roja)
    const bdW = Astro.propagate(bd, yr0, 2015.4);
    const catwise = [...stars.filter(() => r() < 0.7).map((s) => {
      const p = Astro.propagate(s, yr0, 2015.4);
      return { ra: p.ra, dec: p.dec, pmra: s.pmra, pmdec: s.pmdec, mag: 12, id: "demo" };
    }), { ra: bdW.ra, dec: bdW.dec, pmra: bd.pmra, pmdec: bd.pmdec, mag: 14.5, id: "demo-BD" }];

    const asteroidAt = (mjd) => {
      const m0 = epochStarts[astIdx];
      if (mjd < m0 - 1 || mjd > m0 + 12) return [];
      const t = Math.min(1, Math.max(0, (mjd - m0) / 10));
      const a = proj.toSky(n * (0.05 + 0.9 * t), n * (0.15 + 0.35 * t));
      return [{ name: "(99942) Demo", ra: a.ra, dec: a.dec, vmag: 17.2, type: "NEA" }];
    };

    return {
      result: { grid, visits, total_found: visits.length, source: "DEMO (datos simulados)" },
      catalogs: { gaia: { epoch: 2016.0, sources: gaia }, catwise: { epoch: 2015.4, sources: catwise } },
      asteroidAt,
    };
  }

  return { resolve, generate };
})();
