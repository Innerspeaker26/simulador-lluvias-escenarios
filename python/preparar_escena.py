"""
Prepara la escena 3D de una ciudad de la costa norte del Perú para el simulador de lluvias.

Fuentes (todas abiertas):
  * Relieve ............ GEM-15 v1 (Google Research, CC-BY 4.0)
                         projects/climate-and-sustainability/assets/gem-15_v1
                         - banda `dtm`  -> terreno desnudo (lo que "ve" el agua)
                         - banda `dsm_percentile_95` - `dtm` -> altura de edificaciones
                         Se lee como COG público (gs://climate-and-sustainability/gem-15)
                         o, con --fuente gee, directamente desde Google Earth Engine.
  * Huecos de GEM-15 ... Copernicus GLO-30 (el GEM-15 enmascara el agua como "sin dato")
  * Imagen ............. Copernicus Sentinel-2 L2A (color verdadero, 10 m, < 3 % nubes)
  * Edificaciones ...... Overture Maps (Google, Microsoft, OSM) vía DuckDB
  * Calles ............. Overture Maps, tema transportation (segmentos de vía)

Salida en  docs/data/<ciudad>/ :
  escena.json       metadatos (rejilla, cotas, vistas, créditos)
  dtm.u16           terreno, uint16 little-endian:  z = v * step - off  (W*H, fila 0 = norte)
  agua.u8           1 = celda sin dato en GEM-15 (cauce / cuerpo de agua) rellenada con GLO-30
  cobertura.u8      fracción de la celda ocupada por edificaciones (0-255)
  textura.jpg       Sentinel-2 color verdadero recortado a la escena
  edificios.json    polígonos en coordenadas locales (m) + altura
  calles.json       ejes de vía (Overture transportation) con tipo y nombre

Uso:
  python preparar_escena.py piura
  python preparar_escena.py chiclayo --fuente gee --proyecto-gee mi-proyecto
  python preparar_escena.py --lista
  python preparar_escena.py piura --solo-calles   # agrega calles a una escena existente
"""
from __future__ import annotations

import argparse
import io
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

RAIZ = Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "docs" / "data"

CELDA = 15.0  # m, resolución nativa de GEM-15
EPSG_UTM17S = 32717  # todas las ciudades de la costa norte caen en la zona 17 Sur

OVERTURE_RELEASE = "2026-11-18.0"
GEM15_COG = "https://storage.googleapis.com/climate-and-sustainability/gem-15"
GEM15_ASSET = "projects/climate-and-sustainability/assets/gem-15_v1"
STAC_S2 = "https://earth-search.aws.element84.com/v1/search"
CREDITOS = ("Relieve: GEM-15, Google (CC-BY 4.0) y Copernicus GLO-30. Imagen: Copernicus Sentinel-2. "
            "Edificios y calles: Overture Maps (Google, Microsoft, OSM).")

# ---------------------------------------------------------------------------
# Ciudades de la costa norte. centro = (lon, lat); tamaño en km; vistas en lon/lat.
# ---------------------------------------------------------------------------
CIUDADES = {
    "piura": dict(
        nombre="Piura",
        subtitulo="Piura, Castilla y Veintiséis de Octubre",
        centro=(-80.640, -5.185), ancho_km=15.3, alto_km=13.2,
        vistas=[
            ("Centro histórico", -80.6328, -5.1950, 1400),
            ("Castilla", -80.6180, -5.1960, 1700),
            ("Veintiséis de Octubre", -80.6750, -5.1800, 1900),
            ("Río Piura", -80.6290, -5.1780, 2300),
        ],
        # Punto donde el río entra al recuadro (aguas arriba). El simulador inyecta ahí
        # el caudal de crecida. None = detección automática por la máscara de agua.
        rio_entrada=(-80.6185, -5.1257),
    ),
    "sullana": dict(
        nombre="Sullana", subtitulo="Sullana y Bellavista",
        centro=(-80.685, -4.900), ancho_km=10.5, alto_km=9.0,
        vistas=[("Centro", -80.686, -4.904, 1300), ("Río Chira", -80.700, -4.890, 2000)],
    ),
    "tumbes": dict(
        nombre="Tumbes", subtitulo="Tumbes y Corrales",
        centro=(-80.455, -3.568), ancho_km=10.5, alto_km=9.0,
        vistas=[("Centro", -80.452, -3.567, 1300), ("Río Tumbes", -80.460, -3.560, 2000)],
    ),
    "chiclayo": dict(
        nombre="Chiclayo", subtitulo="Chiclayo, José Leonardo Ortiz y La Victoria",
        centro=(-79.840, -6.770), ancho_km=15.0, alto_km=13.5,
        vistas=[("Centro", -79.8405, -6.7714, 1500), ("La Victoria", -79.835, -6.790, 1800)],
    ),
    "talara": dict(
        nombre="Talara", subtitulo="Talara y Pariñas",
        centro=(-81.270, -4.580), ancho_km=9.0, alto_km=8.0,
        vistas=[("Centro", -81.272, -4.577, 1300)],
    ),
    "paita": dict(
        nombre="Paita", subtitulo="Paita y su bahía",
        centro=(-81.110, -5.085), ancho_km=8.0, alto_km=7.0,
        vistas=[("Centro", -81.114, -5.089, 1200)],
        sin_rio=True,   # ciudad costera sin río: no se ofrece caudal de entrada
    ),
    "chulucanas": dict(
        nombre="Chulucanas", subtitulo="Chulucanas (Morropón)",
        centro=(-80.162, -5.093), ancho_km=7.0, alto_km=6.0,
        vistas=[("Centro", -80.162, -5.093, 1200)],
    ),
    "trujillo": dict(
        nombre="Trujillo", subtitulo="Trujillo, El Porvenir y La Esperanza",
        centro=(-79.025, -8.100), ancho_km=15.3, alto_km=14.0,
        vistas=[("Centro", -79.0290, -8.1116, 1500), ("El Porvenir", -78.995, -8.080, 1900)],
    ),
}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------------------
# Rejilla
# ---------------------------------------------------------------------------
class Rejilla:
    def __init__(self, cfg: dict):
        from pyproj import Transformer

        self.to_utm = Transformer.from_crs(4326, EPSG_UTM17S, always_xy=True)
        self.to_geo = Transformer.from_crs(EPSG_UTM17S, 4326, always_xy=True)
        cx, cy = self.to_utm.transform(*cfg["centro"])
        self.W = int(round(cfg["ancho_km"] * 1000 / CELDA))
        self.H = int(round(cfg["alto_km"] * 1000 / CELDA))
        # Alinear a la malla nativa de GEM-15 (múltiplos de 15 m)
        self.x0 = math.floor((cx - self.W * CELDA / 2) / CELDA) * CELDA
        self.y1 = math.floor((cy + self.H * CELDA / 2) / CELDA) * CELDA  # borde norte
        self.x1 = self.x0 + self.W * CELDA
        self.y0 = self.y1 - self.H * CELDA
        from rasterio.transform import from_origin

        self.transform = from_origin(self.x0, self.y1, CELDA, CELDA)

    def bbox_geo(self, margen=0.002):
        xs = [self.x0, self.x1, self.x0, self.x1]
        ys = [self.y0, self.y0, self.y1, self.y1]
        lon, lat = self.to_geo.transform(xs, ys)
        return (min(lon) - margen, min(lat) - margen, max(lon) + margen, max(lat) + margen)

    def local(self, lon, lat):
        """lon/lat -> coordenadas locales (m) con origen en la esquina SO, y hacia el norte."""
        x, y = self.to_utm.transform(lon, lat)
        return x - self.x0, y - self.y0


# ---------------------------------------------------------------------------
# Relieve: GEM-15
# ---------------------------------------------------------------------------
def teselas_gem15(bbox):
    """Nombres de las teselas 1°x1° de GEM-15 que tocan el bbox (lon/lat)."""
    out = []
    for lat in range(math.floor(bbox[1]), math.floor(bbox[3]) + 1):
        for lon in range(math.floor(bbox[0]), math.floor(bbox[2]) + 1):
            grupo = f"{'m' if lat < 0 else 'p'}{abs(math.floor(lat / 10) * 10)}_" \
                    f"{'m' if lon < 0 else 'p'}{abs(math.floor(lon / 10) * 10)}"
            tes = f"{'w' if lon < 0 else 'e'}{'m' if lon < 0 else 'p'}{abs(lon)}" \
                  f"{'s' if lat < 0 else 'n'}{'m' if lat < 0 else 'p'}{abs(lat)}"
            out.append(f"{grupo}/{tes}")
    return out


def _reproyectar(url, banda, rej: Rejilla, destino, remuestreo):
    import rasterio
    from rasterio.warp import reproject

    tmp = np.full((rej.H, rej.W), np.nan, np.float32)
    with rasterio.open(url) as src:
        reproject(
            source=rasterio.band(src, banda), destination=tmp,
            src_nodata=src.nodata if src.nodata is not None else np.nan,
            dst_transform=rej.transform, dst_crs=f"EPSG:{EPSG_UTM17S}", dst_nodata=np.nan,
            resampling=remuestreo,
        )
    m = np.isnan(destino) & ~np.isnan(tmp)
    destino[m] = tmp[m]


def gem15_cog(rej: Rejilla):
    from rasterio.enums import Resampling

    dtm = np.full((rej.H, rej.W), np.nan, np.float32)
    dsm95 = np.full((rej.H, rej.W), np.nan, np.float32)
    for t in teselas_gem15(rej.bbox_geo()):
        log(f"GEM-15 tesela {t}")
        try:
            _reproyectar(f"/vsicurl/{GEM15_COG}/{t}/dtm/zall/mosaic.tif", 1, rej, dtm, Resampling.bilinear)
            # bandas del tileset dsm: 1 dsm, 2 p5, 3 p50, 4 p95, 5 std
            _reproyectar(f"/vsicurl/{GEM15_COG}/{t}/dsm/zall/mosaic.tif", 4, rej, dsm95, Resampling.bilinear)
        except Exception as e:  # tesela inexistente (mar, fuera de cobertura)
            log(f"  (sin tesela: {e.__class__.__name__})")
    return dtm, dsm95


def gem15_gee(rej: Rejilla, proyecto: str | None):
    """Misma lectura pero desde Google Earth Engine (requiere `earthengine authenticate`)."""
    import ee

    ee.Initialize(project=proyecto) if proyecto else ee.Initialize()
    img = (ee.ImageCollection(GEM15_ASSET).mosaic()
           .select(["dtm", "dsm_percentile_95"]))
    req = {
        "expression": img,
        "fileFormat": "NUMPY_NDARRAY",
        "grid": {
            "dimensions": {"width": rej.W, "height": rej.H},
            "affineTransform": {"scaleX": CELDA, "shearX": 0, "translateX": rej.x0,
                                "shearY": 0, "scaleY": -CELDA, "translateY": rej.y1},
            "crsCode": f"EPSG:{EPSG_UTM17S}",
        },
    }
    # computePixels admite hasta ~48 MB por petición; para escenas grandes se pide por franjas.
    filas = max(1, int(32e6 / (rej.W * 8)))
    dtm = np.full((rej.H, rej.W), np.nan, np.float32)
    dsm = np.full((rej.H, rej.W), np.nan, np.float32)
    for f0 in range(0, rej.H, filas):
        h = min(filas, rej.H - f0)
        req["grid"]["dimensions"]["height"] = h
        req["grid"]["affineTransform"]["translateY"] = rej.y1 - f0 * CELDA
        a = ee.data.computePixels(req)
        dtm[f0:f0 + h] = a["dtm"]
        dsm[f0:f0 + h] = a["dsm_percentile_95"]
        log(f"  GEE filas {f0}-{f0 + h}")
    # GEE devuelve 0 o valores enmascarados donde no hay dato
    dtm[(dtm == 0) | ~np.isfinite(dtm)] = np.nan
    dsm[(dsm == 0) | ~np.isfinite(dsm)] = np.nan
    return dtm, dsm


def rellenar_con_glo30(dtm, rej: Rejilla):
    """Rellena huecos de GEM-15 (agua) con Copernicus GLO-30 corregido por sesgo."""
    from rasterio.enums import Resampling

    huecos = np.isnan(dtm)
    if not huecos.any():
        return dtm, huecos
    glo = np.full_like(dtm, np.nan)
    b = rej.bbox_geo()
    for lat in range(math.floor(b[1]), math.floor(b[3]) + 1):
        for lon in range(math.floor(b[0]), math.floor(b[2]) + 1):
            n = f"Copernicus_DSM_COG_10_{'S' if lat < 0 else 'N'}{abs(lat):02d}_00_" \
                f"{'W' if lon < 0 else 'E'}{abs(lon):03d}_00_DEM"
            try:
                _reproyectar(f"/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif",
                             1, rej, glo, Resampling.bilinear)
            except Exception:
                pass
    comun = ~huecos & ~np.isnan(glo)
    sesgo = float(np.median(dtm[comun] - glo[comun])) if comun.any() else 0.0
    log(f"Huecos GEM-15: {huecos.mean() * 100:.1f} % -> GLO-30 (sesgo {sesgo:+.2f} m)")
    out = dtm.copy()
    out[huecos] = glo[huecos] + sesgo
    # Mar u otros huecos sin GLO-30: nivel del mar
    out[np.isnan(out)] = 0.0
    return out, huecos


# ---------------------------------------------------------------------------
# Imagen Sentinel-2
# ---------------------------------------------------------------------------
def sentinel2(rej: Rejilla, escala=1.5):
    import requests
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.transform import from_origin
    from rasterio.warp import reproject
    from PIL import Image

    q = {
        "collections": ["sentinel-2-l2a"], "bbox": list(rej.bbox_geo()),
        "datetime": "2024-01-01T00:00:00Z/2026-12-31T00:00:00Z",
        "query": {"eo:cloud_cover": {"lt": 3}}, "limit": 40,
        "sortby": [{"field": "properties.datetime", "direction": "desc"}],
    }
    feats = requests.post(STAC_S2, json=q, timeout=60).json()["features"]
    if not feats:
        raise RuntimeError("No se encontró escena Sentinel-2 sin nubes")
    # Preferir la escena más reciente con menos nubes que cubra todo el recuadro
    W, H = int(rej.W * escala), int(rej.H * escala)
    tr = from_origin(rej.x0, rej.y1, CELDA / escala, CELDA / escala)
    rgb = np.zeros((3, H, W), np.uint8)
    falta = np.ones((H, W), bool)
    usadas = []
    for f in sorted(feats, key=lambda f: f["properties"]["eo:cloud_cover"]):
        url = f["assets"]["visual"]["href"]
        tmp = np.zeros((3, H, W), np.uint8)
        with rasterio.open(url) as src:
            for b in range(3):
                reproject(source=rasterio.band(src, b + 1), destination=tmp[b], src_nodata=0,
                          dst_transform=tr, dst_crs=f"EPSG:{EPSG_UTM17S}", dst_nodata=0,
                          resampling=Resampling.bilinear)
        ok = falta & (tmp.max(0) > 0)
        if ok.sum() == 0:
            continue
        rgb[:, ok] = tmp[:, ok]
        falta &= ~ok
        usadas.append(f["id"])
        log(f"Sentinel-2 {f['id']} ({f['properties']['eo:cloud_cover']:.2f} % nubes)")
        if falta.mean() < 0.001:
            break
    # Leve realce: el TCI de la costa desértica sale lavado
    x = rgb.astype(np.float32) / 255.0
    lo, hi = np.percentile(x, 0.5), np.percentile(x, 99.5)
    x = np.clip((x - lo) / max(hi - lo, 1e-3), 0, 1) ** 0.95
    img = Image.fromarray((x * 255).astype(np.uint8).transpose(1, 2, 0))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=86, optimize=True)
    return buf.getvalue(), (W, H), usadas


# ---------------------------------------------------------------------------
# Edificaciones Overture
# ---------------------------------------------------------------------------
def overture(rej: Rejilla):
    import duckdb

    b = rej.bbox_geo(margen=0)
    con = duckdb.connect()
    for ext in ("httpfs", "spatial"):
        con.execute(f"INSTALL {ext}; LOAD {ext};")
    con.execute("SET s3_region='us-west-2';")
    url = f"s3://overturemaps-us-west-2/release/{OVERTURE_RELEASE}/theme=buildings/type=building/*"
    log(f"Overture {OVERTURE_RELEASE}: consultando edificaciones (puede tardar unos minutos)…")
    filas = con.execute(f"""
        SELECT height, num_floors, ST_AsWKB(geometry)
        FROM read_parquet('{url}', hive_partitioning=1)
        WHERE bbox.xmin < {b[2]} AND bbox.xmax > {b[0]}
          AND bbox.ymin < {b[3]} AND bbox.ymax > {b[1]}
    """).fetchall()
    log(f"  {len(filas)} edificaciones")
    return filas


def procesar_edificios(filas, rej: Rejilla, dtm, dsm95):
    from shapely import wkb
    from shapely.geometry import Polygon, box
    from shapely.ops import transform as stransform
    from rasterio.features import rasterize

    marco = box(0, 0, rej.W * CELDA, rej.H * CELDA)
    def fx(x, y, z=None):
        ex, ny = rej.to_utm.transform(x, y)
        return np.asarray(ex) - rej.x0, np.asarray(ny) - rej.y0
    altura_gem = np.where(np.isnan(dsm95), 0, dsm95 - dtm)
    polis, salida = [], []
    for h, pisos, g in filas:
        geom = wkb.loads(bytes(g))
        partes = getattr(geom, "geoms", [geom])
        for p in partes:
            if not isinstance(p, Polygon):
                continue
            p = stransform(fx, p)
            if not p.is_valid:
                p = p.buffer(0)
                if not isinstance(p, Polygon):
                    continue
            if p.area < 12 or not marco.contains(p.representative_point()):
                continue
            p = p.simplify(0.6, preserve_topology=True)
            if not isinstance(p, Polygon) or p.is_empty:
                continue
            # Altura: Overture si existe; si no, GEM-15 (DSM p95 - DTM) en la celda del centroide
            if h is None and pisos:
                h = float(pisos) * 3.0
            fuente = 0
            if h is None:
                c = p.centroid
                i = min(rej.H - 1, max(0, int((rej.H * CELDA - c.y) / CELDA)))
                j = min(rej.W - 1, max(0, int(c.x / CELDA)))
                v = altura_gem[max(0, i - 1):i + 2, max(0, j - 1):j + 2]
                h = float(np.max(v)) if v.size else 0.0
                fuente = 1
            h = float(min(max(h, 3.0), 60.0))
            coords = np.asarray(p.exterior.coords)[:-1]
            if len(coords) < 3:
                continue
            flat = np.round(coords, 1).ravel().tolist()
            salida.append([round(h, 1), fuente] + flat)
            polis.append(p)
    log(f"  {len(salida)} polígonos útiles")

    # Cobertura de edificaciones por celda (supermuestreo 5x5 = 3 m)
    from rasterio.transform import from_origin
    k = 5
    tr = from_origin(0, rej.H * CELDA, CELDA / k, CELDA / k)
    fino = rasterize(((p, 1) for p in polis), out_shape=(rej.H * k, rej.W * k),
                     transform=tr, fill=0, dtype="uint8")
    cob = fino.reshape(rej.H, k, rej.W, k).mean(axis=(1, 3))
    return salida, (cob * 255).round().astype(np.uint8)

# ---------------------------------------------------------------------------
# Calles Overture (tema transportation)
# ---------------------------------------------------------------------------
# nivel: 0 vía principal, 1 secundaria, 2 local, 3 servicio / trocha
NIVEL_VIA = {
    "motorway": 0, "trunk": 0, "primary": 0,
    "secondary": 1, "tertiary": 1,
    "residential": 2, "living_street": 2, "unclassified": 2, "pedestrian": 2,
    "service": 3, "track": 3,
}


def calles(rej: Rejilla):
    """Ejes de vía en coordenadas locales: {"nombres": [...], "c": [[nivel, idx_nombre, x1, y1, ...], ...]}."""
    import duckdb
    from shapely import wkb
    from shapely.geometry import box
    from shapely.ops import transform as stransform

    b = rej.bbox_geo(margen=0)
    con = duckdb.connect()
    for ext in ("httpfs", "spatial"):
        con.execute(f"INSTALL {ext}; LOAD {ext};")
    con.execute("SET s3_region='us-west-2';")
    url = f"s3://overturemaps-us-west-2/release/{OVERTURE_RELEASE}/theme=transportation/type=segment/*"
    log(f"Overture {OVERTURE_RELEASE}: consultando calles…")
    filas = con.execute(f"""
        SELECT class, names.primary, ST_AsWKB(geometry)
        FROM read_parquet('{url}', hive_partitioning=1)
        WHERE subtype = 'road'
          AND bbox.xmin < {b[2]} AND bbox.xmax > {b[0]}
          AND bbox.ymin < {b[3]} AND bbox.ymax > {b[1]}
    """).fetchall()

    def fx(x, y, z=None):
        ex, ny = rej.to_utm.transform(x, y)
        return np.asarray(ex) - rej.x0, np.asarray(ny) - rej.y0

    marco = box(0, 0, rej.W * CELDA, rej.H * CELDA)
    nombres, idx, out, km = [], {}, [], 0.0
    for clase, nombre, g in filas:
        nivel = NIVEL_VIA.get(clase)
        if nivel is None:
            continue
        geom = stransform(fx, wkb.loads(bytes(g))).intersection(marco)
        if geom.is_empty:
            continue
        geom = geom.simplify(1.0)
        if nombre:
            nombre = nombre.strip()
            if nombre not in idx:
                idx[nombre] = len(nombres)
                nombres.append(nombre)
        k = idx[nombre] if nombre else -1
        for ln in getattr(geom, "geoms", [geom]):
            if ln.geom_type != "LineString" or ln.length < 3:
                continue
            km += ln.length / 1000
            out.append([nivel, k] + np.round(np.asarray(ln.coords)[:, :2], 1).ravel().tolist())
    log(f"  {len(out)} tramos, {km:.0f} km de vías, {len(nombres)} nombres")
    return {"nombres": nombres, "c": out}, round(km, 1)


def _rio(cfg, rej: Rejilla):
    if not cfg.get("rio_entrada"):
        return None
    x, y = rej.local(*cfg["rio_entrada"])
    return {"x": round(x, 1), "y": round(y, 1)}


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ciudad", nargs="?", default="piura")
    ap.add_argument("--fuente", choices=["cog", "gee"], default="cog",
                    help="cog: COG públicos de GEM-15 (sin cuenta). gee: Google Earth Engine.")
    ap.add_argument("--proyecto-gee", default=None, help="Proyecto de Google Cloud para Earth Engine")
    ap.add_argument("--sin-edificios", action="store_true")
    ap.add_argument("--solo-calles", action="store_true",
                    help="Sólo agrega/actualiza las calles de una escena ya generada")
    ap.add_argument("--lista", action="store_true", help="Lista las ciudades disponibles")
    a = ap.parse_args()

    if a.lista:
        for k, c in CIUDADES.items():
            print(f"{k:12s} {c['subtitulo']}  ({c['ancho_km']} x {c['alto_km']} km)")
        return
    if a.ciudad not in CIUDADES:
        sys.exit(f"Ciudad desconocida: {a.ciudad}. Usa --lista")

    cfg = CIUDADES[a.ciudad]
    rej = Rejilla(cfg)
    out = SALIDA / a.ciudad
    out.mkdir(parents=True, exist_ok=True)

    if a.solo_calles:
        mp = out / "escena.json"
        if not mp.exists():
            sys.exit(f"Primero genera la escena completa: python preparar_escena.py {a.ciudad}")
        meta = json.loads(mp.read_text(encoding="utf-8"))
        if meta["x0"] != rej.x0 or meta["W"] != rej.W:
            sys.exit("La rejilla de la escena no coincide con la configuración actual")
        cs, km = calles(rej)
        (out / "calles.json").write_text(json.dumps(cs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        meta["km_calles"] = km
        meta["creditos"] = CREDITOS
        mp.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        log(f"Listo -> {out / 'calles.json'}")
        return

    log(f"{cfg['nombre']}: rejilla {rej.W} x {rej.H} celdas de {CELDA:.0f} m, UTM 17S "
        f"x0={rej.x0:.0f} y0={rej.y0:.0f}")

    # 1) Relieve
    dtm, dsm95 = gem15_gee(rej, a.proyecto_gee) if a.fuente == "gee" else gem15_cog(rej)
    if np.isnan(dtm).all():
        sys.exit("GEM-15 no tiene datos para esta zona")
    dtm, agua = rellenar_con_glo30(dtm, rej)

    off = float(-math.floor(dtm.min()) + 5)
    step = 0.01  # 1 cm de resolución vertical
    while (dtm.max() + off) / step > 65000:
        step *= 2
    enc = np.clip(np.round((dtm + off) / step), 0, 65535).astype("<u2")
    (out / "dtm.u16").write_bytes(enc.tobytes())
    (out / "agua.u8").write_bytes(agua.astype(np.uint8).tobytes())
    log(f"Terreno: {dtm.min():.1f} a {dtm.max():.1f} m s.n.m.")

    # 2) Imagen
    jpg, (tw, th), escenas = sentinel2(rej)
    (out / "textura.jpg").write_bytes(jpg)

    # 3) Edificaciones
    n_edif = 0
    if not a.sin_edificios:
        filas = overture(rej)
        edif, cob = procesar_edificios(filas, rej, dtm, dsm95)
        n_edif = len(edif)
        (out / "edificios.json").write_text(json.dumps(edif, separators=(",", ":")))
        (out / "cobertura.u8").write_bytes(cob.tobytes())
    else:
        (out / "cobertura.u8").write_bytes(np.zeros((rej.H, rej.W), np.uint8).tobytes())

    # 4) Calles
    cs, km = calles(rej)
    (out / "calles.json").write_text(json.dumps(cs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # 5) Metadatos
    lon0, lat0, lon1, lat1 = rej.bbox_geo(margen=0)
    vistas = []
    for nombre, lon, lat, dist in cfg["vistas"]:
        x, y = rej.local(lon, lat)
        vistas.append({"nombre": nombre, "x": round(x, 1), "y": round(y, 1), "dist": dist})
    meta = {
        "ciudad": a.ciudad, "nombre": cfg["nombre"], "subtitulo": cfg["subtitulo"],
        "W": rej.W, "H": rej.H, "celda": CELDA, "epsg": EPSG_UTM17S,
        "x0": rej.x0, "y0": rej.y0, "bbox": [lon0, lat0, lon1, lat1],
        "dtm": {"off": off, "step": step}, "zmin": float(dtm.min()), "zmax": float(dtm.max()),
        "textura": {"w": tw, "h": th},
        "agua_pct": round(float(agua.mean() * 100), 2),
        "n_edificios": n_edif, "km_calles": km, "vistas": vistas,
        "rio_entrada": _rio(cfg, rej), "sin_rio": bool(cfg.get("sin_rio")),
        "fuente_relieve": "GEM-15 v1 (" + ("Earth Engine" if a.fuente == "gee" else "COG público") + ")",
        "sentinel2": escenas, "overture": OVERTURE_RELEASE,
        "creditos": CREDITOS,
        "generado": time.strftime("%Y-%m-%d"),
    }
    (out / "escena.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

    # Índice de ciudades disponibles para el visor
    idx_path = SALIDA / "ciudades.json"
    idx = json.loads(idx_path.read_text(encoding="utf-8")) if idx_path.exists() else {}
    idx[a.ciudad] = {"nombre": cfg["nombre"], "subtitulo": cfg["subtitulo"]}
    idx_path.write_text(json.dumps(idx, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"Listo -> {out}")


if __name__ == "__main__":
    main()
