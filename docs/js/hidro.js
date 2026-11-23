// Motor hidrodinámico 2D en GPU.
//
// Esquema de "inercia local" (Bates, Horritt y Fewtrell, 2010; el mismo de LISFLOOD-FP),
// resuelto con texturas de punto flotante en WebGL2:
//
//   q(t+dt) = [ q(t) - g·hf·dt·∂η/∂x ] / [ 1 + g·dt·n²·|q(t)| / hf^(7/3) ]
//   d(t+dt) = d(t) + dt·(Σ q_entrante - Σ q_saliente)/Δx + dt·(lluvia + aporte) - pérdidas
//
// q: caudal por unidad de ancho en las caras de cada celda (m²/s), η = z + d: cota del agua,
// hf: tirante de flujo en la cara, n: rugosidad de Manning.
//
// Estado (RGBA32F, W×H, fila 0 = norte):  R = tirante d (m), G = q en la cara este,
// B = q en la cara sur, A = tirante máximo alcanzado.
import * as THREE from 'three';

const VS = /* glsl */`void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COMUN = /* glsl */`
  precision highp float;
  const float G = 9.81;
  uniform ivec2 uSize;
  uniform float uDt;
  uniform float uDx;
  uniform sampler2D uZ;
  // Borde abierto: flujo crítico hacia afuera sólo si el terreno baja hacia el borde
  // (celda de borde <= vecina interior). Así una crecida inyectada aguas arriba no se escapa.
  float salida(float d, float z, float zInt){
    if (z > zInt + 0.01) return 0.0;
    return min(d*sqrt(G*d), d*uDx/uDt*0.25);
  }
`;

const FS_CAUDAL = COMUN + /* glsl */`
  uniform sampler2D uS;
  uniform float uN;
  float cara(float q, float eta, float etaV, float z, float zV){
    float hf = max(eta, etaV) - max(z, zV);
    if (hf <= 1e-3) return 0.0;
    float qn = (q - G*hf*uDt*(etaV - eta)/uDx) / (1.0 + G*uDt*uN*uN*abs(q)/pow(hf, 7.0/3.0));
    float qmax = hf*sqrt(G*hf);               // limitador de Froude (Fr <= 1)
    return clamp(qn, -qmax, qmax);
  }
  void main(){
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 s = texelFetch(uS, p, 0);
    float z = texelFetch(uZ, p, 0).r;
    float eta = z + s.r;
    float qe, qs;
    if (p.x < uSize.x - 1){
      ivec2 e = p + ivec2(1,0);
      float zE = texelFetch(uZ, e, 0).r;
      qe = cara(s.g, eta, zE + texelFetch(uS, e, 0).r, z, zE);
    } else qe = salida(s.r, z, texelFetch(uZ, p - ivec2(1,0), 0).r);
    if (p.y < uSize.y - 1){
      ivec2 v = p + ivec2(0,1);
      float zS = texelFetch(uZ, v, 0).r;
      qs = cara(s.b, eta, zS + texelFetch(uS, v, 0).r, z, zS);
    } else qs = salida(s.r, z, texelFetch(uZ, p - ivec2(0,1), 0).r);
    gl_FragColor = vec4(s.r, qe, qs, s.a);
  }
`;

const FS_TIRANTE = COMUN + /* glsl */`
  uniform sampler2D uS;
  uniform sampler2D uF;      // R: aporte puntual (m/s, p.ej. caudal del río), G: permeabilidad (0-1; < 0 = mar)
  uniform float uLluvia;     // m/s
  uniform float uPerdida;    // m/s
  void main(){
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 s = texelFetch(uS, p, 0);
    float z = texelFetch(uZ, p, 0).r;
    float qW = p.x > 0 ? texelFetch(uS, p - ivec2(1,0), 0).g : -salida(s.r, z, texelFetch(uZ, p + ivec2(1,0), 0).r);
    float qN = p.y > 0 ? texelFetch(uS, p - ivec2(0,1), 0).b : -salida(s.r, z, texelFetch(uZ, p + ivec2(0,1), 0).r);
    vec2 f = texelFetch(uF, p, 0).rg;
    float d = s.r + uDt*((qW - s.g) + (qN - s.b))/uDx + uDt*(uLluvia + f.r);
    d -= min(max(d, 0.0), uDt*uPerdida*f.g);
    d = max(d, 0.0);
    if (f.g < 0.0) d = 0.0;          // mar: sumidero
    gl_FragColor = vec4(d, s.g, s.b, max(s.a, d));
  }
`;

// Reduce bloques de 8×8 celdas: R = suma de tirantes, G = tirante máximo,
// B = nº celdas con d > 0,10 m, A = nº celdas con d > 0,50 m
const FS_REDUCIR = COMUN + /* glsl */`
  uniform sampler2D uS;
  void main(){
    ivec2 b = ivec2(gl_FragCoord.xy) * 8;
    float suma = 0.0, mx = 0.0, c10 = 0.0, c50 = 0.0;
    for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++){
      ivec2 p = b + ivec2(i, j);
      if (p.x >= uSize.x || p.y >= uSize.y) continue;
      float d = texelFetch(uS, p, 0).r;
      suma += d; mx = max(mx, d); c10 += step(0.10, d); c50 += step(0.50, d);
    }
    gl_FragColor = vec4(suma, mx, c10, c50);
  }
`;

// Longitud de calles anegadas por bloque de 8×8: R = m de vía con d > 0,10 m, G = con d > 0,30 m
const FS_REDUCIR_CALLES = COMUN + /* glsl */`
  uniform sampler2D uS;
  uniform sampler2D uL;     // metros de eje de vía dentro de cada celda
  void main(){
    ivec2 b = ivec2(gl_FragCoord.xy) * 8;
    float l10 = 0.0, l30 = 0.0;
    for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++){
      ivec2 p = b + ivec2(i, j);
      if (p.x >= uSize.x || p.y >= uSize.y) continue;
      float L = texelFetch(uL, p, 0).r;
      if (L <= 0.0) continue;
      float d = texelFetch(uS, p, 0).r;
      l10 += L * step(0.10, d); l30 += L * step(0.30, d);
    }
    gl_FragColor = vec4(l10, l30, 0.0, 1.0);
  }
`;

const FS_LIMPIAR = /* glsl */`void main(){ gl_FragColor = vec4(0.0); }`;

export class Hidro {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {number} W columnas  @param {number} H filas  @param {number} dx tamaño de celda (m)
   */
  constructor(renderer, W, H, dx) {
    this.r = renderer; this.W = W; this.H = H; this.dx = dx;
    const opt = {
      type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    };
    this.A = new THREE.WebGLRenderTarget(W, H, opt);   // estado vigente
    this.B = new THREE.WebGLRenderTarget(W, H, opt);   // estado intermedio (caudales nuevos)
    this.RW = Math.ceil(W / 8); this.RH = Math.ceil(H / 8);
    this.R = new THREE.WebGLRenderTarget(this.RW, this.RH, opt);
    this.bufR = new Float32Array(this.RW * this.RH * 4);

    const dataTex = (arr, fmt) => {
      const t = new THREE.DataTexture(arr, W, H, fmt, THREE.FloatType);
      t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t;
    };
    this.zArr = new Float32Array(W * H);
    this.zTex = dataTex(this.zArr, THREE.RedFormat);
    this.fArr = new Float32Array(W * H * 2);
    this.fTex = dataTex(this.fArr, THREE.RGFormat);

    const u = (extra) => Object.assign({
      uSize: { value: new Int32Array([W, H]) }, uDt: { value: 1 }, uDx: { value: dx },
    }, extra);
    const mat = (fs, uniforms) => new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
    this.mCaudal = mat(FS_CAUDAL, u({ uS: { value: null }, uZ: { value: this.zTex }, uN: { value: 0.035 } }));
    this.mTirante = mat(FS_TIRANTE, u({ uS: { value: null }, uZ: { value: this.zTex }, uF: { value: this.fTex }, uLluvia: { value: 0 }, uPerdida: { value: 0 } }));
    this.mReducir = mat(FS_REDUCIR, u({ uS: { value: null }, uZ: { value: this.zTex } }));
    this.mLimpiar = mat(FS_LIMPIAR, {});
    this.mCalles = null;

    this.escena = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mLimpiar);
    this.quad.frustumCulled = false;
    this.escena.add(this.quad);
    this.limpiar();
  }

  /** Terreno efectivo (m) y fuentes. z: Float32Array W*H. */
  setTerreno(z) { this.zArr.set(z); this.zTex.needsUpdate = true; }
  /** aporte: Float32Array W*H en m/s; perm: Float32Array W*H 0-1 */
  setFuentes(aporte, perm) {
    for (let i = 0; i < this.W * this.H; i++) { this.fArr[2 * i] = aporte[i]; this.fArr[2 * i + 1] = perm[i]; }
    this.fTex.needsUpdate = true;
  }

  /** Longitud de vía por celda (Float32Array W*H, metros) para medir calles anegadas. */
  setCalles(longitud) {
    const t = new THREE.DataTexture(longitud, this.W, this.H, THREE.RedFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true;
    this.mCalles = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS_REDUCIR_CALLES, depthTest: false, depthWrite: false,
      uniforms: { uS: { value: null }, uL: { value: t }, uSize: { value: new Int32Array([this.W, this.H]) }, uDt: { value: 1 }, uDx: { value: this.dx }, uZ: { value: this.zTex } },
    });
    this.RC = new THREE.WebGLRenderTarget(this.RW, this.RH, {
      type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
  }

  _pasar(mat, destino) {
    this.quad.material = mat;
    const prev = this.r.getRenderTarget();
    this.r.setRenderTarget(destino);
    this.r.render(this.escena, this.cam);
    this.r.setRenderTarget(prev);
  }

  limpiar() { this._pasar(this.mLimpiar, this.A); this._pasar(this.mLimpiar, this.B); }

  /**
   * Avanza n pasos.
   * @param {number} n  @param {number} dt s  @param {number} lluvia m/s  @param {number} perdida m/s  @param {number} manning
   */
  pasos(n, dt, lluvia, perdida, manning) {
    const c = this.mCaudal.uniforms, t = this.mTirante.uniforms;
    c.uDt.value = t.uDt.value = dt; c.uN.value = manning;
    t.uLluvia.value = lluvia; t.uPerdida.value = perdida;
    for (let i = 0; i < n; i++) {
      c.uS.value = this.A.texture; this._pasar(this.mCaudal, this.B);
      t.uS.value = this.B.texture; this._pasar(this.mTirante, this.A);
    }
  }

  get textura() { return this.A.texture; }

  /** Estadísticas globales (lectura de la textura reducida). */
  estadisticas() {
    this.mReducir.uniforms.uS.value = this.A.texture;
    this._pasar(this.mReducir, this.R);
    this.r.readRenderTargetPixels(this.R, 0, 0, this.RW, this.RH, this.bufR);
    let suma = 0, mx = 0, c10 = 0, c50 = 0;
    const b = this.bufR;
    for (let i = 0; i < b.length; i += 4) { suma += b[i]; mx = Math.max(mx, b[i + 1]); c10 += b[i + 2]; c50 += b[i + 3]; }
    const a = this.dx * this.dx;
    const est = { volumen: suma * a, max: mx, area10: c10 * a, area50: c50 * a, calles10: 0, calles30: 0 };
    if (this.mCalles) {
      this.mCalles.uniforms.uS.value = this.A.texture;
      this._pasar(this.mCalles, this.RC);
      this.r.readRenderTargetPixels(this.RC, 0, 0, this.RW, this.RH, b);
      for (let i = 0; i < b.length; i += 4) { est.calles10 += b[i]; est.calles30 += b[i + 1]; }
    }
    return est;
  }

  /** Lee el estado de una celda: {d, dmax}. */
  celda(col, fila) {
    const b = new Float32Array(4);
    this.r.readRenderTargetPixels(this.A, col, fila, 1, 1, b);
    return { d: b[0], dmax: b[3] };
  }

  /** Lee toda la rejilla (canal 0 = tirante, 3 = máximo). */
  rejilla(canal) {
    const b = new Float32Array(this.W * this.H * 4);
    this.r.readRenderTargetPixels(this.A, 0, 0, this.W, this.H, b);
    const out = new Float32Array(this.W * this.H);
    for (let i = 0; i < out.length; i++) out[i] = b[4 * i + canal];
    return out;
  }
}
