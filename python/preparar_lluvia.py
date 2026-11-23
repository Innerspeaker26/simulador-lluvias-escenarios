"""
Escenarios de lluvia por ciudad para el simulador: curvas IDF de SENAMHI y eventos históricos de PISCOp.

Fuentes:
  * IDF ...... Herramienta IDF de SENAMHI (https://idesep.senamhi.gob.pe/dhi-idf/), servicio WMS:
               dhi:dhi_pp_q (clima actual) y dhi:dhi_pp_med (mediana de 3 modelos al 2050) dan la lluvia de
               24 h por periodo de retorno con su rango (LI, LM, LS); dhi:gpo_regiones_pp da la región, y
               assets/data.json la curva horaria acumulada de cada región. Se replica el ajuste de la
               herramienta: I = k · T^m / D^n (mm/h, T en años, D en horas).
  * PISCOp ... PISCOp v3.0 (SENAMHI, Gutiérrez y Lavado-Casimiro), lluvia diaria 1981-2025 a 0,1°,
               figshare 10.6084/m9.figshare.32411886 (PISCOp_d.nc). Se lee sólo la celda de la ciudad.

Salida: docs/data/<ciudad>/lluvia.json

Uso:
  python preparar_lluvia.py                 # todas las ciudades con escena
  python preparar_lluvia.py piura sullana
"""
from __future__ import annotations

import datetime as dt
import json
import math
import re
import sys
import time
from pathlib import Path

import numpy as np
import requests

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
from preparar_escena import CIUDADES  # noqa: E402

DATOS = AQUI.parent / "docs" / "data"
CACHE = AQUI / "cache"
WMS = "https://idesep.senamhi.gob.pe/geoserver/dhi/wms"
IDF_DATA = "https://idesep.senamhi.gob.pe/dhi-idf/assets/data.json"
PISCO_D = "https://ndownloader.figshare.com/files/71457607"
TRS = [2, 5, 10, 30, 50, 75, 100, 200, 500, 1000]
# Puntos donde la capa IDF no tiene dato en el centro (borde costero): se usa uno tierra adentro
PUNTO_IDF = {"talara": (-81.240, -4.560)}
TEMPORADAS = {"1982-83": 1983, "1997-98": 1998, "2016-17": 2017, "2022-23": 2023}
MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "set", "oct", "nov", "dic"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------- IDF
def consulta(capa, lon, lat):
    p = dict(service="WMS", request="GetFeatureInfo", version="1.1.1", layers=capa, query_layers=capa, srs="EPSG:4326",
             bbox=f"{lon - .01},{lat - .01},{lon + .01},{lat + .01}", width=101, height=101, X=50, Y=50,
             info_format="application/json")
    for intento in range(5):          # el servidor de SENAMHI corta conexiones de vez en cuando
        try:
            f = requests.get(WMS, params=p, timeout=60).json()["features"]
            break
        except (requests.RequestException, ValueError):
            if intento == 4:
                raise
            time.sleep(3 * (intento + 1))
    if not f:
        raise RuntimeError(f"Sin dato IDF en {capa} ({lat}, {lon})")
    return f[0]["properties"]


def ajuste_potencia(x, y):
    lx, ly = np.log(np.asarray(x, float)), np.log(np.asarray(y, float))
    b = (len(lx) * (lx * ly).sum() - lx.sum() * ly.sum()) / (len(lx) * (lx * lx).sum() - lx.sum() ** 2)
    return math.exp((ly.sum() - b * lx.sum()) / len(lx)), b


def parametros(props, frac, banda):
    """Igual que la herramienta de SENAMHI: lluvia de 24 h × curva horaria regional, intensidades medias
    de los bloques más lluviosos para 1-24 h, ajuste potencial por T y luego entre periodos."""
    coef, expo = [], []
    for T in TRS:
        p24 = props[f"{banda}_TR{T}"]
        inc = sorted([frac[0] * p24] + [(frac[i] - frac[i - 1]) * p24 for i in range(1, 24)], reverse=True)
        a, b = ajuste_potencia(range(1, 25), [sum(inc[:i]) / i for i in range(1, 25)])
        coef.append(a); expo.append(b)
    k, m = ajuste_potencia(TRS, coef)
    return {"k": round(k, 5), "m": round(m, 5), "n": round(-float(np.mean(expo)), 5)}


def idf(ciudad, lon, lat, regiones):
    lon, lat = PUNTO_IDF.get(ciudad, (lon, lat))
    reg = consulta("dhi:gpo_regiones_pp", lon, lat)["subregion"]
    frac = regiones[reg]
    out = {"punto": [round(lat, 4), round(lon, 4)], "region": reg, "fracciones_horarias": frac, "parametros": {}, "p24_mm": {}}
    for clima, capa in (("actual", "dhi:dhi_pp_q"), ("2050", "dhi:dhi_pp_med")):
        props = consulta(capa, lon, lat)
        out["parametros"][clima] = {b: parametros(props, frac, c) for b, c in
                                    (("inferior", "LI"), ("medio", "LM"), ("superior", "LS"))}
        out["p24_mm"][clima] = {str(T): [round(props[f"LI_TR{T}"], 1), round(props[f"LM_TR{T}"], 1), round(props[f"LS_TR{T}"], 1)]
                                for T in TRS}
    return out


# ---------------------------------------------------------------- PISCOp
def serie_pisco(ciudad, lon, lat):
    """Lluvia diaria 1981-2025 de la celda de PISCOp más cercana (se guarda en caché)."""
    CACHE.mkdir(exist_ok=True)
    f = CACHE / f"pisco_{ciudad}.npz"
    if f.exists():
        z = np.load(f)
        return z["mm"], float(z["lat"]), float(z["lon"])
    import fsspec, h5py
    log(f"  PISCOp: leyendo la celda de {ciudad} del archivo remoto (unos minutos)…")
    h = h5py.File(fsspec.open(PISCO_D, block_size=4 * 2 ** 20).open(), "r")
    lats, lons = h["latitude"][:], h["longitude"][:]
    i, j = int(np.argmin(abs(lats - lat))), int(np.argmin(abs(lons - lon)))
    mm = h["precipitation"][:, i, j].astype(float)
    mm[mm < -1e30] = np.nan
    np.savez(f, mm=mm, lat=lats[i], lon=lons[j])
    return mm, float(lats[i]), float(lons[j])


def etiqueta_fecha(f0, f1):
    if f0 == f1:
        return f"{f0.day} {MESES[f0.month - 1]} {f0.year}"
    if f0.month == f1.month:
        return f"{f0.day}–{f1.day} {MESES[f0.month - 1]} {f0.year}"
    return f"{f0.day} {MESES[f0.month - 1]}–{f1.day} {MESES[f1.month - 1]} {f1.year}"


def eventos(mm):
    fechas = [dt.date(1981, 1, 1) + dt.timedelta(days=k) for k in range(len(mm))]
    idx = {f: k for k, f in enumerate(fechas)}
    out = []
    for temp, a in TEMPORADAS.items():
        k0, k1 = idx[dt.date(a - 1, 12, 1)], idx[dt.date(a, 5, 31)]
        s3 = [np.nansum(mm[k:k + 3]) for k in range(k0, k1 - 1)]
        k = k0 + int(np.argmax(s3))
        dias = [{"fecha": fechas[k + d].isoformat(), "mm": round(float(mm[k + d]), 1)} for d in range(3)]
        out.append({"id": f"nino-{temp}", "nombre": f"El Niño {temp.replace('-', '‑')}", "periodo": etiqueta_fecha(fechas[k], fechas[k + 2]),
                    "dias": dias, "total_mm": round(sum(d["mm"] for d in dias), 1), "max_dia_mm": max(d["mm"] for d in dias)})
    k = int(np.nanargmax(mm))
    if not any(e["dias"][0]["fecha"] <= fechas[k].isoformat() <= e["dias"][-1]["fecha"] for e in out):
        out.append({"id": "dia-record", "nombre": "Día récord 1981–2025", "periodo": etiqueta_fecha(fechas[k], fechas[k]),
                    "dias": [{"fecha": fechas[k].isoformat(), "mm": round(float(mm[k]), 1)}],
                    "total_mm": round(float(mm[k]), 1), "max_dia_mm": round(float(mm[k]), 1)})
    anios = np.array([f.year for f in fechas])
    normal = float(np.median([np.nansum(mm[anios == a]) for a in range(1981, 2026)]))
    return out, round(normal), (max(out, key=lambda e: e["max_dia_mm"]))


def main():
    pedidas = sys.argv[1:] or [p.name for p in DATOS.iterdir() if (p / "escena.json").exists()]
    regiones = json.loads(re.search(r"datos_regiones='(.*)'", requests.get(IDF_DATA, timeout=60).text, re.S).group(1))
    for c in pedidas:
        cfg = CIUDADES[c]
        lon, lat = cfg["centro"]
        meta = json.loads((DATOS / c / "escena.json").read_text(encoding="utf-8"))
        log(f"{cfg['nombre']}")
        datos_idf = idf(c, lon, lat, regiones)
        mm, plat, plon = serie_pisco(c, lon, lat)
        evs, normal, _ = eventos(mm)
        res = {
            "ciudad": cfg["nombre"],
            "area_km2": round(meta["W"] * meta["H"] * meta["celda"] ** 2 / 1e6, 1),
            "idf": datos_idf,
            "pisco": {"celda": [round(plat, 3), round(plon, 3)], "normal_anual_mm": normal, "eventos": evs},
            "fuentes": {
                "idf": "Curvas IDF de SENAMHI (idesep.senamhi.gob.pe/dhi-idf); ajuste I = k·T^m/D^n replicado de la herramienta",
                "pisco": "PISCOp v3.0, SENAMHI (doi:10.6084/m9.figshare.32411886), lluvia diaria 0,1°",
            },
            "generado": time.strftime("%Y-%m-%d"),
        }
        (DATOS / c / "lluvia.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
        p = datos_idf["parametros"]["actual"]["medio"]
        log(f"  región {datos_idf['region']} · I(100 años, 1 h) = {p['k'] * 100 ** p['m']:.0f} mm/h · "
            f"{len(evs)} eventos PISCOp · año normal {normal} mm")


if __name__ == "__main__":
    main()
