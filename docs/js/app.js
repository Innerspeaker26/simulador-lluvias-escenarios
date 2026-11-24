// Simulador de lluvias 3D – costa norte del Perú.
// Relieve GEM-15 (15 m) + Sentinel-2 + edificaciones Overture, con un modelo hidrodinámico 2D en GPU.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Hidro } from './hidro.js';
import { Escorrentia, Lluvia3D } from './efectos.js';
import { Calles, TIPO_VIA } from './calles.js';
import { Pines } from './pines.js';
import * as ESC from './escenarios.js';

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 0) => v.toLocaleString('es-PE', { minimumFractionDigits: d, maximumFractionDigits: d });
const carga = (t) => { $('cargaTxt').textContent = t; };

const UMBRAL_OBST = 0.6 * 255;   // celda bloqueada si ≥ 60 % está construida
const ALTO_OBST = 8;             // m que se suman al terreno en celdas bloqueadas

// ---------------------------------------------------------------------------
// Carga de datos
// ---------------------------------------------------------------------------
const ciudad = new URLSearchParams(location.search).get('ciudad') || 'piura';
const base = `data/${ciudad}/`;

async function bin(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}

async function cargar() {
  carga('Cargando metadatos…');
  const meta = await (await fetch(base + 'escena.json')).json();
  carga('Cargando relieve GEM-15…');
  const [dtmB, aguaB, cobB] = await Promise.all([bin(base + 'dtm.u16'), bin(base + 'agua.u8'), bin(base + 'cobertura.u8')]);
  carga(`Cargando ${fmt(meta.n_edificios)} edificaciones…`);
  const edif = meta.n_edificios ? await (await fetch(base + 'edificios.json')).json() : [];
  carga('Cargando calles…');
  const calles = await fetch(base + 'calles.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const lluvia = await fetch(base + 'lluvia.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  carga('Cargando imagen Sentinel-2…');
  const img = new Image();
  await new Promise((ok, mal) => { img.onload = ok; img.onerror = () => mal(new Error('textura.jpg')); img.src = base + 'textura.jpg'; });
  return { meta, dtmB, aguaB, cobB, edif, img, calles, lluvia };
}

function poblarCiudades() {
  fetch('data/ciudades.json').then((r) => r.json()).then((idx) => {
    const s = $('sCiudad');
    for (const [k, v] of Object.entries(idx)) {
      const o = document.createElement('option'); o.value = k; o.textContent = v.nombre; o.selected = k === ciudad; s.appendChild(o);
    }
    s.hidden = s.options.length < 2;
    s.addEventListener('change', () => { location.search = '?ciudad=' + s.value; });
  }).catch(() => { $('sCiudad').hidden = true; });
}

// ---------------------------------------------------------------------------
async function main() {
  poblarCiudades();
  let datos;
  try { datos = await cargar(); } catch (e) {
    const c = $('cargando'); c.classList.add('error');
    carga(`No se pudo cargar la escena "${ciudad}".\n${e.message}\n\nSirve la carpeta web con un servidor local (python -m http.server) ` +
      `y genera los datos con python/preparar_escena.py ${ciudad}.`);
    throw e;
  }
  const { meta, dtmB, aguaB, cobB, edif, img } = datos;
  const params = new URLSearchParams(location.search);
  const W = meta.W, H = meta.H, C = meta.celda, Wm = W * C, Hm = H * C, N = W * H;

  // Textos
  document.title = `${meta.nombre} bajo la lluvia – Simulador 3D`;
  $('tCiudad').textContent = `${meta.nombre} bajo la lluvia`;
  $('tSub').textContent = meta.subtitulo;
  $('nb').textContent = fmt(meta.n_edificios);
  $('zr').textContent = `${Math.round(meta.zmin)} a ${Math.round(meta.zmax)} m s.n.m.`;
  $('cred').textContent = meta.creditos;

  // Rejillas
  const u16 = new Uint16Array(dtmB), z = new Float32Array(N);
  for (let i = 0; i < N; i++) z[i] = u16[i] * meta.dtm.step - meta.dtm.off;
  const agua = new Uint8Array(aguaB), cob = new Uint8Array(cobB);

  // Coordenadas: xe hacia el este y ys hacia el sur, en metros desde la esquina NO.
  // Mundo 3D: X = xe - Wm/2, Z = ys - Hm/2, Y arriba.
  function zEn(xe, ys) {
    const c = Math.min(Math.max(xe / C - 0.5, 0), W - 1.001), r = Math.min(Math.max(ys / C - 0.5, 0), H - 1.001);
    const c0 = c | 0, r0 = r | 0, fc = c - c0, fr = r - r0, i = r0 * W + c0;
    return (z[i] * (1 - fc) + z[i + 1] * fc) * (1 - fr) + (z[i + W] * (1 - fc) + z[i + W + 1] * fc) * fr;
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const canvas = $('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  if (!renderer.capabilities.isWebGL2 || !renderer.extensions.has('EXT_color_buffer_float')) {
    const c = $('cargando'); c.classList.add('error');
    carga('Este navegador no admite WebGL2 con texturas de punto flotante, necesarias para la simulación.');
    return;
  }
  const CIELO = new THREE.Color(0xc9d1d0), TORMENTA = new THREE.Color(0x98a2a8), fondo = CIELO.clone();
  const scene = new THREE.Scene();
  scene.background = fondo;
  const camera = new THREE.PerspectiveCamera(38, 1, 20, 120000);
  const controls = new OrbitControls(camera, canvas);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, maxPolarAngle: 1.48, minDistance: 120, maxDistance: 45000, screenSpacePanning: false });

  // Texturas base
  const tex = new THREE.Texture(img);
  Object.assign(tex, { colorSpace: THREE.NoColorSpace, flipY: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, anisotropy: renderer.capabilities.getMaxAnisotropy(), needsUpdate: true });
  const zTex = new THREE.DataTexture(z, W, H, THREE.RedFormat, THREE.FloatType);
  zTex.minFilter = zTex.magFilter = THREE.NearestFilter; zTex.needsUpdate = true;

  // Hidráulica
  const hidro = new Hidro(renderer, W, H, C);

  // Gradiente del relieve suavizado (para las gotas en terreno seco) + obstáculos
  const gradArr = new Float32Array(N * 4);
  const gradTex = new THREE.DataTexture(gradArr, W, H, THREE.RGBAFormat, THREE.FloatType);
  gradTex.minFilter = gradTex.magFilter = THREE.NearestFilter;
  const suav = new Float32Array(N), tmp = new Float32Array(N), zEf = new Float32Array(N);
  function caja3(src, dst) {
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      let s = 0, k = 0;
      for (let dr = -1; dr <= 1; dr++) { const rr = r + dr; if (rr < 0 || rr >= H) continue;
        for (let dc = -1; dc <= 1; dc++) { const cc = c + dc; if (cc < 0 || cc >= W) continue; s += src[rr * W + cc]; k++; } }
      dst[r * W + c] = s / k;
    }
  }
  caja3(z, tmp); caja3(tmp, suav);
  function aplicarObstaculos(on) {
    for (let i = 0; i < N; i++) {
      const o = on && cob[i] >= UMBRAL_OBST;
      zEf[i] = z[i] + (o ? ALTO_OBST : 0);
      tmp[i] = suav[i] + (o ? 7 : 0);
      gradArr[4 * i + 2] = o ? 1 : 0;
    }
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const i = r * W + c;
      gradArr[4 * i] = (tmp[r * W + Math.min(c + 1, W - 1)] - tmp[r * W + Math.max(c - 1, 0)]) / (2 * C);
      gradArr[4 * i + 1] = (tmp[Math.min(r + 1, H - 1) * W + c] - tmp[Math.max(r - 1, 0) * W + c]) / (2 * C);
    }
    gradTex.needsUpdate = true;
    hidro.setTerreno(zEf);
  }

  // Entrada del río: componente de "agua" (huecos de GEM-15) que cruza el dominio;
  // se inyecta el caudal en sus celdas de borde más altas (aguas arriba).
  const rio = meta.sin_rio ? [] : meta.rio_entrada ? celdasCauce(meta.rio_entrada, z, W, H, C) : ampliarCauce(detectarRio(agua, z, W, H), z, W, H, C);
  const aporte = new Float32Array(N), perm = new Float32Array(N);
  // Agua de GEM-15 a menos de 1,5 m s.n.m. = mar: actúa como sumidero (el agua sale del dominio)
  for (let i = 0; i < N; i++) perm[i] = agua[i] ? (z[i] < 1.5 ? -1 : 1) : 1 - 0.85 * cob[i] / 255;
  function aplicarRio(Q) {
    aporte.fill(0);
    if (rio.length) { const q = Q / (rio.length * C * C); for (const i of rio) aporte[i] = q; }
    hidro.setFuentes(aporte, perm);
  }
  if (!rio.length) $('ctlRio').hidden = true;

  const escorrentia = new Escorrentia(renderer, meta, hidro, gradTex);
  const lluvia3d = new Lluvia3D();
  scene.add(lluvia3d.obj);

  // Calles (Overture)
  let calles = null;
  const sinCalles = new THREE.DataTexture(new Uint8Array(4), 1, 1); sinCalles.needsUpdate = true;
  if (datos.calles && datos.calles.c.length) {
    carga('Dibujando calles…');
    await new Promise((r) => setTimeout(r, 0));
    calles = new Calles(datos.calles, meta, renderer);
    hidro.setCalles(calles.longitud);
    $('secCalles').hidden = false;
    document.querySelectorAll('.kc').forEach((e) => { e.hidden = false; });
    $('nCalles').textContent = `${fmt(calles.km)} km de vías y ${fmt(calles.nombres.length)} nombres de calles (Overture Maps).`;
    const dl = $('dlCalles');
    for (const n of calles.nombres.slice().sort((a, b) => a.localeCompare(b, 'es'))) { const o = document.createElement('option'); o.value = n; dl.appendChild(o); }
  }

  // -------------------------------------------------------------------------
  // Terreno
  // -------------------------------------------------------------------------
  const sol = new THREE.Vector3(0.35, 0.8, 0.5).normalize();
  const U = {
    uZ: { value: zTex }, uAgua: { value: hidro.textura }, uSat: { value: tex }, uTrz: { value: escorrentia.textura },
    uExag: { value: 3 }, uCelda: { value: C }, uDom: { value: new THREE.Vector2(Wm, Hm) }, uGrid: { value: new Int32Array([W, H]) },
    uSol: { value: sol }, uNiebla: { value: fondo }, uNieblaD: { value: 1.2e-5 },
    uVerAgua: { value: 1 }, uMapa: { value: 0 }, uVerTrz: { value: 1 }, uLuz: { value: 1 },
    uCalles: { value: calles ? calles.textura : sinCalles }, uVerCalles: { value: calles ? 1 : 0 },
  };
  const terrGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array(N * 3);
    for (let r = 0, k = 0; r < H; r++) for (let c = 0; c < W; c++) { pos[k++] = c; pos[k++] = 0; pos[k++] = r; }
    const idx = new Uint32Array((W - 1) * (H - 1) * 6);
    let n = 0;
    for (let r = 0; r < H - 1; r++) for (let c = 0; c < W - 1; c++) {
      const a = r * W + c, b = a + 1, d = a + W, e = d + 1;
      idx[n++] = a; idx[n++] = d; idx[n++] = b; idx[n++] = b; idx[n++] = d; idx[n++] = e;
    }
    terrGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    terrGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  const RAMPA = /* glsl */`
    vec3 rampa(float d){
      vec3 c0 = vec3(0.624,0.878,0.976), c1 = vec3(0.290,0.627,0.949), c2 = vec3(0.102,0.333,0.800), c3 = vec3(0.051,0.149,0.502);
      if (d < 0.3) return mix(c0, c1, clamp((d-0.05)/0.25, 0.0, 1.0));
      if (d < 1.0) return mix(c1, c2, (d-0.3)/0.7);
      return mix(c2, c3, clamp(d-1.0, 0.0, 1.0));
    }`;
  const terrMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */`
      uniform sampler2D uZ; uniform sampler2D uAgua; uniform float uExag, uCelda, uVerAgua, uMapa; uniform vec2 uDom; uniform ivec2 uGrid;
      varying vec2 vUv; varying vec3 vN; varying vec3 vW; varying float vD;
      float dA(ivec2 p){ vec4 a = texelFetch(uAgua, p, 0); float d = mix(a.r, a.a, uMapa); return d > 0.02 ? d * uVerAgua : 0.0; }
      float eta(ivec2 p){ return texelFetch(uZ, p, 0).r + dA(p); }
      void main(){
        ivec2 ij = ivec2(position.xz); ivec2 mx = uGrid - 1;
        float h = texelFetch(uZ, ij, 0).r;
        float d = dA(ij);
        float eE = eta(ivec2(min(ij.x+1, mx.x), ij.y)), eW = eta(ivec2(max(ij.x-1, 0), ij.y));
        float eN = eta(ivec2(ij.x, max(ij.y-1, 0))), eS = eta(ivec2(ij.x, min(ij.y+1, mx.y)));
        vN = normalize(vec3(-(eE-eW)*uExag/(2.0*uCelda), 1.0, -(eS-eN)*uExag/(2.0*uCelda)));
        vec3 p = vec3((position.x + 0.5)*uCelda - uDom.x*0.5, (h + d)*uExag, (position.z + 0.5)*uCelda - uDom.y*0.5);
        vUv = (position.xz + 0.5) / vec2(uGrid);
        vD = d; vW = p;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: RAMPA + /* glsl */`
      uniform sampler2D uSat; uniform sampler2D uTrz; uniform sampler2D uCalles; uniform vec3 uSol; uniform vec3 uNiebla; uniform float uNieblaD, uVerTrz, uLuz, uVerCalles;
      varying vec2 vUv; varying vec3 vN; varying vec3 vW; varying float vD;
      void main(){
        vec3 sat = pow(texture2D(uSat, vUv).rgb, vec3(1.18)) * 0.93;   // la costa desértica sale muy clara
        vec3 n = normalize(vN);
        float dif = max(dot(n, uSol), 0.0);
        vec3 col = sat * (0.50 + 0.80*dif) * 1.12 * uLuz;
        vec4 cs = texture2D(uCalles, vUv);
        col = mix(col, cs.rgb * (0.80 + 0.25*dif) * uLuz, cs.a * 0.72 * uVerCalles);
        if (vD > 0.02){
          float a = smoothstep(0.02, 0.12, vD);
          vec3 v = normalize(cameraPosition - vW);
          float sp = pow(max(dot(n, normalize(uSol + v)), 0.0), 80.0) * 0.45;
          col = mix(col, rampa(vD) * (0.78 + 0.32*dif) * uLuz, a*0.88) + sp*a;
        }
        float I = texture2D(uTrz, vUv).r * uVerTrz;
        float a2 = smoothstep(0.10, 1.10, I) * (1.0 - 0.75*smoothstep(0.3, 1.5, vD));
        vec3 tc = mix(vec3(0.13,0.47,0.97), vec3(0.74,0.91,1.0), clamp((I-1.0)*1.3, 0.0, 1.0));
        col = mix(col, tc, a2*0.85);
        float dist = distance(vW, cameraPosition);
        col = mix(col, uNiebla, 1.0 - exp(-dist*uNieblaD));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const terreno = new THREE.Mesh(terrGeo, terrMat);
  terreno.frustumCulled = false;
  scene.add(terreno);

  // -------------------------------------------------------------------------
  // Edificaciones: anillo inferior + anillo superior compartidos; normales planas en el
  // fragment shader (derivadas), así cada vivienda usa sólo 2·n vértices.
  // -------------------------------------------------------------------------
  const UB = { uExag: U.uExag, uHE: { value: 1 }, uSol: U.uSol, uNiebla: U.uNiebla, uNieblaD: U.uNieblaD, uLuz: U.uLuz };
  let edificios = null;
  if (edif.length) {
    carga('Construyendo edificaciones 3D…');
    await new Promise((r) => setTimeout(r, 0));
    let nv = 0, ni = 0;
    for (const b of edif) { const n = (b.length - 2) / 2; nv += 2 * n; ni += (n - 2) * 3 + n * 6; }
    const pos = new Float32Array(nv * 3), aH = new Float32Array(nv), aHB = new Float32Array(nv), idx = new Uint32Array(ni);
    let v = 0, k = 0;
    const contorno = [];
    for (const b of edif) {
      const h = b[0], n = (b.length - 2) / 2, v0 = v;
      let gmax = -1e9;
      const gs = new Float32Array(n);
      for (let j = 0; j < n; j++) { const xe = b[2 + 2 * j], ys = Hm - b[3 + 2 * j]; gs[j] = zEn(xe, ys); gmax = Math.max(gmax, gs[j]); }
      for (let j = 0; j < n; j++) {                       // anillo inferior
        const X = b[2 + 2 * j] - Wm / 2, Z = Hm / 2 - b[3 + 2 * j];
        pos[3 * v] = X; pos[3 * v + 1] = gs[j] - 1; pos[3 * v + 2] = Z; aH[v] = 0; aHB[v] = h; v++;
      }
      contorno.length = 0;
      for (let j = 0; j < n; j++) {                       // anillo superior
        const X = b[2 + 2 * j] - Wm / 2, Z = Hm / 2 - b[3 + 2 * j];
        pos[3 * v] = X; pos[3 * v + 1] = gmax + 0.2; pos[3 * v + 2] = Z; aH[v] = h; aHB[v] = h; v++;
        if (n > 4) contorno.push(new THREE.Vector2(b[2 + 2 * j], b[3 + 2 * j]));
      }
      let tris;
      if (n === 3) tris = [[0, 1, 2]];
      else if (n === 4 && convexo4(b)) tris = [[0, 1, 2], [0, 2, 3]];
      else tris = THREE.ShapeUtils.triangulateShape(contorno, []);
      let t = 0;
      for (; t < tris.length && t < n - 2; t++) { idx[k++] = v0 + n + tris[t][0]; idx[k++] = v0 + n + tris[t][1]; idx[k++] = v0 + n + tris[t][2]; }
      for (; t < n - 2; t++) { idx[k++] = v0 + n; idx[k++] = v0 + n; idx[k++] = v0 + n; } // relleno degenerado
      for (let j = 0; j < n; j++) {
        const a = v0 + j, b2 = v0 + (j + 1) % n, c = b2 + n, d = a + n;
        idx[k++] = a; idx[k++] = b2; idx[k++] = c; idx[k++] = a; idx[k++] = c; idx[k++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aH', new THREE.BufferAttribute(aH, 1));
    g.setAttribute('aHB', new THREE.BufferAttribute(aHB, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: UB, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        attribute float aH; attribute float aHB; uniform float uExag, uHE;
        varying vec3 vW; varying float vHB;
        void main(){
          vec3 p = vec3(position.x, position.y*uExag + aH*uHE, position.z);
          vW = p; vHB = aHB;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uSol; uniform vec3 uNiebla; uniform float uNieblaD, uLuz;
        varying vec3 vW; varying float vHB;
        void main(){
          vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
          if (dot(n, cameraPosition - vW) < 0.0) n = -n;
          bool techo = abs(n.y) > 0.6;
          float alto = smoothstep(9.0, 25.0, vHB);
          vec3 base = techo ? mix(vec3(0.95,0.91,0.83), vec3(0.80,0.84,0.90), alto) : mix(vec3(0.86,0.74,0.60), vec3(0.62,0.68,0.78), alto);
          float dif = max(dot(n, uSol), 0.0);
          vec3 col = base * (0.55 + 0.6*dif) * uLuz;
          col = mix(col, uNiebla, 1.0 - exp(-distance(vW, cameraPosition)*uNieblaD));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    edificios = new THREE.Mesh(g, m);
    edificios.frustumCulled = false;
    scene.add(edificios);
  }

  // -------------------------------------------------------------------------
  // Estado de la simulación y controles
  // -------------------------------------------------------------------------
  const S = { I: 30, dur: 3, loss: 4, rio: 0, vel: 12, n: 0.035, pausa: false, t: 0, dt: 2, est: { volumen: 0, max: 0, area10: 0, area50: 0, calles10: 0, calles30: 0 }, lluvia3d: true,
    tipo: datos.lluvia ? 'diseno' : 'libre', hieto: null };
  const LL = datos.lluvia;

  let pines = null;
  function reiniciar() {
    S.t = 0; S.est = { volumen: 0, max: 0, area10: 0, area50: 0, calles10: 0, calles30: 0 };
    hidro.limpiar(); escorrentia.reiniciar(); if (pines) pines.reiniciarSeries();
  }

  function slider(id, out, f, set) {
    const s = $(id), o = $(out);
    const upd = (manual) => { const v = parseFloat(s.value); o.textContent = f(v); set(v, manual); };
    s.addEventListener('input', () => upd(true)); upd(false);
    return (v) => { s.value = v; upd(false); };
  }
  slider('rI', 'oI', (v) => `${v} mm/h`, (v, m) => { S.I = v; if (m) armarEscenario(); });
  slider('rDur', 'oDur', (v) => `${fmt(v, 1)} h`, (v, m) => { S.dur = v; if (m) armarEscenario(); });
  slider('rLoss', 'oLoss', (v) => `${v} mm/h`, (v) => { S.loss = v; });
  slider('rRio', 'oRio', (v) => `${fmt(v)} m³/s`, (v) => { S.rio = v; aplicarRio(v); });
  slider('rVel', 'oVel', (v) => `${v} pasos`, (v) => { S.vel = v; });
  slider('rN', 'oN', (v) => v.toFixed(3), (v) => { S.n = v; });
  slider('rDens', 'oDens', (v) => `${fmt(v / 1000)} mil`, (v) => { escorrentia.cuantas = v; });
  slider('rTrail', 'oTrail', (v) => `${v.toFixed(1)} s`, (v) => { escorrentia.estelaS = v; });
  slider('rExag', 'oExag', (v) => `${v.toFixed(1)}×`, (v) => { U.uExag.value = v; });
  slider('rBld', 'oBld', (v) => `${v.toFixed(1)}×`, (v) => { UB.uHE.value = v; if (edificios) edificios.visible = v > 0 && $('cBld').checked; });

  // ---- Escenarios de lluvia (IDF de SENAMHI, PISCOp o libre) --------------------------
  function armarEscenario() {
    const v = (id) => $(id).value;
    if (S.tipo === 'diseno' && LL) S.hieto = ESC.diseno(LL, { T: +v('sT'), D: +v('sD'), clima: v('sClima'), banda: v('sBanda'), arf: $('cArf').checked });
    else if (S.tipo === 'historico' && LL) S.hieto = ESC.historico(LL, v('sEvento'));
    else S.hieto = ESC.libre(LL, { I: S.I, D: S.dur, clima: LL ? v('sClima') : 'actual' });
    $('tEsc').textContent = S.hieto.titulo;
    $('nEsc').textContent = S.hieto.detalle;
    ESC.dibujarHietograma($('gHieto'), S.hieto, 0);
    reiniciar();
  }
  if (LL) {
    for (const e of LL.pisco.eventos) {
      const o = document.createElement('option'); o.value = e.id;
      o.textContent = `${e.nombre} · ${e.periodo} · ${fmt(e.total_mm)} mm`; $('sEvento').appendChild(o);
    }
  } else {
    document.querySelectorAll('#segTipo [data-tipo="diseno"], #segTipo [data-tipo="historico"]').forEach((b) => { b.disabled = true; b.title = 'Sin datos de lluvia para esta ciudad'; });
  }
  const paneles = { diseno: 'pDiseno', historico: 'pHistorico', libre: 'pLibre' };
  function elegirTipo(t) {
    S.tipo = t;
    document.querySelectorAll('#segTipo [data-tipo]').forEach((b) => { b.classList.toggle('on', b.dataset.tipo === t); b.setAttribute('aria-checked', b.dataset.tipo === t); });
    for (const [k, id] of Object.entries(paneles)) $(id).hidden = k !== t;
    armarEscenario();
  }
  document.querySelectorAll('#segTipo [data-tipo]').forEach((b) => b.addEventListener('click', () => elegirTipo(b.dataset.tipo)));
  for (const id of ['sT', 'sD', 'sClima', 'sBanda', 'cArf', 'sEvento']) $(id).addEventListener('change', armarEscenario);
  addEventListener('resize', () => ESC.dibujarHietograma($('gHieto'), S.hieto, S.t));
  $('cObs').addEventListener('change', (e) => aplicarObstaculos(e.target.checked));
  $('cWater').addEventListener('change', (e) => { U.uVerAgua.value = e.target.checked ? 1 : 0; });
  $('cTraz').addEventListener('change', (e) => { U.uVerTrz.value = e.target.checked ? 1 : 0; });
  $('cBld').addEventListener('change', (e) => { if (edificios) edificios.visible = e.target.checked && UB.uHE.value > 0; });
  $('cLluvia3d').addEventListener('change', (e) => { S.lluvia3d = e.target.checked; });
  document.querySelectorAll('[data-mapa]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('[data-mapa]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
    U.uMapa.value = +b.dataset.mapa;
  }));
  $('bPause').addEventListener('click', (e) => {
    S.pausa = !S.pausa;
    e.currentTarget.textContent = S.pausa ? 'Reanudar' : 'Pausar';
    e.currentTarget.setAttribute('aria-pressed', S.pausa);
  });
  $('bReset').addEventListener('click', reiniciar);
  $('tPanel').addEventListener('click', () => {
    const p = $('panel'); p.classList.toggle('closed'); $('tPanel').setAttribute('aria-expanded', !p.classList.contains('closed'));
  });
  $('bExp').addEventListener('click', () => exportarASC(hidro, meta, ciudad));

  aplicarObstaculos(true);
  aplicarRio(0);

  // -------------------------------------------------------------------------
  // Vistas
  // -------------------------------------------------------------------------
  const zMedia = z.reduce((a, b) => a + b, 0) / N;
  const vistas = { general: null };
  const vb = $('views');
  const boton = (key, txt) => {
    const b = document.createElement('button'); b.className = 'btn'; b.dataset.view = key; b.textContent = txt; vb.appendChild(b);
    b.addEventListener('click', () => { vb.querySelectorAll('.btn').forEach((x) => x.classList.toggle('on', x === b)); irA(key, false); });
    return b;
  };
  boton('general', 'General').classList.add('on');
  meta.vistas.forEach((v, i) => { vistas['v' + i] = v; boton('v' + i, v.nombre); });

  let anim = null;
  function irA(key, inmediato) {
    const ex = U.uExag.value, L = Math.max(Wm, Hm);
    let t, p;
    if (key === 'general') { t = new THREE.Vector3(0, zMedia * ex, 0); p = t.clone().add(new THREE.Vector3(0, L * 0.42, L * 0.72)); }
    else {
      const v = vistas[key], xe = v.x, ys = Hm - v.y;
      t = new THREE.Vector3(xe - Wm / 2, zEn(xe, ys) * ex, ys - Hm / 2);
      p = t.clone().add(new THREE.Vector3(0, v.dist * 0.62, v.dist));
    }
    if (inmediato) { camera.position.copy(p); controls.target.copy(t); controls.update(); anim = null; return; }
    anim = { p0: camera.position.clone(), t0: controls.target.clone(), p1: p, t1: t, k: 0 };
  }
  function volarA(xe, ys, dist = 900) {
    const ex = U.uExag.value, t = new THREE.Vector3(xe - Wm / 2, zEn(xe, ys) * ex, ys - Hm / 2);
    anim = { p0: camera.position.clone(), t0: controls.target.clone(), p1: t.clone().add(new THREE.Vector3(0, dist * 0.62, dist)), t1: t, k: 0 };
    vb.querySelectorAll('.btn').forEach((x) => x.classList.remove('on'));
  }
  function animar(dt) {
    if (!anim) return;
    anim.k = Math.min(1, anim.k + dt / 1.6);
    const k = anim.k, e = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
    camera.position.lerpVectors(anim.p0, anim.p1, e); controls.target.lerpVectors(anim.t0, anim.t1, e);
    if (anim.k >= 1) anim = null;
  }

  // -------------------------------------------------------------------------
  // Sonda: clic en el terreno → cota y tirante
  // -------------------------------------------------------------------------
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
  let sonda = null, down = null;
  canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || e.button !== 0) { down = null; return; }
    down = null;
    const rc = canvas.getBoundingClientRect();
    ptr.set(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const hit = intersectarTerreno(ray.ray);
    if (!hit) { sonda = null; $('sonda').hidden = true; return; }
    sonda = { ...hit, sx: e.clientX, sy: e.clientY };
    actualizarSonda();
  });
  function intersectarTerreno(r) {
    const ex = U.uExag.value, o = r.origin, d = r.direction, paso = C * 0.5;
    let prev = null;
    for (let t = 0; t < 120000; t += paso) {
      const x = o.x + d.x * t, y = o.y + d.y * t, zz = o.z + d.z * t;
      const xe = x + Wm / 2, ys = zz + Hm / 2;
      const dentro = xe >= 0 && ys >= 0 && xe < Wm && ys < Hm;
      if (dentro && y <= zEn(xe, ys) * ex) return { xe, ys };
      if (!dentro && prev && (y < meta.zmin * ex)) return null;
      prev = dentro;
    }
    return null;
  }
  function actualizarSonda() {
    if (!sonda) return;
    const c = Math.min(W - 1, Math.floor(sonda.xe / C)), r = Math.min(H - 1, Math.floor(sonda.ys / C));
    const w = hidro.celda(c, r), i = r * W + c, g = pines.coords(sonda.xe, sonda.ys);
    const via = calles && calles.cercana(sonda.xe, sonda.ys);
    const el = $('sonda');
    if (!sonda.html) {
      el.innerHTML = `<button class="x" aria-label="Cerrar">✕</button>` +
        (via ? `<div class="calle">${via.nombre || 'Vía sin nombre'} <span class="muted">· ${TIPO_VIA[via.nivel]}</span></div>` : '') +
        `Terreno <b>${fmt(z[i], 1)} m s.n.m.</b>${agua[i] ? ' · cauce' : ''}${cob[i] >= UMBRAL_OBST ? ' · manzana' : ''}<br>` +
        `Tirante actual <b data-s="d"></b><br>Tirante máximo <b data-s="m"></b><br>` +
        `<span class="muted">${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}<br>UTM 17S ${fmt(g.E, 0)} E · ${fmt(g.N, 0)} N</span><br>` +
        `<button class="btn primary">📍 Fijar pin aquí</button>`;
      el.querySelector('.x').onclick = () => { sonda = null; el.hidden = true; };
      el.querySelector('.btn').onclick = () => { pines.agregar(sonda.xe, sonda.ys); sonda = null; el.hidden = true; abrirPanel(); };
      sonda.html = true;
    }
    el.querySelector('[data-s=d]').textContent = `${fmt(w.d, 2)} m`;
    el.querySelector('[data-s=m]').textContent = `${fmt(w.dmax, 2)} m`;
    el.style.left = Math.min(sonda.sx, innerWidth - 250) + 'px'; el.style.top = sonda.sy + 'px'; el.hidden = false;
  }
  function abrirPanel() { const p = $('cPines'); if (p.classList.contains('closed')) $('tPines').click(); }
  $('tPines').addEventListener('click', () => {
    const p = $('cPines'), cerrado = p.classList.toggle('closed');
    $('tPines').textContent = cerrado ? 'Mostrar' : 'Ocultar'; $('tPines').setAttribute('aria-expanded', !cerrado);
  });

  // Nombre de la calle bajo el cursor
  let ultimoMov = 0;
  canvas.addEventListener('pointermove', (e) => {
    const et = $('etiqueta');
    if (!calles || !U.uVerCalles.value || e.buttons) { et.hidden = true; return; }
    const ahora = performance.now(); if (ahora - ultimoMov < 90) return; ultimoMov = ahora;
    const rc = canvas.getBoundingClientRect();
    ptr.set(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const hit = camera.position.distanceTo(controls.target) < 6000 ? intersectarTerreno(ray.ray) : null;
    const via = hit && calles.cercana(hit.xe, hit.ys);
    if (!via || !via.nombre) { et.hidden = true; return; }
    et.textContent = via.nombre; et.style.left = e.clientX + 'px'; et.style.top = e.clientY + 'px'; et.hidden = false;
  });
  canvas.addEventListener('pointerleave', () => { $('etiqueta').hidden = true; });

  // Pines
  pines = new Pines({
    scene, meta, ciudad, z, zEn, hidro, calles, exag: () => U.uExag.value, lista: $('pines'),
    irA: (xe, ys, d) => volarA(xe, ys, d),
    aviso: (t) => avisoIr(t),
  });
  pines.render();
  function avisoIr(t) {
    const n = $('nIr'), orig = n.dataset.orig || (n.dataset.orig = n.textContent);
    n.textContent = t; n.style.color = '#b4540a';
    clearTimeout(avisoIr.t); avisoIr.t = setTimeout(() => { n.textContent = orig; n.style.color = ''; }, 3500);
  }
  $('fIr').addEventListener('submit', (e) => {
    e.preventDefault();
    const txt = $('tIr').value.trim();
    if (!txt) return;
    const nums = txt.match(/-?\d+(?:\.\d+)?/g);
    let pos = null;
    if (nums && nums.length === 2 && /^[-\d\s.,;°NSEOW]+$/i.test(txt)) {
      let [a, b] = nums.map(Number);
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {               // lat, lon (acepta lon, lat)
        if (Math.abs(a) > 20 && Math.abs(b) < 20) [a, b] = [b, a];
        pos = pines.desdeGeo(a, b);
      } else {                                                       // UTM: Este Norte (acepta Norte Este)
        if (a > 1e6 && b < 1e6) [a, b] = [b, a];
        pos = pines.desdeUTM(a, b);
      }
      if (!pos) return avisoIr('Esa coordenada está fuera de la escena de ' + meta.nombre + '.');
    } else if (calles) {
      const r = calles.buscar(txt, 1);
      if (!r.length) return avisoIr('No encontré una calle con ese nombre.');
      pos = calles.ubicar(r[0]); $('tIr').value = r[0];
    } else return avisoIr('Escribe coordenadas: latitud, longitud o Este Norte (UTM 17S).');
    pines.agregar(pos.xe, pos.ys); volarA(pos.xe, pos.ys, 900);
  });
  pines.alCambiar = (n) => { $('nPines').textContent = n ? `(${n})` : ''; if (n) abrirPanel(); };
  $('bPinCSV').onclick = () => pines.exportarCSV();
  $('bPinGJ').onclick = () => pines.exportarGeoJSON();
  $('bPinSerie').onclick = () => pines.exportarSerie();
  $('bPinLink').onclick = (e) => {
    const b = e.currentTarget;
    const ok = () => { b.textContent = '¡Copiado!'; setTimeout(() => (b.textContent = 'Copiar enlace'), 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(pines.enlace()).then(ok, () => prompt('Copia este enlace:', pines.enlace()));
    else prompt('Copia este enlace:', pines.enlace());
  };

  // Nombres de calles sobre el terreno (se cargan aparte: si el CDN falla, el resto sigue funcionando)
  let etiquetas = null;
  if (calles) {
    import('./etiquetas.js').then((m) => {
      etiquetas = new m.Etiquetas({ calles, zEn, Wm, Hm, exag: () => U.uExag.value, camera, canvas });
      etiquetas.visible = $('cNombres').checked;
      scene.add(etiquetas.grupo);
    }).catch((e) => { console.warn('Nombres de calles no disponibles:', e); $('cNombres').parentElement.hidden = true; });
    $('cNombres').addEventListener('change', (e) => { if (etiquetas) etiquetas.visible = e.target.checked; });
  }

  // Calles: mostrar / más afectadas
  if (calles) {
    $('cCalles').addEventListener('change', (e) => { U.uVerCalles.value = e.target.checked ? 1 : 0; });
    $('bAfect').addEventListener('click', () => {
      const lista = calles.afectadas(hidro.rejilla(3), 0.3, 10), ol = $('lAfect');
      ol.innerHTML = lista.length ? '' : '<li class="muted" style="cursor:default">Ninguna calle con nombre supera 30 cm todavía.</li>';
      for (const a of lista) {
        const li = document.createElement('li');
        li.innerHTML = `<b>${a.nombre}</b> <span>${fmt(a.km, 2)} km · máx ${fmt(a.dmax, 2)} m</span>`;
        li.title = 'Ir al punto más profundo de esta calle';
        li.onclick = () => volarA(a.xe, a.ys, 800);
        ol.appendChild(li);
      }
    });
  }

  controls.addEventListener('start', () => { sonda = null; $('sonda').hidden = true; });

  // -------------------------------------------------------------------------
  // Bucle
  // -------------------------------------------------------------------------
  function redimensionar() {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  addEventListener('resize', redimensionar); redimensionar();
  irA('general', true);
  if (params.get('pin') && pines.desdeURL(params.get('pin'))) {
    const p0 = pines.pines[0]; volarA(p0.xe, p0.ys, 1100); abrirPanel();
  }
  $('cargando').classList.add('oculto');

  const reloj = new THREE.Clock();
  let acum = 0, cuadros = 0, tStats = 0, tReal = 0, factorLluvia = 0;
  const hud = { T: $('hT'), P: $('hP'), V: $('hV'), A10: $('hA10'), A50: $('hA50'), M: $('hMax'), F: $('hFase'), fps: $('fps'), C10: $('hC10'), C30: $('hC30'), R: $('hR') };

  function cuadro() {
    requestAnimationFrame(cuadro);
    const dt = Math.min(reloj.getDelta(), 0.05);
    tReal += dt;
    animar(dt);
    const durS = ESC.duracionS(S.hieto);
    const tasaAhora = ESC.tasa(S.hieto, S.t);             // mm/h en este instante
    const lloviendo = !S.pausa && tasaAhora > 0;

    if (!S.pausa) {
      // Paso de tiempo adaptativo (condición CFL del esquema de inercia local)
      const hmax = Math.max(S.est.max, 0.05) + (S.rio > 0 ? 2 : 0);
      S.dt = Math.min(3, Math.max(0.2, 0.6 * C / (Math.sqrt(9.81 * hmax) + 1)));
      const perdida = S.loss / 3.6e6;
      for (let k = 0; k < S.vel; k++) {                    // la intensidad cambia con el hietograma
        hidro.pasos(1, S.dt, ESC.tasa(S.hieto, S.t) / 3.6e6, perdida, S.n);
        S.t += S.dt;
      }
      escorrentia.avanzar(dt, lloviendo);
    }

    // Ambiente: cielo de tormenta y lluvia 3D
    const objetivo = lloviendo ? Math.min(1, 0.35 + tasaAhora / 80) : 0;
    factorLluvia += (objetivo - factorLluvia) * Math.min(1, dt * 1.5);
    fondo.copy(CIELO).lerp(TORMENTA, factorLluvia); U.uLuz.value = 1 - 0.18 * factorLluvia;
    renderer.setClearColor(fondo);
    lluvia3d.actualizar(tReal, controls.target, camera.position.distanceTo(controls.target), S.lluvia3d ? factorLluvia * Math.min(0.7, Math.max(0.08, tasaAhora / 110)) : 0);

    controls.update();
    const dist = camera.position.distanceTo(controls.target), near = Math.max(8, dist * 0.02);
    if (Math.abs(near - camera.near) / camera.near > 0.1) { camera.near = near; camera.updateProjectionMatrix(); }
    pines.posicionar();
    if (etiquetas) etiquetas.actualizar(dt);
    renderer.render(scene, camera);

    acum += dt; cuadros++; tStats += dt;
    if (tStats > 0.3) {
      tStats = 0;
      S.est = hidro.estadisticas();
      if (!isFinite(S.est.max) || !isFinite(S.est.volumen)) {     // inestabilidad numérica: se reinicia
        console.warn('Simulación inestable: se reinicia el agua');
        reiniciar(); S.est = hidro.estadisticas();
      }
      const h = Math.floor(S.t / 3600), m = Math.floor((S.t % 3600) / 60);
      hud.T.textContent = `${h}:${String(m).padStart(2, '0')} h`;
      hud.P.textContent = `${fmt(ESC.acumulada(S.hieto, S.t))} mm`;
      hud.R.textContent = `${fmt(tasaAhora, 1)} mm/h`;
      ESC.dibujarHietograma($('gHieto'), S.hieto, S.t);
      hud.V.textContent = S.est.volumen > 1e6 ? `${fmt(S.est.volumen / 1e6, 2)} hm³` : `${fmt(S.est.volumen / 1000)} mil m³`;
      hud.A10.textContent = `${fmt(S.est.area10 / 1e4)} ha`;
      hud.A50.textContent = `${fmt(S.est.area50 / 1e4)} ha`;
      hud.M.textContent = `${fmt(S.est.max, 2)} m`;
      if (calles) { hud.C10.textContent = `${fmt(S.est.calles10 / 1000, 1)} km`; hud.C30.textContent = `${fmt(S.est.calles30 / 1000, 1)} km`; }
      pines.actualizar(S.t, !S.pausa);
      const fase = S.pausa ? 'pausa' : S.t >= durS ? 'seco' : tasaAhora > 0 ? 'lluvia' : 'tregua';
      hud.F.textContent = { pausa: 'En pausa', seco: 'Escurrimiento', lluvia: 'Lloviendo', tregua: 'Sin lluvia por ahora' }[fase];
      hud.F.className = 'pill' + (fase === 'pausa' ? ' pausa' : fase === 'lluvia' ? '' : ' seco');
      actualizarSonda();
    }
    if (acum > 0.5) { hud.fps.textContent = Math.round(cuadros / acum); acum = 0; cuadros = 0; }
  }
  window.__simulador = { S, hidro, meta, pines, calles, rio, lluvia: LL, ESC };
  elegirTipo(S.tipo);
  cuadro();
}

// ---------------------------------------------------------------------------
// Celdas del cauce alrededor del punto de entrada del río (las más bajas en ~90 m a la redonda).
function celdasCauce(p, z, W, H, C) {
  const c0 = Math.round(p.x / C - 0.5), r0 = Math.round((H * C - p.y) / C - 0.5), R = 6;
  const cand = [];
  for (let r = Math.max(0, r0 - R); r <= Math.min(H - 1, r0 + R); r++)
    for (let c = Math.max(0, c0 - R); c <= Math.min(W - 1, c0 + R); c++)
      if (Math.hypot(r - r0, c - c0) <= R) cand.push(r * W + c);
  // Las celdas más bajas (el cauce): al menos 24, para que el caudal no entre por un punto
  // y el nivel suba más rápido de lo que el paso de tiempo puede seguir (cauces angostos).
  const orden = cand.sort((a, b) => z[a] - z[b]);
  const n = Math.max(24, orden.filter((i) => z[i] < z[orden[0]] + 1.0).length);
  return orden.slice(0, n);
}

// Un cauce detectado automáticamente puede quedar en muy pocas celdas: se toman las 24+ más bajas
// alrededor de su centro, igual que con un punto de entrada fijo.
function ampliarCauce(celdas, z, W, H, C) {
  if (!celdas.length || celdas.length >= 24) return celdas;
  const r = d3mean(celdas.map((i) => (i / W) | 0)), c = d3mean(celdas.map((i) => i % W));
  return celdasCauce({ x: (c + 0.5) * C, y: H * C - (r + 0.5) * C }, z, W, H, C);
}
const d3mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;

function detectarRio(agua0, z, W, H) {
  // El cauce viene como "sin dato" en GEM-15, pero con cortes: se dilata la máscara 3 celdas
  // y se buscan componentes conexas (4-vecinos) que crucen el dominio (tocan ≥ 2 bordes).
  let agua = agua0;
  for (let it = 0; it < 3; it++) {
    const d = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const i = r * W + c;
      d[i] = agua[i] || (c > 0 && agua[i - 1]) || (c < W - 1 && agua[i + 1]) || (r > 0 && agua[i - W]) || (r < H - 1 && agua[i + W]) ? 1 : 0;
    }
    agua = d;
  }
  const comp = new Int32Array(W * H).fill(-1), info = [];
  const cola = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (!agua[s] || comp[s] >= 0) continue;
    const id = info.length; let a = 0, b = 0; cola[b++] = s; comp[s] = id;
    const lados = new Set(), borde = [];
    while (a < b) {
      const i = cola[a++], r = (i / W) | 0, c = i % W;
      if (r === 0) lados.add('N'); if (r === H - 1) lados.add('S'); if (c === 0) lados.add('O'); if (c === W - 1) lados.add('E');
      if ((r === 0 || r === H - 1 || c === 0 || c === W - 1) && agua0[i]) borde.push(i);
      if (c > 0 && agua[i - 1] && comp[i - 1] < 0) { comp[i - 1] = id; cola[b++] = i - 1; }
      if (c < W - 1 && agua[i + 1] && comp[i + 1] < 0) { comp[i + 1] = id; cola[b++] = i + 1; }
      if (r > 0 && agua[i - W] && comp[i - W] < 0) { comp[i - W] = id; cola[b++] = i - W; }
      if (r < H - 1 && agua[i + W] && comp[i + W] < 0) { comp[i + W] = id; cola[b++] = i + W; }
    }
    info.push({ n: b, lados: lados.size, borde, zmax: borde.reduce((m, i) => Math.max(m, z[i]), -1e9) });
  }
  // descarta el mar (todo el borde por debajo de 3 m)
  const rios = info.filter((x) => x.lados >= 2 && x.borde.length && x.zmax > 3).sort((p, q) => q.n - p.n);
  if (!rios.length) return [];
  const borde = rios[0].borde;
  let imax = borde[0];
  for (const i of borde) if (z[i] > z[imax]) imax = i;
  const r0 = (imax / W) | 0, c0 = imax % W;
  return borde.filter((i) => z[i] > z[imax] - 1.5 && Math.hypot(((i / W) | 0) - r0, (i % W) - c0) < 25);
}

function convexo4(b) {
  let signo = 0;
  for (let j = 0; j < 4; j++) {
    const a = 2 + 2 * j, c = 2 + 2 * ((j + 1) % 4), e = 2 + 2 * ((j + 2) % 4);
    const cr = (b[c] - b[a]) * (b[e + 1] - b[c + 1]) - (b[c + 1] - b[a + 1]) * (b[e] - b[c]);
    if (cr === 0) continue;
    if (signo === 0) signo = Math.sign(cr); else if (Math.sign(cr) !== signo) return false;
  }
  return true;
}

function exportarASC(hidro, meta, ciudad) {
  const d = hidro.rejilla(3), W = meta.W, H = meta.H;
  const filas = [`ncols ${W}`, `nrows ${H}`, `xllcorner ${meta.x0}`, `yllcorner ${meta.y0}`, `cellsize ${meta.celda}`, 'NODATA_value -9999'];
  for (let r = 0; r < H; r++) {
    const f = new Array(W);
    for (let c = 0; c < W; c++) { const v = d[r * W + c]; f[c] = v < 0.01 ? '0' : v.toFixed(3); }
    filas.push(f.join(' '));
  }
  const prj = 'PROJCS["WGS_1984_UTM_Zone_17S",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
    'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],' +
    'PARAMETER["False_Northing",10000000.0],PARAMETER["Central_Meridian",-81.0],PARAMETER["Scale_Factor",0.9996],' +
    'PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
  const bajar = (txt, nombre) => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
    a.download = nombre; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const nombre = `tirante_max_${ciudad}`;
  bajar(filas.join('\n'), nombre + '.asc');
  setTimeout(() => bajar(prj, nombre + '.prj'), 400);
}

main();
