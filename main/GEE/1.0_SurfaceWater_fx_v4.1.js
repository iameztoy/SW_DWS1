// ********************************************
// Multi-basin AOI helper for HydroBASINS hybas_4
// Use one or many HYBAS_ID values and build a single AOI geometry
// ********************************************

// One or more HydroBASINS IDs to combine
var HYBAS_IDS = [
  1041259950
  //, 1041259940
  //, 1041260000
];

// Optional: dissolve the merged geometry into a single-part geometry
// true  = dissolve internal basin boundaries
// false = keep the multipart geometry returned by the collection
var DISSOLVE_BASINS = true;

var hydrobasins_fc = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_4')
  .filter(ee.Filter.inList('HYBAS_ID', HYBAS_IDS));

print('Selected basins', hydrobasins_fc);
print('Number of selected basins', hydrobasins_fc.size());

// Geometry built from all selected features
var aoi = ee.Geometry(
  ee.Algorithms.If(
    DISSOLVE_BASINS,
    hydrobasins_fc.geometry().dissolve(),
    hydrobasins_fc.geometry()
  )
);

Map.centerObject(aoi, 7);
Map.addLayer(hydrobasins_fc, {}, 'Selected basin features');
Map.addLayer(aoi, {color: 'red'}, 'Merged AOI');

// Optional sanity check: if you want the AOI also as a single feature
var aoiFeature = ee.Feature(aoi, {
  basin_count: hydrobasins_fc.size(),
  hybas_ids: ee.List(HYBAS_IDS).join(',')
});

print('AOI feature', aoiFeature);
