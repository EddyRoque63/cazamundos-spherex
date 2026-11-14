# 🔭 CazaMundos SPHEREx

**Buscador de mundos en movimiento**: una herramienta web pública para ver cómo cambia el cielo infrarrojo de la misión SPHEREx de la NASA con el tiempo.

Proyecto para el **NASA Space Apps Challenge 2026**, reto **«Planeta X y SPHEREx»**.

---

## ¿Qué hace?

El usuario escribe un objeto (o coordenadas RA/Dec) y la herramienta muestra las imágenes de SPHEREx de esa zona **como un pequeño video («blink»)**. Así cualquiera puede detectar objetos que se mueven: asteroides, cometas, enanas marrones o estrellas cercanas.

| Función | Para qué sirve |
|---|---|
| **Blink animado** por época (cada ~6 meses) o por visita individual | Ver objetos que se mueven |
| **Modo Resta** (cielo promedio, primer cuadro o cuadro anterior) | Lo que no cambia desaparece; lo que se mueve aparece como blanco/negro |
| **Modo Color** con presets moleculares (metano, agua, CO₂, CO) | Aprovechar las 102 bandas: los objetos con esas moléculas cambian de color |
| **Filtro por detector** (D1–D6) | Sumar los datos de cada detector mejora la relación señal-ruido |
| **Espectro al hacer clic** (las 102 bandas, con comparación de cuerpo negro) | Ver la «huella química» del objeto, generada al momento |
| **Curva de luz** | Ver estrellas variables como RW Aurigae y R Draconis |
| **Capas Gaia DR3 y CatWISE2020** con flechas de movimiento propio | Comparar con otros telescopios; un objeto sin contraparte en Gaia puede ser nuevo |
| **Asteroides conocidos** (IMCCE SkyBoT) | Descartar rápido los asteroides ya catalogados |
| **Banderas de calidad** | No confundir rayos cósmicos o artefactos con descubrimientos |
| **URL compartible** (`?ra=…&dec=…&fov=…`) y **código `<iframe>`** | Incrustar la herramienta en otros sitios |
| **Exportar animación** (GIF o video) | Compartir lo que encontraste |
| **Candidatos de la comunidad** | Ciencia ciudadana: marcar objetos interesantes con una nota |
| **Modo guiado** | Tutorial de 6 pasos para principiantes |
| **Contexto Aladin Lite** | Ver la misma zona en DSS, 2MASS, AllWISE o Pan-STARRS |

### Siempre actualizada
La herramienta **no guarda datos SPHEREx propios**: consulta el archivo IRSA en vivo cada vez. Las nuevas entregas semanales de SPHEREx aparecen solas, sin cambiar el código. Los recortes ya descargados se guardan en caché (`backend/cache/`) para que repetir una búsqueda sea instantáneo.

---

## Cómo ejecutarla

### Opción A: con datos reales (recomendada)
1. Instala **Python 3.10 o superior** desde <https://www.python.org/downloads/> y marca **«Add python.exe to PATH»**.
2. Haz doble clic en **`iniciar.bat`**. La primera vez instalará las dependencias (unos minutos).
3. Se abrirá <http://localhost:8000>. Arriba a la derecha debe decir **● IRSA en vivo**.

Manual (cualquier sistema operativo):
```bash
python -m venv .venv
# Windows: .venv\Scripts\activate    ·    Mac/Linux: source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn backend.app:app --port 8000
```

> La primera búsqueda de un objeto puede tardar **1 o 2 minutos**, porque se descargan cientos de recortes desde IRSA. Las siguientes son inmediatas gracias a la caché.

### Opción B: modo demo (sin Python ni servidor)
Abre `frontend/index.html` en el navegador. Como no encuentra el servidor, usa **datos simulados** (lo indica en naranja: **● DEMO**). Sirve como plan B para la presentación si falla internet. El campo simulado incluye una enana marrón rápida sin contraparte en Gaia, una estrella variable y un asteroide.

También puedes forzar el demo con la casilla «Forzar modo demo» o con `?demo=1` en la URL.

---

## Objetos de prueba del reto

| Objeto | Qué buscar |
|---|---|
| **Estrella de Barnard** | Movimiento propio enorme (~10″/año): se nota entre épocas |
| **Epsilon Indi B** | Par de enanas marrones: activa el preset *Metano* |
| **WISE 0855−0714** | La enana marrón más fría conocida, muy rápida. Usa campo de 3′ y modo Resta |
| **RW Aurigae** | Estrella variable joven: revisa la curva de luz |
| **R Draconis** | Variable tipo Mira (~245 días): cambia mucho de brillo entre épocas |

Ejemplos de URL:
```
http://localhost:8000/?q=Barnard's%20Star&fov=6
http://localhost:8000/?ra=133.795129&dec=-7.245147&fov=3&mode=diff&name=WISE%200855
http://localhost:8000/?q=R%20Dra&mode=color&preset=detectors
http://localhost:8000/?q=eps%20Ind%20B&embed=1        ← versión para incrustar
```

---

## Cómo funciona (arquitectura)

```
Navegador (frontend/)                      Servidor Python (backend/)                 Servicios externos
──────────────────────                     ─────────────────────────                  ──────────────────
index.html + css                           FastAPI (app.py)
js/app.js     interfaz, blink, gráficos ─► /api/resolve  ───────────────────────────► SIMBAD (nombres + mov. propio)
js/astro.js   apilado, resta, fotometría   /api/cube  → spherex.py ─ TAP + recortes ► IRSA SPHEREx (NASA/IPAC)
js/demo.js    datos simulados              /api/catalog/{gaia|catwise} ─────────────► VizieR (Gaia DR3, CatWISE2020)
Plotly (gráficos) · Aladin Lite (contexto) /api/asteroids ──────────────────────────► IMCCE SkyBoT
                                           /api/candidates · /api/gif
```

**Procesamiento en el servidor (`backend/spherex.py`):**
1. Consulta TAP a IRSA (`spherex.plane` + `spherex.artifact`) para listar todas las imágenes espectrales que cubren la posición.
2. Descarga en paralelo **recortes** de cada imagen con el servicio de cutouts de IRSA (`?center=…&size=…`).
3. Resta la luz zodiacal (extensión `ZODI`) y **reproyecta** cada recorte a una cuadrícula común (TAN, norte arriba), para que todas las imágenes queden alineadas.
4. Calcula la **longitud de onda** de cada imagen en la posición del objetivo con el WCS espectral (`WCS-WAVE`, clave `W`). SPHEREx usa filtros lineales variables, así que la longitud de onda cambia a lo largo del detector.
5. Envía al navegador las imágenes alineadas (float32) con sus metadatos y banderas.

**En el navegador (`frontend/js/astro.js`)** se hace todo lo interactivo, sin volver a consultar al servidor:
- Agrupación en **épocas** (huecos de más de 30 días) y **apilado por mediana**, que elimina rayos cósmicos.
- **Resta** de imágenes, **combinaciones RGB** por rango de longitud de onda y escalas asinh/log/lineal.
- **Fotometría de apertura** (µJy) en cada imagen → espectro y curva de luz.
- Proyección de catálogos con **movimiento propio** propagado a la fecha de cada cuadro.

---

## Limitaciones conocidas (honestidad científica)

- La fotometría es **de apertura simple**, no de ajuste de PSF. Es buena para explorar, pero no reemplaza el análisis profesional (ver la herramienta de espectrofotometría de IRSA).
- La capa de banderas marca los píxeles con **cualquier** bit activado. Para saber qué significa cada bit, consulta el *SPHEREx Explanatory Supplement*.
- Si hay más de 240 imágenes de una zona, se toma una muestra uniforme en el tiempo (ajustable en `max_images`).
- Los nombres se resuelven con SIMBAD y la posición se propaga a 2026.0 con el movimiento propio. Los objetos muy rápidos pueden necesitar un campo mayor.

## Ideas para seguir mejorando
- Detección automática de candidatos en movimiento (buscar pares positivo/negativo en las restas).
- Ajuste automático de plantillas espectrales (enanas M/L/T/Y, cometas, cuásares).
- Base de datos compartida en la nube para los candidatos de la comunidad.

---

**Datos:** NASA/IPAC Infrared Science Archive (IRSA), misión SPHEREx · **Catálogos:** CDS VizieR (Gaia DR3, CatWISE2020), SIMBAD · **Asteroides:** IMCCE SkyBoT · **Visor:** Aladin Lite (CDS Strasbourg) · **Gráficos:** Plotly.
