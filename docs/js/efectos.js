// Efectos visuales: trazas de escorrentía (partículas en GPU) y lluvia 3D.
import * as THREE from 'three';

const VS_QUAD = /* glsl */`void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// ---------------------------------------------------------------------------
// Trazas de escorrentía.
// Cada partícula es una "gota" que, en terreno seco, baja por la máxima pendiente del
// relieve suavizado (como en el mapa del abanico aluvial) y, donde hay lámina de agua,
// sigue la velocidad que calcula el modelo hidrodinámico. Se dibujan en una textura
// que se desvanece poco a poco y deja estelas.
// Estado (RGBA32F): x (m, hacia el este), y (m, hacia el sur), edad (s), vida (s; <=0 muerta)
// ---------------------------------------------------------------------------
const FS_PARTICULAS = /* glsl */`
  precision highp float;
  uniform sampler2D uP;       // estado
  uniform sampler2D uAgua;    // estado hidráulico
  uniform sampler2D uGrad;    // R,G: gradiente del relieve suavizado; B: obstáculo
  uniform ivec2 uSize;
  uniform vec2 uDom;          // tamaño del dominio (m)
  uniform float uCelda, uDt, uT, uLluvia, uK;
  float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  vec4 grad(vec2 xy){
    vec2 c = xy / uCelda - 0.5;
    ivec2 i = clamp(ivec2(floor(c)), ivec2(0), uSize - 2);
    vec2 f = clamp(c - vec2(i), 0.0, 1.0);
    vec4 a = texelFetch(uGrad, i, 0), b = texelFetch(uGrad, i + ivec2(1,0), 0);
    vec4 cc = texelFetch(uGrad, i + ivec2(0,1), 0), d = texelFetch(uGrad, i + ivec2(1,1), 0);
    return mix(mix(a, b, f.x), mix(cc, d, f.x), f.y);
  }
  void main(){
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 s = texelFetch(uP, p, 0);
    vec2 sem = vec2(p) * 0.731 + vec2(uT * 13.7, uT * 7.3);
    if (s.w <= 0.0 || s.z >= s.w){
      // Nace una gota nueva: con lluvia en cualquier punto; sin lluvia, sólo donde hay agua
      vec2 xy = vec2(h(sem), h(sem + 1.7)) * uDom;
      ivec2 c = clamp(ivec2(xy / uCelda), ivec2(0), uSize - 1);
      float d = texelFetch(uAgua, c, 0).r;
      bool ok = texelFetch(uGrad, c, 0).b < 0.5 && (uLluvia > 0.5 || d > 0.05);
      gl_FragColor = ok ? vec4(xy, 0.0, 6.0 + h(sem + 5.3) * 16.0) : vec4(xy, 0.0, -1.0);
      return;
    }
    ivec2 c = clamp(ivec2(s.xy / uCelda), ivec2(0), uSize - 1);
    vec4 w = texelFetch(uAgua, c, 0);
    vec2 v = vec2(0.0);
    if (w.r > 0.03){
      float qW = texelFetch(uAgua, max(c - ivec2(1,0), ivec2(0)), 0).g;
      float qN = texelFetch(uAgua, max(c - ivec2(0,1), ivec2(0)), 0).b;
      vec2 u = vec2(w.g + qW, w.b + qN) * 0.5 / max(w.r, 0.05);
      float m = length(u);
      if (m > 1e-3) v = u / m * clamp(m * uK, 60.0, 900.0);
    } else {
      vec2 g = grad(s.xy).xy;
      float m = length(g);
      if (m > 1e-5) v = -g / m * clamp(1800.0 * sqrt(m), 120.0, 1000.0);
    }
    v += (vec2(h(sem + 7.1), h(sem + 9.3)) - 0.5) * 50.0;
    vec2 n = s.xy + v * uDt;
    float edad = s.z + uDt;
    bool fuera = any(lessThan(n, vec2(0.0))) || any(greaterThanEqual(n, uDom));
    if (fuera || grad(n).b > 0.5) edad = s.w + 1.0;
    gl_FragColor = vec4(n, edad, s.w);
  }
`;

const VS_PUNTOS = /* glsl */`
  uniform sampler2D uP; uniform vec2 uDom; uniform float uPt;
  void main(){
    vec4 s = texelFetch(uP, ivec2(position.xy), 0);
    if (s.w <= 0.0 || s.z <= 0.0 || s.z >= s.w){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    gl_Position = vec4(s.x / uDom.x * 2.0 - 1.0, s.y / uDom.y * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = uPt;
  }
`;
const FS_PUNTOS = /* glsl */`uniform float uI; void main(){ gl_FragColor = vec4(uI, uI, uI, 1.0); }`;

export class Escorrentia {
  constructor(renderer, meta, hidro, gradTex) {
    this.r = renderer;
    const W = meta.W, H = meta.H, celda = meta.celda;
    this.dom = new THREE.Vector2(W * celda, H * celda);
    this.PW = 512; this.PH = 512; // hasta 262 144 gotas
    const opt = { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    this.P = [new THREE.WebGLRenderTarget(this.PW, this.PH, opt), new THREE.WebGLRenderTarget(this.PW, this.PH, opt)];
    // Estelas a ~10 m por píxel
    this.TW = Math.round(this.dom.x / 10); this.TH = Math.round(this.dom.y / 10);
    this.estela = new THREE.WebGLRenderTarget(this.TW, this.TH, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });

    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.cam.position.z = 0.5;
    this.mUpd = new THREE.ShaderMaterial({
      vertexShader: VS_QUAD, fragmentShader: FS_PARTICULAS,
      uniforms: {
        uP: { value: null }, uAgua: { value: hidro.textura }, uGrad: { value: gradTex },
        uSize: { value: new Int32Array([W, H]) }, uDom: { value: this.dom }, uCelda: { value: celda },
        uDt: { value: 0 }, uT: { value: 0 }, uLluvia: { value: 1 }, uK: { value: 400 },
      },
    });
    this.escUpd = new THREE.Scene();
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mUpd); q.frustumCulled = false; this.escUpd.add(q);

    // Puntos que leen su posición del estado
    const n = this.PW * this.PH, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[3 * i] = i % this.PW; pos[3 * i + 1] = Math.floor(i / this.PW); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.mPts = new THREE.ShaderMaterial({
      vertexShader: VS_PUNTOS, fragmentShader: FS_PUNTOS,
      uniforms: { uP: { value: null }, uDom: { value: this.dom }, uPt: { value: 1.6 }, uI: { value: 0.3 } },
      blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
    });
    this.puntos = new THREE.Points(g, this.mPts); this.puntos.frustumCulled = false;
    this.mFade = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.1, depthTest: false, depthWrite: false });
    const fq = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mFade); fq.frustumCulled = false; fq.renderOrder = 0;
    this.puntos.renderOrder = 1;
    this.escTrz = new THREE.Scene(); this.escTrz.add(fq); this.escTrz.add(this.puntos);
    this.cuantas = 60000; this.estelaS = 0.8; this.t = 0;
    this.reiniciar();
  }

  get textura() { return this.estela.texture; }

  reiniciar() {
    const prev = this.r.getRenderTarget(), cc = new THREE.Color(); this.r.getClearColor(cc); const ca = this.r.getClearAlpha();
    this.r.setClearColor(0x000000, 0);
    for (const rt of [...this.P, this.estela]) { this.r.setRenderTarget(rt); this.r.clear(); }
    this.r.setRenderTarget(prev); this.r.setClearColor(cc, ca);
  }

  /** dtVis: segundos "visuales" (afecta velocidad de las estelas). lloviendo: bool */
  avanzar(dtVis, lloviendo) {
    this.t += dtVis;
    const u = this.mUpd.uniforms;
    u.uP.value = this.P[0].texture; u.uDt.value = dtVis; u.uT.value = this.t % 1000; u.uLluvia.value = lloviendo ? 1 : 0;
    const prev = this.r.getRenderTarget();
    this.r.setRenderTarget(this.P[1]); this.r.render(this.escUpd, this.cam);
    this.P.reverse();
    // estelas
    this.mFade.opacity = 1 - Math.exp(-Math.max(dtVis, 0.001) / this.estelaS);
    this.mPts.uniforms.uP.value = this.P[0].texture;
    this.puntos.geometry.setDrawRange(0, this.cuantas);
    this.r.autoClear = false;
    this.r.setRenderTarget(this.estela); this.r.render(this.escTrz, this.cam);
    this.r.autoClear = true;
    this.r.setRenderTarget(prev);
  }
}

// ---------------------------------------------------------------------------
// Lluvia 3D: segmentos que caen en una caja que acompaña a la cámara.
// ---------------------------------------------------------------------------
export class Lluvia3D {
  constructor(max = 40000) {
    const pos = new Float32Array(max * 2 * 3), semilla = new Float32Array(max * 2 * 3), fin = new Float32Array(max * 2);
    for (let i = 0; i < max; i++) {
      const a = Math.random(), b = Math.random(), c = Math.random();
      for (let k = 0; k < 2; k++) { const j = 2 * i + k; semilla.set([a, b, c], 3 * j); fin[j] = k; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSem', new THREE.BufferAttribute(semilla, 3));
    g.setAttribute('aFin', new THREE.BufferAttribute(fin, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uC: { value: new THREE.Vector3() }, uCaja: { value: 1000 }, uT: { value: 0 }, uViento: { value: 0.12 }, uA: { value: 0.22 } },
      vertexShader: /* glsl */`
        attribute vec3 aSem; attribute float aFin;
        uniform vec3 uC; uniform float uCaja, uT, uViento;
        varying float vF;
        void main(){
          float y = fract(aSem.y - uT * 0.9 - aSem.x * 0.37) * uCaja;
          vec3 p = uC + vec3((aSem.x - 0.5) * uCaja * 1.6, y - uCaja * 0.15, (aSem.z - 0.5) * uCaja * 1.6);
          float L = uCaja * 0.028;
          p += aFin * vec3(-uViento * L, L, 0.0);
          vF = aFin;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform float uA; varying float vF;
        void main(){ gl_FragColor = vec4(0.82, 0.88, 0.95, uA * (0.35 + 0.65 * vF)); }`,
      transparent: true, depthWrite: false,
    });
    this.obj = new THREE.LineSegments(g, this.mat);
    this.obj.frustumCulled = false; this.obj.renderOrder = 5;
    this.max = max;
  }
  actualizar(t, centro, distancia, intensidad /* 0-1 */) {
    const u = this.mat.uniforms;
    u.uT.value = t; u.uC.value.copy(centro); u.uCaja.value = Math.max(300, distancia * 0.9);
    const n = Math.round(this.max * Math.min(1, intensidad));
    this.obj.geometry.setDrawRange(0, n * 2);
    this.obj.visible = n > 0;
  }
}
