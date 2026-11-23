// Pines de ubicación: marcador 3D, coordenadas geográficas y UTM, tirante en el tiempo,
// exportación (CSV / GeoJSON) y enlace compartible (?pin=lat,lon;lat,lon).
import * as THREE from 'three';
import { aUTM, deUTM } from './utm.js';

const fmt = (v, d = 0) => v.toLocaleString('es-PE', { minimumFractionDigits: d, maximumFractionDigits: d });
const MAX_MUESTRAS = 400;

function texturaPin(n) {
  const cv = document.createElement('canvas'); cv.width = 96; cv.height = 128;
  const g = cv.getContext('2d');
  g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 8; g.shadowOffsetY = 3;
  g.fillStyle = '#e5483b';
  g.beginPath(); g.arc(48, 44, 36, Math.PI * 0.82, Math.PI * 2.18); g.lineTo(48, 122); g.closePath(); g.fill();
  g.shadowColor = 'transparent';
  g.fillStyle = '#fff'; g.beginPath(); g.arc(48, 44, 24, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#16212b'; g.font = '600 30px IBM Plex Sans, system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(n), 48, 46);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function bajar(txt, nombre, tipo = 'text/plain') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: tipo }));
  a.download = nombre; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export class Pines {
  /**
   * ctx: { scene, meta, ciudad, z, zEn(xe,ys), hidro, calles, exag(), irA(xe, ys, dist), lista: HTMLElement, aviso(texto) }
   */
  constructor(ctx) {
    Object.assign(this, ctx);
    const m = this.meta;
    this.Wm = m.W * m.celda; this.Hm = m.H * m.celda;
    this.pines = [];
  }

  // ---- Coordenadas ----------------------------------------------------------
  /** rejilla (xe hacia el este, ys hacia el sur) -> {lat, lon, E, N} */
  coords(xe, ys) {
    const E = this.meta.x0 + xe, N = this.meta.y0 + (this.Hm - ys);
    return { ...deUTM(E, N, this.meta.epsg), E, N };
  }
  /** lat/lon -> rejilla, o null si cae fuera de la escena */
  desdeGeo(lat, lon) { const u = aUTM(lat, lon, this.meta.epsg); return this.desdeUTM(u.E, u.N); }
  desdeUTM(E, N) {
    const xe = E - this.meta.x0, ys = this.Hm - (N - this.meta.y0);
    return xe >= 0 && ys >= 0 && xe < this.Wm && ys < this.Hm ? { xe, ys } : null;
  }
  celda(xe, ys) {
    const C = this.meta.celda;
    const c = Math.min(this.meta.W - 1, Math.floor(xe / C)), r = Math.min(this.meta.H - 1, Math.floor(ys / C));
    return { c, r, i: r * this.meta.W + c };
  }

  /** Texto de calle cercana */
  calle(xe, ys) {
    const k = this.calles && this.calles.cercana(xe, ys);
    return k ? (k.nombre || 'vía sin nombre') : '';
  }

  // ---- Alta / baja -----------------------------------------------------------
  agregar(xe, ys) {
    const id = this.pines.length + 1;                        // numeración siempre correlativa
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: texturaPin(id), depthTest: false, depthWrite: false, sizeAttenuation: false }));
    spr.center.set(0.5, 0); spr.scale.set(0.03, 0.04, 1); spr.renderOrder = 20;
    this.scene.add(spr);
    const p = { id, xe, ys, spr, t: [], d: [], calle: this.calle(xe, ys), abierto: true, ...this.coords(xe, ys) };
    for (const q of this.pines) q.abierto = false;           // el nuevo se abre; los anteriores se pliegan
    this.pines.push(p);
    this.render(); this.posicionar(); this.sincronizarURL();
    return p;
  }
  quitar(id) {
    const k = this.pines.findIndex((p) => p.id === id);
    if (k < 0) return;
    const p = this.pines[k];
    this.scene.remove(p.spr); p.spr.material.map.dispose(); p.spr.material.dispose();
    this.pines.splice(k, 1);
    // Renumerar 1, 2, 3… (y redibujar el número en el marcador 3D de los que cambian)
    this.pines.forEach((q, j) => {
      if (q.id === j + 1) return;
      q.id = j + 1;
      q.spr.material.map.dispose();
      q.spr.material.map = texturaPin(q.id);
      q.spr.material.needsUpdate = true;
    });
    this.render(); this.sincronizarURL();
  }
  limpiar() { for (const p of [...this.pines]) this.quitar(p.id); }

  // ---- Actualización -------------------------------------------------------------
  /** Cada cuadro: sigue la exageración vertical y el nivel del agua */
  posicionar() {
    const ex = this.exag();
    for (const p of this.pines) {
      p.spr.position.set(p.xe - this.Wm / 2, (this.zEn(p.xe, p.ys) + (p.dAct > 0.02 ? p.dAct : 0)) * ex, p.ys - this.Hm / 2);
    }
  }
  /** Cada ~0,3 s: lee el tirante y, si la simulación avanza, guarda la serie */
  actualizar(tSim, registrar) {
    for (const p of this.pines) {
      const { c, r } = this.celda(p.xe, p.ys);
      const w = this.hidro.celda(c, r);
      p.dAct = w.d; p.dMax = w.dmax;
      if (registrar && (!p.t.length || tSim > p.t[p.t.length - 1])) {
        p.t.push(tSim); p.d.push(w.d);
        if (p.t.length > MAX_MUESTRAS) { p.t = p.t.filter((_, j) => j % 2 === 0); p.d = p.d.filter((_, j) => j % 2 === 0); }
      }
      if (p.el) {
        p.el.querySelector('[data-v=dh]').textContent = `${fmt(w.d, 2)} m`;
        p.el.querySelector('[data-v=dh]').classList.toggle('mojado', w.d >= 0.1);
        p.el.querySelector('[data-v=d]').textContent = `${fmt(w.d, 2)} m`;
        p.el.querySelector('[data-v=dmax]').textContent = `${fmt(w.dmax, 2)} m`;
        this.dibujar(p);
      }
    }
  }
  reiniciarSeries() { for (const p of this.pines) { p.t = []; p.d = []; } }

  dibujar(p) {
    const cv = p.el.querySelector('canvas'), g = cv.getContext('2d'), w = cv.width, h = cv.height;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#d5dde1'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, h - 0.5); g.lineTo(w, h - 0.5); g.stroke();
    if (p.t.length < 2) {
      g.fillStyle = '#8a98a2'; g.font = '20px IBM Plex Sans, sans-serif'; g.fillText('Esperando datos de la simulación…', 8, h / 2 + 6); return;
    }
    const t0 = p.t[0], tmax = Math.max(p.t[p.t.length - 1], t0 + 1), dmax = Math.max(0.1, ...p.d) * 1.15;
    const X = (t) => ((t - t0) / (tmax - t0)) * (w - 2) + 1, Y = (d) => h - 2 - (d / dmax) * (h - 24);
    g.beginPath(); g.moveTo(X(p.t[0]), h);
    for (let j = 0; j < p.t.length; j++) g.lineTo(X(p.t[j]), Y(p.d[j]));
    g.lineTo(X(p.t[p.t.length - 1]), h); g.closePath();
    g.fillStyle = 'rgba(27,110,224,.18)'; g.fill();
    g.beginPath(); for (let j = 0; j < p.t.length; j++) g[j ? 'lineTo' : 'moveTo'](X(p.t[j]), Y(p.d[j]));
    g.strokeStyle = '#1b6ee0'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#566570'; g.font = '19px IBM Plex Mono, monospace';
    g.fillText(`${fmt(Math.max(...p.d), 2)} m`, 6, 18);
    g.textAlign = 'right'; g.fillText(`${fmt(t0 / 3600, 1)}–${fmt(tmax / 3600, 1)} h`, w - 6, 18); g.textAlign = 'left';
  }

  // ---- Lista en el panel -------------------------------------------------------
  render() {
    const L = this.lista; L.innerHTML = '';
    if (this.alCambiar) this.alCambiar(this.pines.length);
    if (!this.pines.length) {
      L.innerHTML = '<p class="vacio">Haz clic en el terreno y pulsa «Fijar pin», o escribe coordenadas arriba.</p>';
      return;
    }
    for (const p of this.pines) {
      const cota = this.z[this.celda(p.xe, p.ys).i];
      const el = document.createElement('div'); el.className = 'pin' + (p.abierto ? ' abierto' : '');
      el.innerHTML = `
        <button class="pin-h" aria-expanded="${p.abierto}" title="Mostrar u ocultar el detalle">
          <span class="pin-n">${p.id}</span><b>${p.calle || '—'}</b>
          <span class="pin-d" data-v="dh">–</span><span class="pin-flecha" aria-hidden="true">▾</span></button>
        <div class="pin-b">
          <div class="mono">${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</div>
          <div class="mono">UTM 17S ${fmt(p.E, 0)} E · ${fmt(p.N, 0)} N</div>
          <div class="pin-g"><div><span>Cota</span><b>${fmt(cota, 1)} m</b></div><div><span>Agua</span><b data-v="d">–</b></div><div><span>Máximo</span><b data-v="dmax">–</b></div></div>
          <canvas width="520" height="96" aria-label="Tirante en el tiempo en el pin ${p.id}"></canvas>
          <div class="pin-a">
            <button class="mini" data-a="ir" title="Ir al pin">Ir al pin</button>
            <button class="mini" data-a="copiar" title="Copiar coordenadas (lat/lon y UTM)">Copiar</button>
            <button class="mini" data-a="x" title="Quitar pin" aria-label="Quitar pin ${p.id}">Quitar</button>
          </div>
        </div>`;
      el.querySelector('.pin-h').onclick = () => {
        p.abierto = !p.abierto;
        el.classList.toggle('abierto', p.abierto);
        el.querySelector('.pin-h').setAttribute('aria-expanded', p.abierto);
        if (p.abierto) this.dibujar(p);
      };
      el.querySelector('[data-a=ir]').onclick = () => this.irA(p.xe, p.ys, 900);
      el.querySelector('[data-a=x]').onclick = () => this.quitar(p.id);
      el.querySelector('[data-a=copiar]').onclick = (e) => {
        const txt = `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}\nUTM 17S: ${p.E.toFixed(1)} E, ${p.N.toFixed(1)} N`;
        navigator.clipboard?.writeText(txt).then(() => { e.target.textContent = '¡Copiado!'; setTimeout(() => (e.target.textContent = 'Copiar'), 1200); });
      };
      p.el = el; L.appendChild(el); this.dibujar(p);
    }
  }

  // ---- Enlace y exportación ----------------------------------------------------------
  parametro() { return this.pines.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(';'); }
  enlace() {
    const u = new URL(location.href); u.search = '';
    u.searchParams.set('ciudad', this.ciudad);
    if (this.pines.length) u.searchParams.set('pin', this.parametro());
    return u.toString();
  }
  sincronizarURL() { try { history.replaceState(null, '', this.enlace()); } catch { /* vista previa sin historial */ } }
  desdeURL(valor) {
    let n = 0;
    for (const par of (valor || '').split(';')) {
      const [la, lo] = par.split(',').map(Number);
      if (!isFinite(la) || !isFinite(lo)) continue;
      const g = this.desdeGeo(la, lo);
      if (g) { this.agregar(g.xe, g.ys); n++; }
    }
    return n;
  }

  filas() {
    return this.pines.map((p) => ({
      id: p.id, lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), este: +p.E.toFixed(1), norte: +p.N.toFixed(1),
      cota_m: +this.z[this.celda(p.xe, p.ys).i].toFixed(2), tirante_m: +(p.dAct || 0).toFixed(3),
      tirante_max_m: +(p.dMax || 0).toFixed(3), calle: p.calle || '',
    }));
  }
  exportarCSV() {
    const f = this.filas(); if (!f.length) return this.aviso('No hay pines para exportar');
    const cab = Object.keys(f[0]);
    const txt = [cab.join(','), ...f.map((r) => cab.map((k) => (typeof r[k] === 'string' ? `"${r[k].replace(/"/g, '""')}"` : r[k])).join(','))].join('\n');
    bajar('﻿' + txt, `pines_${this.ciudad}.csv`, 'text/csv');
  }
  exportarGeoJSON() {
    const f = this.filas(); if (!f.length) return this.aviso('No hay pines para exportar');
    const gj = { type: 'FeatureCollection', features: f.map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: r })) };
    bajar(JSON.stringify(gj, null, 1), `pines_${this.ciudad}.geojson`, 'application/geo+json');
  }
  exportarSerie() {
    if (!this.pines.some((p) => p.t.length)) return this.aviso('Aún no hay serie temporal: deja correr la simulación');
    const filas = ['pin,calle,tiempo_h,tirante_m'];
    for (const p of this.pines) p.t.forEach((t, j) => filas.push(`${p.id},"${(p.calle || '').replace(/"/g, '""')}",${(t / 3600).toFixed(4)},${p.d[j].toFixed(4)}`));
    bajar('﻿' + filas.join('\n'), `serie_tirante_${this.ciudad}.csv`, 'text/csv');
  }
}
