// Calles (Overture transportation): capa dibujada sobre el terreno, longitud de vía por celda
// para medir calles anegadas, búsqueda por nombre y calle más cercana a un punto.
import * as THREE from 'three';

// nivel: 0 vía principal, 1 secundaria, 2 local, 3 servicio / trocha
const ESTILO = [
  { ancho: 15, color: '#ffc861' },
  { ancho: 11, color: '#fff1c7' },
  { ancho: 7, color: '#ffffff' },
  { ancho: 4.5, color: '#ececec' },
];
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export class Calles {
  /**
   * @param {{nombres: string[], c: number[][]}} datos  tramos [nivel, idxNombre, x1, y1, …] en m locales (y hacia el norte)
   * @param {object} meta  escena.json
   */
  constructor(datos, meta, renderer) {
    this.nombres = datos.nombres; this.c = datos.c;
    const W = (this.W = meta.W), H = (this.H = meta.H), C = (this.C = meta.celda);
    this.Wm = W * C; this.Hm = H * C;

    // 1) Capa raster (≈ 4-5 m por píxel), fila 0 = norte como el resto de texturas
    const esc = Math.min(4096 / this.Wm, 4096 / this.Hm, 0.25);
    const cv = document.createElement('canvas');
    cv.width = Math.round(this.Wm * esc); cv.height = Math.round(this.Hm * esc);
    const ctx = cv.getContext('2d');
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let nivel = 3; nivel >= 0; nivel--) {
      ctx.strokeStyle = ESTILO[nivel].color;
      ctx.lineWidth = Math.max(1, ESTILO[nivel].ancho * esc);
      ctx.beginPath();
      for (const t of this.c) {
        if (t[0] !== nivel) continue;
        ctx.moveTo(t[2] * esc, (this.Hm - t[3]) * esc);
        for (let j = 4; j < t.length; j += 2) ctx.lineTo(t[j] * esc, (this.Hm - t[j + 1]) * esc);
      }
      ctx.stroke();
    }
    this.textura = new THREE.CanvasTexture(cv);
    Object.assign(this.textura, { flipY: false, colorSpace: THREE.NoColorSpace, anisotropy: renderer.capabilities.getMaxAnisotropy() });

    // 2) Longitud de vía por celda y tramo más importante de cada celda
    this.longitud = new Float32Array(W * H);
    this.tramoCelda = new Int32Array(W * H).fill(-1);
    this.porNombre = new Map();
    this.km = 0;
    this.c.forEach((t, k) => {
      this.recorrer(k, 3, (xe, ys, l) => {
        const i = this.celda(xe, ys);
        if (i < 0) return;
        this.longitud[i] += l; this.km += l / 1000;
        const p = this.tramoCelda[i];
        if (p < 0 || this.c[p][0] > t[0] || (this.c[p][1] < 0 && t[1] >= 0)) this.tramoCelda[i] = k;
      });
      if (t[1] >= 0) {
        const n = this.nombres[t[1]];
        if (!this.porNombre.has(n)) this.porNombre.set(n, []);
        this.porNombre.get(n).push(k);
      }
    });
    this.indice = [...this.porNombre.keys()].map((n) => [norm(n), n]);
  }

  celda(xe, ys) {
    const c = Math.floor(xe / this.C), r = Math.floor(ys / this.C);
    return c < 0 || r < 0 || c >= this.W || r >= this.H ? -1 : r * this.W + c;
  }

  /** Recorre el tramo k cada `paso` m llamando fn(xe, ys, longitud) en coordenadas de rejilla (ys hacia el sur). */
  recorrer(k, paso, fn) {
    const t = this.c[k];
    for (let j = 2; j + 3 < t.length; j += 2) {
      const x0 = t[j], y0 = this.Hm - t[j + 1], x1 = t[j + 2], y1 = this.Hm - t[j + 3];
      const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.round(L / paso)), l = L / n;
      for (let s = 0; s < n; s++) { const f = (s + 0.5) / n; fn(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, l); }
    }
  }

  /** Calle más cercana (≤ ~50 m) a un punto: {nombre, tipo} o null. */
  cercana(xe, ys) {
    const c0 = Math.floor(xe / this.C), r0 = Math.floor(ys / this.C);
    let mejor = null, dmin = 1e9;
    for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
      const c = c0 + dc, r = r0 + dr;
      if (c < 0 || r < 0 || c >= this.W || r >= this.H) continue;
      const k = this.tramoCelda[r * this.W + c];
      if (k < 0) continue;
      const d = Math.hypot(dr, dc) + (this.c[k][1] < 0 ? 2.5 : 0);   // preferir vías con nombre
      if (d < dmin) { dmin = d; mejor = k; }
    }
    if (mejor === null) return null;
    const t = this.c[mejor];
    return { nombre: t[1] >= 0 ? this.nombres[t[1]] : null, nivel: t[0] };
  }

  /** Nombres que contienen el texto (sin tildes ni mayúsculas). */
  buscar(texto, max = 8) {
    const q = norm(texto);
    if (q.length < 2) return [];
    const empieza = [], contiene = [];
    for (const [k, n] of this.indice) {
      if (k.startsWith(q) || k.includes(' ' + q)) empieza.push(n); else if (k.includes(q)) contiene.push(n);
    }
    const corto = (x, y) => x.length - y.length;
    return [...empieza.sort(corto), ...contiene.sort(corto)].slice(0, max);
  }

  /** Punto medio del tramo más largo de una calle: {xe, ys}. */
  ubicar(nombre) {
    const ks = this.porNombre.get(nombre);
    if (!ks) return null;
    let mejor = null, lmax = -1;
    for (const k of ks) {
      const pts = [];
      this.recorrer(k, 10, (xe, ys) => pts.push([xe, ys]));
      if (pts.length > lmax) { lmax = pts.length; mejor = pts[pts.length >> 1]; }
    }
    return mejor ? { xe: mejor[0], ys: mejor[1] } : null;
  }

  /** Calles con más longitud bajo agua (> umbral m). d: Float32Array W*H de tirantes. */
  afectadas(d, umbral = 0.3, max = 10) {
    const acc = new Map();
    this.c.forEach((t, k) => {
      if (t[1] < 0) return;
      const n = this.nombres[t[1]];
      this.recorrer(k, 5, (xe, ys, l) => {
        const i = this.celda(xe, ys);
        if (i < 0 || d[i] <= umbral) return;
        let a = acc.get(n);
        if (!a) acc.set(n, (a = { nombre: n, km: 0, dmax: 0, xe, ys, nivel: t[0] }));
        a.km += l / 1000;
        if (d[i] > a.dmax) { a.dmax = d[i]; a.xe = xe; a.ys = ys; }
      });
    });
    return [...acc.values()].sort((p, q) => q.km - p.km).slice(0, max);
  }
}

export const TIPO_VIA = ['vía principal', 'vía secundaria', 'calle local', 'servicio / trocha'];
