/**
 * GEM-15 · Costa norte del Perú — análisis de relieve y lluvia para el simulador 3D
 * Pegar en https://code.earthengine.google.com y ejecutar.
 *
 * Capas:
 *   - GEM-15 v1 (Google Research, CC-BY 4.0): dtm (terreno), dsm_percentile_95 (superficie)
 *   - Altura de edificaciones = DSM p95 − DTM, recortada con Open Buildings v3
 *   - Índice de zonas bajas (cota relativa a 300 m) y depresiones donde se empoza la lluvia
 *   - Sentinel-2 SR (Cloud Score+) — imagen de fondo del simulador
 *   - CHIRPS diario — lluvia máxima diaria por año, para calibrar los escenarios
 * Exporta a Google Drive en UTM 17S (EPSG:32717) con la misma rejilla de 15 m de GEM-15.
 */

// ---------------------------------------------------------------- Ciudades
var CIUDADES = {
  'Piura':      {c: [-80.640, -5.185], w: 15.3, h: 13.2},
  'Sullana':    {c: [-80.685, -4.900], w: 10.5, h: 9.0},
  'Tumbes':     {c: [-80.455, -3.568], w: 10.5, h: 9.0},
  'Talara':     {c: [-81.270, -4.580], w: 9.0,  h: 8.0},
  'Paita':      {c: [-81.110, -5.085], w: 8.0,  h: 7.0},
  'Chulucanas': {c: [-80.162, -5.093], w: 7.0,  h: 6.0},
  'Chiclayo':   {c: [-79.840, -6.770], w: 15.0, h: 13.5},
  'Trujillo':   {c: [-79.025, -8.100], w: 15.3, h: 14.0}
};
var UTM = 'EPSG:32717';
var CELDA = 15;

// ---------------------------------------------------------------- Datos base
var gem = ee.ImageCollection('projects/climate-and-sustainability/assets/gem-15_v1').mosaic();
var dtm = gem.select('dtm').reproject({crs: UTM, scale: CELDA});
var dsm95 = gem.select('dsm_percentile_95').reproject({crs: UTM, scale: CELDA});

// GEM-15 enmascara el agua: se rellena con Copernicus GLO-30 para tener un terreno continuo
var glo30 = ee.ImageCollection('COPERNICUS/DEM/GLO30').select('DEM').mosaic()
  .resample('bilinear').reproject({crs: UTM, scale: CELDA});
var dtmContinuo = dtm.unmask(glo30).rename('dtm');
var huecos = dtm.mask().not().selfMask().rename('sin_dato_gem15');

var edificios = ee.FeatureCollection('GOOGLE/Research/open-buildings/v3/polygons')
  .filter(ee.Filter.gte('confidence', 0.70));
var mascaraEdif = ee.Image(0).byte().paint(edificios, 1).reproject({crs: UTM, scale: 3})
  .reduceResolution({reducer: ee.Reducer.mean(), maxPixels: 64})
  .reproject({crs: UTM, scale: CELDA}).rename('cobertura');
var alturaEdif = dsm95.subtract(dtm).max(0).updateMask(mascaraEdif.gt(0.3)).rename('altura_edif');

// Zonas bajas: diferencia con el mínimo en 300 m (≈ cota sobre el fondo local)
var cotaRel = dtmContinuo.subtract(dtmContinuo.focalMin({radius: 300, units: 'meters'})).rename('cota_relativa');
// Depresiones: puntos más de 0,5 m por debajo del promedio en 150 m (posible empozamiento)
var depresion = dtmContinuo.focalMean({radius: 150, units: 'meters'}).subtract(dtmContinuo)
  .rename('profundidad_depresion').updateMask(dtmContinuo.focalMean({radius: 150, units: 'meters'}).subtract(dtmContinuo).gt(0.5));

var pendiente = ee.Terrain.slope(dtmContinuo).rename('pendiente');
var hillshade = ee.Terrain.hillshade(dtmContinuo.multiply(3));

// ---------------------------------------------------------------- Sentinel-2
function sentinel2(region) {
  var cs = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
  return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(region).filterDate('2024-05-01', '2026-11-01')
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
    .linkCollection(cs, ['cs_cdf'])
    .map(function (i) { return i.updateMask(i.select('cs_cdf').gte(0.65)); })
    .median().select(['B4', 'B3', 'B2']);
}

// ---------------------------------------------------------------- Lluvia CHIRPS
function seriesLluvia(punto) {
  var chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY').select('precipitation');
  var anios = ee.List.sequence(1981, 2025);
  return ee.FeatureCollection(anios.map(function (a) {
    var col = chirps.filter(ee.Filter.calendarRange(a, a, 'year'));
    var red = function (img) {
      return img.reduceRegion({reducer: ee.Reducer.mean(), geometry: punto.buffer(6000), scale: 5566}).get('precipitation');
    };
    return ee.Feature(null, {anio: a, max_diaria_mm: red(col.max()), total_anual_mm: red(col.sum())});
  }));
}

// ---------------------------------------------------------------- Interfaz
var paleta = ['#0b3d0b', '#2f7d32', '#9ccc65', '#fff59d', '#f6c26b', '#d98c4a', '#9c5a3c', '#ffffff'];
var panel = ui.Panel({style: {width: '330px', padding: '8px'}});
panel.add(ui.Label('GEM-15 · Costa norte del Perú', {fontWeight: 'bold', fontSize: '16px'}));
panel.add(ui.Label('Relieve de 15 m para el simulador de lluvias 3D. Elige una ciudad:', {fontSize: '12px'}));
var selector = ui.Select({items: Object.keys(CIUDADES), value: 'Piura', onChange: mostrar});
panel.add(selector);
var info = ui.Panel();
panel.add(info);
ui.root.insert(0, panel);

function mostrar(nombre) {
  var c = CIUDADES[nombre];
  var region = ee.Geometry.Rectangle(
    [c.c[0] - c.w / 222, c.c[1] - c.h / 222, c.c[0] + c.w / 222, c.c[1] + c.h / 222], null, false);
  var punto = ee.Geometry.Point(c.c);
  Map.layers().reset();
  Map.centerObject(region, 13);

  var zStats = dtmContinuo.reduceRegion({reducer: ee.Reducer.percentile([2, 98]), geometry: region, scale: 30, maxPixels: 1e9});
  zStats.evaluate(function (s) {
    var lo = s.dtm_p2, hi = s.dtm_p98;
    Map.addLayer(sentinel2(region).clip(region), {min: 200, max: 2600, gamma: 1.1}, 'Sentinel-2 (color verdadero)', true);
    Map.addLayer(dtmContinuo.clip(region), {min: lo, max: hi, palette: paleta}, 'GEM-15 DTM (m s.n.m.)', false);
    Map.addLayer(hillshade.clip(region), {min: 60, max: 250}, 'Sombreado (×3)', false, 0.5);
    Map.addLayer(cotaRel.clip(region), {min: 0, max: 8, palette: ['#08306b', '#4292c6', '#c6dbef', '#ffffff00']}, 'Zonas bajas (cota relativa, m)', true, 0.7);
    Map.addLayer(depresion.clip(region), {min: 0.5, max: 3, palette: ['#9ecae1', '#08519c']}, 'Depresiones / empozamiento (m)', false);
    Map.addLayer(alturaEdif.clip(region), {min: 0, max: 25, palette: ['white', 'darkgreen']}, 'Altura de edificaciones (DSM−DTM)', false);
    Map.addLayer(huecos.clip(region), {palette: ['#00e5ff']}, 'Sin dato GEM-15 (agua / cauces)', true);
    Map.addLayer(edificios.filterBounds(region).style({color: 'ff6d00', width: 0.5, fillColor: '00000000'}), {}, 'Open Buildings v3', false);
  });

  info.clear();
  info.add(ui.Label('Lluvia histórica (CHIRPS, radio 6 km)', {fontWeight: 'bold', margin: '10px 0 0 0'}));
  var serie = seriesLluvia(punto);
  info.add(ui.Chart.feature.byFeature(serie, 'anio', ['max_diaria_mm'])
    .setChartType('ColumnChart')
    .setOptions({title: 'Lluvia máxima diaria por año (mm)', legend: {position: 'none'},
                 hAxis: {format: '####'}, vAxis: {title: 'mm/día'}, colors: ['#1b6ee0']}));
  info.add(ui.Label('Usa estos picos para fijar Intensidad × Duración en el simulador ' +
                    '(p. ej. 90 mm/día ≈ 30 mm/h durante 3 h).', {fontSize: '11px', color: '#566570'}));

  var btn = ui.Button('Exportar capas a Drive', function () { exportar(nombre, region, serie); });
  info.add(btn);
}

function exportar(nombre, region, serie) {
  var pre = 'gem15_' + nombre.toLowerCase();
  var capas = dtmContinuo.addBands(dsm95.rename('dsm_p95')).addBands(alturaEdif.unmask(0))
    .addBands(mascaraEdif).addBands(huecos.unmask(0)).addBands(cotaRel).toFloat();
  Export.image.toDrive({image: capas.clip(region), description: pre + '_relieve', folder: 'simulador_lluvias',
    region: region, crs: UTM, crsTransform: [CELDA, 0, 0, 0, -CELDA, 0], maxPixels: 1e9});
  Export.image.toDrive({image: sentinel2(region).toUint16(), description: pre + '_sentinel2', folder: 'simulador_lluvias',
    region: region, crs: UTM, scale: 10, maxPixels: 1e9});
  Export.table.toDrive({collection: edificios.filterBounds(region), description: pre + '_edificios',
    folder: 'simulador_lluvias', fileFormat: 'GeoJSON'});
  Export.table.toDrive({collection: serie, description: pre + '_chirps_maximos', folder: 'simulador_lluvias', fileFormat: 'CSV'});
  print('Tareas creadas: ábrelas en la pestaña "Tasks" y pulsa RUN.');
}

mostrar('Piura');
