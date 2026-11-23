// Escenarios de lluvia del simulador.
//
//  · Diseño (IDF de SENAMHI): I = k·T^m / D^n  [mm/h], T en años, D en horas (válida de 1 a 24 h).
//    El hietograma se arma por bloques alternos de 1 h (Chow, Maidment y Mays, 1988): la lámina
//    acumulada P(d) = I(d)·d se diferencia hora a hora y los incrementos se ordenan con el mayor al
//    centro. Opcionalmente se reduce por área con la fórmula de Leclerc y Schaake (1972), ajuste de
//    las curvas del U.S. Weather Bureau (TP-29), porque la IDF es un valor puntual y el simulador
//    aplica la lluvia sobre toda la ciudad.
//  · Histórico (PISCOp v3.0): lluvia diaria real; cada día se reparte hora a hora con la curva
//    horaria acumulada de la región de SENAMHI, ordenada como en su herramienta (pico al centro).
//  · Libre: intensidad constante; se informa su periodo de retorno equivalente según la IDF.
//
// Un hietograma es { paso_h, mmh: [intensidad de cada bloque en mm/h], titulo, detalle, fuente }.

export const PERIODOS = [2, 5, 10, 30, 50, 100];
export const DURACIONES = [1, 2, 3, 6, 12, 24];

export const intensidad = (p, T, D) => (p.k * Math.pow(T, p.m)) / Math.pow(D, p.n);
export const periodoRetorno = (p, I, D) => Math.pow((I * Math.pow(D, p.n)) / p.k, 1 / p.m);

/** Factor de reducción por área (Leclerc y Schaake, 1972). D en horas, área en km². */
export function factorArea(D, areaKm2) {
  const t = Math.pow(D, 0.25), A = areaKm2 / 2.59;            // millas cuadradas
  return 1 - Math.exp(-1.1 * t) + Math.exp(-1.1 * t - 0.01 * A);
}

/** Ordena incrementos (de mayor a menor) con el mayor al centro, alternando derecha e izquierda. */
function bloquesAlternos(inc) {
  const v = [...inc].sort((a, b) => b - a), n = v.length, out = new Array(n).fill(0);
  const c = Math.ceil(n / 2) - 1;
  let der = c + 1, izq = c - 1;
  out[c] = v[0];
  for (let i = 1; i < n; i++) {
    if (i % 2 === 1 && der < n) out[der++] = v[i];
    else if (izq >= 0) out[izq--] = v[i];
    else out[der++] = v[i];
  }
  return out;
}

const r1 = (v) => Math.round(v * 10) / 10;
const fmt = (v, d = 0) => v.toLocaleString('es-PE', { minimumFractionDigits: d, maximumFractionDigits: d });
const NOMBRE_BANDA = { inferior: 'estimación baja', medio: 'estimación central', superior: 'estimación alta' };

/** Tormenta de diseño a partir de la IDF. */
export function diseno(lluvia, { T, D, clima, banda, arf }) {
  const p = lluvia.idf.parametros[clima][banda];
  const P = (d) => intensidad(p, T, d) * d;
  const inc = [];
  for (let d = 1; d <= D; d++) inc.push(P(d) - (d > 1 ? P(d - 1) : 0));
  const f = arf ? factorArea(D, lluvia.area_km2) : 1;
  const mmh = bloquesAlternos(inc).map((v) => v * f);
  const total = mmh.reduce((a, b) => a + b, 0);
  return {
    tipo: 'diseno', paso_h: 1, mmh, total, pico: Math.max(...mmh),
    titulo: `Lluvia de ${T} años · ${D} h`,
    detalle: `${fmt(total)} mm en ${D} h, pico de ${fmt(Math.max(...mmh), 1)} mm/h` +
      (arf ? ` (reducción por área ×${fmt(f, 2)})` : ' (valor puntual, sin reducción por área)') +
      `. Curvas IDF de SENAMHI, región ${lluvia.idf.region}, ${clima === '2050' ? 'clima proyectado al 2050' : 'clima actual'}, ${NOMBRE_BANDA[banda]}.`,
  };
}

/** Evento histórico de PISCOp repartido hora a hora con la curva regional de SENAMHI. */
export function historico(lluvia, idEvento) {
  const ev = lluvia.pisco.eventos.find((e) => e.id === idEvento) || lluvia.pisco.eventos[0];
  const fr = lluvia.idf.fracciones_horarias;
  const mmh = ev.dias.flatMap((dia) => bloquesAlternos(fr.map((v, i) => (v - (i ? fr[i - 1] : 0)) * dia.mm)));
  const diarios = ev.dias.map((d) => fmt(d.mm)).join(' + ');
  return {
    tipo: 'historico', paso_h: 1, mmh, total: ev.total_mm, pico: Math.max(...mmh),
    titulo: `${ev.nombre} · ${ev.periodo}`,
    detalle: `${fmt(ev.total_mm)} mm en ${ev.dias.length} ${ev.dias.length > 1 ? 'días' : 'día'} (${diarios} mm), según PISCOp v3.0 (celda de 0,1°). ` +
      `Cada día se reparte hora a hora con la curva de la región ${lluvia.idf.region} de SENAMHI.` +
      (ev.dias.length > 1 ? ' Son varios días simulados: sube la velocidad para verlo en pocos minutos.' : ''),
  };
}

/** Intensidad constante elegida por el usuario. */
export function libre(lluvia, { I, D, clima }) {
  const paso = 0.5, n = Math.max(1, Math.round(D / paso));
  const mmh = new Array(n).fill(I);
  let detalle = `${fmt(I * D)} mm a ${fmt(I)} mm/h durante ${fmt(D, 1)} h.`;
  if (lluvia && I > 0) {
    const T = periodoRetorno(lluvia.idf.parametros[clima || 'actual'].medio, I, Math.max(1, D));
    detalle += ` Según la IDF de SENAMHI, una lluvia así se repite en promedio cada ${T > 10000 ? 'más de 10 000' : fmt(T, T < 10 ? 1 : 0)} años (valor puntual).`;
  }
  return { tipo: 'libre', paso_h: paso, mmh, total: I * D, pico: I, titulo: `Lluvia constante de ${fmt(I)} mm/h`, detalle };
}

/** Intensidad (mm/h) en el instante t (s). */
export const tasa = (h, t) => (h ? h.mmh[Math.floor(t / (h.paso_h * 3600))] || 0 : 0);
/** Lluvia acumulada (mm) hasta t (s). */
export function acumulada(h, t) {
  if (!h) return 0;
  const b = h.paso_h * 3600, k = Math.floor(t / b);
  let s = 0;
  for (let i = 0; i < Math.min(k, h.mmh.length); i++) s += h.mmh[i] * h.paso_h;
  if (k < h.mmh.length) s += h.mmh[k] * ((t - k * b) / 3600);
  return s;
}
export const duracionS = (h) => (h ? h.mmh.length * h.paso_h * 3600 : 0);

/** Dibuja el hietograma en un <svg> (barras por bloque y línea del tiempo actual). */
export function dibujarHietograma(svg, h, t) {
  const W = Math.max(200, svg.clientWidth || 260), H = 92, ml = 4, mr = 4, mt = 16, mb = 16;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, at, txt) => { const e = document.createElementNS(ns, tag); for (const k in at) e.setAttribute(k, at[k]); if (txt != null) e.textContent = txt; return e; };
  svg.replaceChildren();
  if (!h || !h.mmh.length) return;
  const n = h.mmh.length, max = Math.max(1, h.pico), bw = (W - ml - mr) / n;
  svg.append(el('line', { x1: ml, x2: W - mr, y1: H - mb, y2: H - mb, class: 'h-eje' }));
  h.mmh.forEach((v, i) => {
    const alto = (v / max) * (H - mt - mb);
    svg.append(el('rect', { x: ml + i * bw + (bw > 4 ? 0.6 : 0), width: Math.max(0.8, bw - (bw > 4 ? 1.2 : 0)), y: H - mb - alto, height: Math.max(0, alto), rx: Math.min(2, bw / 3), class: 'h-bar' }));
  });
  const horas = n * h.paso_h;
  svg.append(el('text', { x: ml, y: 11, class: 'h-txt' }, `máx. ${fmt(h.pico, 1)} mm/h`));
  svg.append(el('text', { x: W - mr, y: H - 3, class: 'h-txt', 'text-anchor': 'end' }, `${fmt(horas, horas % 1 ? 1 : 0)} h`));
  svg.append(el('text', { x: ml, y: H - 3, class: 'h-txt' }, '0 h'));
  const x = ml + Math.min(1, t / (horas * 3600)) * (W - ml - mr);
  svg.append(el('line', { x1: x, x2: x, y1: mt - 4, y2: H - mb, class: 'h-ahora' }));
}
