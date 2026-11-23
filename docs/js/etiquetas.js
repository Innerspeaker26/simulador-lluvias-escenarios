// Nombres de calles acostados sobre el terreno, orientados con la vía (como en un mapa).
// - Candidatos fijos: tramos rectos lo bastante largos para el texto, espaciados por calle.
// - Cada ~150 ms: se muestran según la distancia a la cámara (avenidas primero), sin solaparse
//   en pantalla y siempre legibles (nunca al revés).
import * as THREE from 'three';
import { Text } from 'troika-three-text';

const FUENTE = 'https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-sans@5.1.1/files/ibm-plex-sans-latin-600-normal.woff';
// por nivel de vía: alto del texto en pantalla (px), distancia máx. de cámara (m), separación entre repeticiones (m)
// El texto mantiene un tamaño constante en pantalla, como en los mapas web.
const NIVEL = [
  { px: 15, dist: 9000, sep: 700 },
  { px: 14, dist: 5500, sep: 520 },
  { px: 12.5, dist: 3200, sep: 380 },
];
const BASE = 10;            // tamaño de letra de la malla (m); se escala en cada actualización
const MAX_VISIBLES = 220;
const ANCHO_LETRA = 0.62;   // ancho medio de un carácter en mayúsculas, en "em"

export class Etiquetas {
  /** ctx: { calles, zEn(xe, ys), Wm, Hm, exag(), camera, canvas } */
  constructor(ctx) {
    Object.assign(this, ctx);
    this.grupo = new THREE.Group();
    this.grupo.renderOrder = 6;
    this.visible = true;
    this.cand = this._candidatos();
    this.t = 0; this.mat = new THREE.Matrix4();
  }

  _candidatos() {
    const { calles } = this, porNombre = new Map();
    calles.c.forEach((t) => {
      if (t[1] < 0 || t[0] > 2) return;                       // sin nombre o servicio / trocha
      const nombre = calles.nombres[t[1]];
      const txt = nombre.toLocaleUpperCase('es');
      for (let j = 2; j + 3 < t.length; j += 2) {
        const x0 = t[j], y0 = this.Hm - t[j + 1], x1 = t[j + 2], y1 = this.Hm - t[j + 3];
        const L = Math.hypot(x1 - x0, y1 - y0);
        if (L < 45) continue;                                  // tramo demasiado corto para orientar el texto
        const c = { nombre, txt, nivel: t[0], xe: (x0 + x1) / 2, ys: (y0 + y1) / 2, dx: (x1 - x0) / L, dy: (y1 - y0) / L, L, obj: null };
        if (!porNombre.has(nombre)) porNombre.set(nombre, []);
        porNombre.get(nombre).push(c);
      }
    });
    // Por calle: tramos más largos primero, separados al menos `sep` metros
    const out = [];
    for (const lista of porNombre.values()) {
      lista.sort((a, b) => b.L - a.L);
      const ok = [];
      for (const c of lista) {
        const sep = NIVEL[c.nivel].sep;
        if (ok.every((o) => Math.hypot(o.xe - c.xe, o.ys - c.ys) > sep)) ok.push(c);
      }
      out.push(...ok);
    }
    return out;
  }

  _crear(c) {
    const t = new Text();
    Object.assign(t, {
      text: c.txt, font: FUENTE, fontSize: BASE, anchorX: 'center', anchorY: 'middle',
      color: c.nivel === 0 ? 0x5a3b10 : 0x26313b, outlineWidth: '14%', outlineColor: 0xffffff, outlineOpacity: 0.92,
      letterSpacing: 0.04,
    });
    // como en un mapa: los nombres se dibujan siempre encima de edificios y agua
    t.material.depthWrite = false; t.material.depthTest = false;
    t.renderOrder = 30;
    t.rotation.order = 'YXZ';
    t.sync();
    this.grupo.add(t);
    c.obj = t;
    return t;
  }

  /** Llamar en cada cuadro; recalcula como máximo cada 150 ms o cuando la cámara se mueve. */
  actualizar(dt) {
    if (!this.visible) { this.grupo.visible = false; return; }
    this.grupo.visible = true;
    this.t += dt;
    const cam = this.camera;
    const movio = !this.mat.equals(cam.matrixWorld);
    if (!movio && this.t < 1) return;
    if (this.t < 0.15 && movio) return;
    this.t = 0; this.mat.copy(cam.matrixWorld);

    const ex = this.exag(), W2 = this.Wm / 2, H2 = this.Hm / 2;
    const derecha = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const v = new THREE.Vector3(), p = new THREE.Vector3();
    const kpx = 2 * Math.tan((cam.fov * Math.PI) / 360) / h;   // metros por píxel = d · kpx

    // 1) candidatos cercanos y dentro de la vista
    const vivos = [];
    for (const c of this.cand) {
      p.set(c.xe - W2, this.zEn(c.xe, c.ys) * ex + 2, c.ys - H2);
      const d = p.distanceTo(cam.position);
      if (d > NIVEL[c.nivel].dist) { if (c.obj) c.obj.visible = false; continue; }
      v.copy(p).project(cam);
      if (v.z > 1 || Math.abs(v.x) > 1.15 || Math.abs(v.y) > 1.15) { if (c.obj) c.obj.visible = false; continue; }
      c.p = p.clone(); c.d = d; c.tam = NIVEL[c.nivel].px * d * kpx; vivos.push(c);
    }
    // 2) prioridad: tipo de vía y cercanía; 3) sin solaparse en pantalla
    vivos.sort((a, b) => a.nivel - b.nivel || a.d - b.d);
    const cajas = [];
    let n = 0;
    for (const c of vivos) {
      let mostrar = n < MAX_VISIBLES;
      if (mostrar) {
        const largo = c.txt.length * ANCHO_LETRA * c.tam * 1.1;
        const hx = c.dx * largo / 2, hz = c.dy * largo / 2, t2 = c.tam * 0.7;
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          v.set(c.p.x + a * hx - b * c.dy * t2, c.p.y, c.p.z + a * hz + b * c.dx * t2).project(cam);
          const sx = (v.x + 1) * w / 2, sy = (1 - v.y) * h / 2;
          x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
        }
        if (cajas.some((k) => x0 < k[2] + 4 && x1 > k[0] - 4 && y0 < k[3] + 4 && y1 > k[1] - 4)) mostrar = false;
        if (mostrar) cajas.push([x0, y0, x1, y1]);
      }
      if (!mostrar) { if (c.obj) c.obj.visible = false; continue; }
      const t = c.obj || this._crear(c);
      t.visible = true; n++;
      t.position.copy(c.p);
      t.scale.setScalar(c.tam / BASE);
      // ángulo de la vía; se gira 180° si quedaría al revés para la cámara
      let th = Math.atan2(-c.dy, c.dx);
      if (Math.cos(th) * derecha.x - Math.sin(th) * derecha.z < 0) th += Math.PI;
      t.rotation.set(-Math.PI / 2, th, 0);
    }
  }
}
