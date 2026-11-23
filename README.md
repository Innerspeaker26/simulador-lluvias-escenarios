# Escenarios de lluvia 3D · costa norte del Perú

Simulador 3D de inundación urbana con **tormentas basadas en datos de SENAMHI**:

- **Diseño:** tormentas por periodo de retorno, tomadas de las curvas IDF de SENAMHI.
- **Histórico:** eventos reales registrados por PISCOp v3.0.
- **Libre:** intensidad y duración a elección.

Cubre 8 ciudades: Piura, Sullana, Tumbes, Talara, Paita, Chulucanas, Chiclayo y Trujillo. El
terreno es GEM‑15 (15 m), con edificaciones y calles de Overture Maps.

Este proyecto parte del [simulador de lluvias 3D](https://github.com/Innerspeaker26/simulador-lluvias)
y le cambia los escenarios ilustrativos por escenarios con fuente oficial.

**En línea:** <https://innerspeaker26.github.io/simulador-lluvias-escenarios/>

## Los tres tipos de escenario

| Tipo | De dónde sale | Para qué sirve |
|---|---|---|
| **Diseño** | Curvas IDF de SENAMHI | Planificar: «¿qué inunda una lluvia de 50 años y 3 horas?» |
| **Histórico** | PISCOp v3.0 (lluvia diaria real, 1981–2025) | Reproducir 1983, 1998, 2017 o 2023, y validar el modelo |
| **Libre** | Intensidad y duración elegidas | Explorar; se informa a cuántos años de retorno equivale |

### Diseño (IDF)
- **Fórmula:** `I = k · T^m / D^n` (mm/h), con T de 2 a 100 años y D de 1 a 24 h. Los
  parámetros salen de la herramienta de SENAMHI (<https://idesep.senamhi.gob.pe/dhi-idf/>): su
  lluvia de 24 h por periodo de retorno, su curva horaria regional y su mismo ajuste.
- **Opciones:**
  - **Clima:** actual, o la mediana de 3 modelos proyectados al 2050.
  - **Estimación:** baja, central o alta (el rango que publica SENAMHI).
- **Forma de la tormenta:** bloques alternos de 1 h, con el pico al centro (Chow, Maidment y
  Mays, 1988).
- **Reducción por área** (activable): la IDF es un valor puntual y el simulador aplica la lluvia
  sobre toda la ciudad. Se usa la fórmula de Leclerc y Schaake (1972), un ajuste de las curvas
  del U.S. Weather Bureau. Para una escena de 200 km² da unos 0,82 en 1 h y 0,95 en 24 h.

### Histórico (PISCOp)
- **Eventos:** por cada temporada de El Niño (1982‑83, 1997‑98, 2016‑17, 2022‑23), los **3 días
  más lluviosos** en la celda de 0,1° de la ciudad, más el día récord si cae fuera de esas
  temporadas.
- **Reparto horario:** cada día se distribuye hora a hora con la curva regional de SENAMHI, como
  hace su herramienta.
- **Duración:** un evento de 3 días son 72 horas simuladas; con la velocidad al máximo se ve en
  unos minutos.

### Libre
- **Lluvia constante:** de 2 a 120 mm/h, durante 0,5 a 12 h.
- **Periodo de retorno equivalente:** se obtiene despejando T de la fórmula IDF.

## Uso local

```bash
cd docs
python -m http.server 8767
```

Abre <http://localhost:8767/?ciudad=piura>. En Windows también puedes usar `iniciar_simulador.bat`.

Todo lo demás del simulador anterior se mantiene:
- modelo hidrodinámico 2D en GPU;
- calles con nombre y km anegados;
- pines con coordenadas y gráfico del tirante;
- exportación a ArcGIS (`.asc`, CSV, GeoJSON).

## Estructura

| Ruta | Contenido |
|---|---|
| `docs/` | Visor web (GitHub Pages publica esta carpeta) |
| `docs/js/escenarios.js` | Hietogramas: IDF, PISCOp, libre, reducción por área |
| `docs/data/<ciudad>/lluvia.json` | Parámetros IDF (actual y 2050, banda baja/central/alta), curva horaria regional, eventos de PISCOp |
| `python/preparar_lluvia.py` | Genera `lluvia.json` a partir de SENAMHI (WMS de la IDF) y de PISCOp (lectura parcial del NetCDF remoto) |
| `python/preparar_escena.py` | Genera el terreno, la imagen, las edificaciones y las calles de una ciudad |
| `gee/` | Script de Google Earth Engine para análisis de GEM‑15 |

## Regenerar los datos de lluvia

```bash
pip install -r python/requirements.txt
python python/preparar_lluvia.py            # las 8 ciudades
python python/preparar_lluvia.py piura      # una sola
```

La serie de PISCOp de cada ciudad se lee del archivo remoto de 1,6 GB pidiendo solo el bloque
necesario, y se guarda en `python/cache/`.

## Limitaciones
- **Subdiario incierto:** SENAMHI advierte que los valores de menos de 24 h son inciertos donde
  hay pocas estaciones.
- **Promedio de celda:** PISCOp promedia celdas de unos 11 km y subestima los picos locales. El
  «día» de PISCOp es un total diario, cuyo reparto horario aquí se estima.
- **Talara:** el centro cae fuera de la capa IDF de SENAMHI; se usa un punto 3 km tierra adentro.
- **Lluvia uniforme:** se aplica igual en toda la escena, sin variación espacial.
- **Herramienta didáctica:** no es un mapa oficial de peligro.

## Créditos
- Curvas IDF y PISCOp v3.0: SENAMHI (Gutiérrez y Lavado‑Casimiro, 2026;
  doi:10.6084/m9.figshare.32411886, licencia GPL‑3.0+).
- GEM‑15: «This dataset is produced by Google», CC‑BY 4.0.
- Copernicus Sentinel‑2 y GLO‑30 © ESA / UE.
- Overture Maps Foundation (edificios y calles).
- Three.js y troika‑three‑text (MIT).
