var export_a = 
    /* color: #d63000 */
    /* shown: false */
    /* displayProperties: [
      {
        "type": "rectangle"
      }
    ] */
    ee.Geometry.Polygon(
        [[[28.9685948490503, -0.97421531796064],
          [28.9685948490503, -1.7320550360663862],
          [29.53164416545655, -1.7320550360663862],
          [29.53164416545655, -0.97421531796064]]], null, false),
    geometry = /* color: #1fd62d */ee.Geometry.MultiPoint(
        [[29.149525940358735, -1.3496995000901624],
         [29.08669787639389, -1.394661882347251],
         [29.202397644460298, -1.4681100204512008],
         [29.233983337819673, -1.4361912591539],
         [29.256642639577485, -1.3438646255950093]]);


/*************************
 * 1)  SEARCH AREA (AOI) *
 *************************/


Map.centerObject(export_a, 11);           // zoom to AOI
//Map.addLayer(geometry, {color: 'white'}, 'Search Area');
Map.setOptions('SATELLITE');              // high-res basemap


/*********************************
 * 2)  REFERENCE “LAVA” SAMPLES  *
 *********************************/
// The tutorial expects a FeatureCollection called `samples`
var samples = ee.FeatureCollection(
  ee.Geometry.MultiPoint([
    [29.149525940358735, -1.3496995000901624],
         [29.08669787639389, -1.394661882347251],
         [29.202397644460298, -1.4681100204512008],
         [29.233983337819673, -1.4361912591539],
         [29.256642639577485, -1.3438646255950093]
  ]).coordinates().map(function(c) {
    c = ee.List(c);
    return ee.Feature(ee.Geometry.Point([c.get(0), c.get(1)]));
  })
);

Map.addLayer(samples, {color: 'red'}, 'Lava samples');


/*******************************
 * 3)  CHOOSE YEAR & TIME-SPAN *
 *******************************/
var year       = 2024;
var startDate  = ee.Date.fromYMD(year, 1, 1);
var endDate    = startDate.advance(1, 'year');


/*********************************************
 * 4)  MOSAIC THE SATELLITE EMBEDDING LAYERS *
 *********************************************/
var embeddings = ee.ImageCollection('GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL');

var mosaic = embeddings
  .filter(ee.Filter.date(startDate, endDate))
  .filterBounds(export_a)        // speeds things up
  .mosaic();                     // single 64-band image


/**********************************************
 * 5)  EXTRACT EMBEDDING VECTORS AT SAMPLES   *
 **********************************************/
var scale  = 10;                 // native 10 m resolution

var sampleEmbeddings = mosaic.sampleRegions({
  collection: samples,
  scale: scale
});


/****************************************
 * 6)  COMPUTE DOT-PRODUCT SIMILARITIES *
 ****************************************/
// For every sample feature, turn its 64 values into
// a 1-pixel 64-band image, take dot product with mosaic.
var bandNames = mosaic.bandNames();   // ["A00", …, "A63"]

var sampleDistances = ee.ImageCollection(sampleEmbeddings.map(function (f) {
  // Convert feature properties → 64-band constant image
  var vec = ee.Image.constant(f.toArray(bandNames))
                    .arrayFlatten([bandNames]);
  // Dot product (= cosine similarity because vectors are unit length)
  var dot = vec.multiply(mosaic).reduce('sum')
               .rename('similarity');
  return dot;
}));

// Mean similarity from all reference points
var meanSimilarity = sampleDistances.mean();


/*************************************
 * 7)  VISUALISE CONTINUOUS SIMILARITY *
 *************************************/
var palette = [
  '000004','2C105C','711F81','B63679',
  'EE605E','FDAE78','FCFDBF','FFFFFF'
];

Map.addLayer(
  meanSimilarity.clip(export_a),
  {palette: palette, min: 0, max: 1},
  'Cosine similarity (bright = close)',
  false   // off by default – toggle in Layers panel
);


/************************************
 * 8)  BINARY MASK OF “LAVA-LIKE”   *
 ************************************/
var threshold    = 0.80;        // experiment 0.90 – 0.98
var lavaMask     = meanSimilarity.gt(threshold);

// Convert matching pixels → polygons → centroids (as in tutorial)
var polygons = lavaMask.selfMask().reduceToVectors({
  scale: scale,
  eightConnected: false,
  maxPixels: 1e10,
  geometry: export_a
});

var predictedMatches = polygons.map(function(f){
  return f.centroid({maxError: 1});
});

Map.addLayer(
  lavaMask.updateMask(lavaMask),
  {palette: ['magenta']},
  'Similarity > ' + threshold
);
Map.addLayer(predictedMatches, {color: 'cyan'}, 'Predicted lava pixels');


/**************************************
 * 9)  OPTIONAL: EXPORT THE MATCHES   *
 **************************************/
//   • export *vector* points (matches) OR
//   • export *raster* mask – pick one or comment out as needed

// ---- export vector points ----
// Export.table.toDrive({
//   collection: predictedMatches,
//   description: 'lava_similarity_points_' + year,
//   fileFormat: 'GeoJSON'
// });

// ---- export raster mask ----
// Export.image.toDrive({
//   image: lavaMask.toByte(),
//   description: 'lava_similarity_mask_' + year,
//   region: geometry,
//   scale: scale,
//   maxPixels: 1e10
// });

// ---- export raster mask to Asset ----
Export.image.toAsset({
  image: lavaMask.toByte(),
  description: 'lava_similarity_mask_' + year,
  assetId: 'your-asset-path/lava_similarity_mask_' + year, // <-- edit
  region: export_a,
  scale: scale,
  maxPixels: 1e10,
  pyramidingPolicy: {'.default': 'mode'}   // keeps mask binary
});
