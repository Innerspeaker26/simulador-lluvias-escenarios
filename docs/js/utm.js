// Conversión exacta WGS 84 geográficas <-> UTM (series de Krüger, error < 1 mm dentro de la zona).
const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, E0 = 500000;
const n = f / (2 - f), n2 = n * n, n3 = n2 * n;
const A = (a / (1 + n)) * (1 + n2 / 4 + (n2 * n2) / 64);
const alfa = [n / 2 - (2 / 3) * n2 + (5 / 16) * n3, (13 / 48) * n2 - (3 / 5) * n3, (61 / 240) * n3];
const beta = [n / 2 - (2 / 3) * n2 + (37 / 96) * n3, (1 / 48) * n2 + (1 / 15) * n3, (17 / 480) * n3];
const delta = [2 * n - (2 / 3) * n2 - 2 * n3, (7 / 3) * n2 - (8 / 5) * n3, (56 / 15) * n3];
const c = (2 * Math.sqrt(n)) / (1 + n);
const rad = Math.PI / 180;

/** Meridiano central y falso norte a partir del EPSG (326zz norte / 327zz sur). */
export function zona(epsg) {
  const z = epsg % 100, sur = Math.floor(epsg / 100) === 327;
  return { lon0: (z - 1) * 6 - 180 + 3, N0: sur ? 10000000 : 0, z, sur };
}

/** lat, lon (grados) -> {E, N} en metros */
export function aUTM(lat, lon, epsg = 32717) {
  const { lon0, N0 } = zona(epsg);
  const phi = lat * rad, dl = (lon - lon0) * rad, s = Math.sin(phi);
  const t = Math.sinh(Math.atanh(s) - c * Math.atanh(c * s));
  const xi = Math.atan2(t, Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let E = eta, N = xi;
  for (let j = 1; j <= 3; j++) {
    E += alfa[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    N += alfa[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return { E: E0 + k0 * A * E, N: N0 + k0 * A * N };
}

/** E, N (metros) -> {lat, lon} en grados */
export function deUTM(E, N, epsg = 32717) {
  const { lon0, N0 } = zona(epsg);
  const xi = (N - N0) / (k0 * A), eta = (E - E0) / (k0 * A);
  let xp = xi, ep = eta;
  for (let j = 1; j <= 3; j++) {
    xp -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    ep -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xp) / Math.cosh(ep));
  let phi = chi;
  for (let j = 1; j <= 3; j++) phi += delta[j - 1] * Math.sin(2 * j * chi);
  return { lat: phi / rad, lon: lon0 + Math.atan2(Math.sinh(ep), Math.cos(xp)) / rad };
}
