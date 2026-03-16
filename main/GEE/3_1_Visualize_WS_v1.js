// 1. AOI & slope mask
var hydrobasins = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_4')
  .filter(ee.Filter.eq('HYBAS_ID', 1041259950));
var aoi = hydrobasins.geometry();

Map.addLayer(aoi, {}, "AOI", 0)

// DEM and slope
var dem = ee.Image('USGS/SRTMGL1_003')
  .select('elevation')
  .clip(aoi);
var slope = ee.Terrain.slope(dem);         // degrees

var sl_thr = 100 // Set e.g., 15 if we want to add a mask, otherwise 100 (or disable the masking option)

var slopeMask = slope.lte(sl_thr);             // true where slope ≤ x°

var str ="2015-03-01"
var end = "2025-08-28"

// 2. Load your WaterSurface collection
var waterCol = ee.ImageCollection(
  'projects/ee-iameztoy/assets/Lake_Tanganyika_Basin/WaterSurface'
  
);
print(waterCol)


// 3. Parse system:index into properties and set system:time_start
function setProps(img) {
  var parts = ee.String(img.get('system:index')).split('_');
  var band  = parts.get(1);                   // 'VV' or 'VH'
  var month = ee.Number.parse(parts.get(2));  // 1–12
  var year  = ee.Number.parse(parts.get(3));  // e.g. 2023
  var date  = ee.Date.fromYMD(year, month, 1);
  return img
    .set({
      'band':  band,
      'month': month,
      'year':  year
    })
    // Allows filterDate() to work on our parsed date
    .set('system:time_start', date.millis());
}

var withProps = waterCol.map(setProps);


// 4. Filter by date range (Nov 2023 – Mar 2025)
var filtered = withProps.filterDate(str, end);
print(filtered)

// 5. Mask out steep slopes (> 11°)
var masked = filtered.map(function(img) {
  return img.updateMask(slopeMask);
});

// 6. Split into VV and VH collections
var vvCol = masked.filter(ee.Filter.eq('band', 'VV'))
                  .select([0], ['water']);  // rename to 'water'
var vhCol = masked.filter(ee.Filter.eq('band', 'VH'))
                  .select([0], ['water']);

// 7. Compute **five** separate stats per band

// VV statistics as single-band images
var vv_sum  = vvCol.reduce(ee.Reducer.sum()).rename('water_sum');


// VH statistics as single-band images
var vh_sum  = vhCol.reduce(ee.Reducer.sum()).rename('water_sum');

// 8. Visualize each result

Map.addLayer(slope,     {min: 0, max: 60}, 'Slope (°)', 0);
Map.addLayer(slopeMask.not().selfMask(), {palette: "red"}, 'Slope ≤ 12° mask', 0);

var visualization = {
  //bands: ['occurrence'],
  min: 1.0,
  max: 17.0,
  palette: ['ffffff', 'ffbbbb', '0000ff']
};

// VV layers
Map.addLayer(vv_sum,  visualization, 'VV: Sum', 1);
// VH layers
Map.addLayer(vh_sum,  visualization, 'VH: Sum', 0);


Map.setOptions('SATELLITE');
//#######################################################

// Sentinel-1 shadows

var shadows = ee.ImageCollection("projects/hardy-tenure-383607/assets/Tanganyika/s1Preprocessing");
var shadows_inv = shadows.map(function(img) {return img.eq(0);});

var palettes = require('users/gena/packages:palettes');
var palette = palettes.colorbrewer.RdYlGn[9];

Map.addLayer(shadows_inv.sum().selfMask(), {min: 1, max: 110, palette: palette}, "Shadows Sum", 0);

//########################################################

// JRC surface:

var dataset = ee.Image('JRC/GSW1_4/GlobalSurfaceWater');

var visualization = {
  bands: ['occurrence'],
  min: 0.0,
  max: 100.0,
  palette: ['ffffff', 'ffbbbb', '0000ff']
};


Map.addLayer(dataset, visualization, 'Occurrence', 0);



var dataset = ee.ImageCollection('JRC/GSW1_4/YearlyHistory');

var visualization = {
  bands: ['waterClass'],
  min: 0.0,
  max: 3.0,
  palette: ['cccccc', 'ffffff', '99d9ea', '0000ff']
};


Map.addLayer(dataset, visualization, 'JRC Water Class', 0);

//###############################

// Construct a collection of corresponding Dynamic World and Sentinel-2 for
// inspection. Filter by region and date.


// 1. AOI & slope mask
var hydrobasins = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_4')
  .filter(ee.Filter.eq('HYBAS_ID', 1041259950));
var aoi = hydrobasins.geometry();

var str_dw = "2023-11-01"
var end_dw = "2024-05-01"
var dw = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1').filterBounds(aoi).filterDate(str_dw, end_dw);

//print(dwCol)

var dwl = dw.select("label"); //.filterBounds(AOIpt)
var dwMode = dwl.reduce(ee.Reducer.mode()); //Mode reducer for the period selected
var dw_tree = dwMode.eq(1).rename(['dw_trees']);  
var dw_shrub = dwMode.eq(5).rename(['dw_shrub']); 
var dw_grass = dwMode.eq(2).rename(['dw_grass']); 
var dw_crop = dwMode.eq(4).rename(['dw_crop']); 
var dw_built = dwMode.eq(6).rename(['dw_built']); 
var dw_bare = dwMode.eq(7).rename(['dw_bare']); 
var dw_snow = dwMode.eq(8).rename(['dw_snow']); 
var dw_water = dwMode.eq(0).rename(['dw_water']); 
var dw_floodv = dwMode.eq(3).rename(['dw_floodv']); 

var mix = dw_crop.or(dw_grass).or(dw_shrub); //.or(dw_tree); //Including bare and built-up is problematic : removes water within the lake | .or(dw_bare).or(dw_built)
Map.addLayer(mix.clip(aoi).selfMask(), {palette: "orange"}, "DW reduced select");


Map.addLayer(dw_tree.clip(aoi).selfMask(), {palette: "orange"}, "DW reduced Trees", 0);
Map.addLayer(dw_shrub.clip(aoi).selfMask(), {palette: "orange"}, "DW reduced Shrubs", 0);
Map.addLayer(dw_grass.clip(aoi).selfMask(), {palette: "orange"}, "DW reduced Grass", 0);
Map.addLayer(dw_crop.clip(aoi).selfMask(), {palette: "orange"}, "DW reduced Crops", 0);
Map.addLayer(dw_built.clip(aoi).selfMask(), {palette: "orange"}, "DW reduced Built", 0);
Map.addLayer(dw_bare.clip(aoi).selfMask(), {palette: "orange"}, "DW reduced Bare soil", 0);
Map.addLayer(dw_snow.clip(aoi).selfMask(), {palette: "orange"}, "DW reduced Snow", 0);
Map.addLayer(dw_water.clip(aoi).selfMask(), {palette: "orange"}, "DW reduced Waters", 0);
Map.addLayer(dw_floodv.clip(aoi).selfMask(), {palette: "orange"}, "DW reduced Flooded Veg.", 0);

// HAND

//var hand_jf      =       ee.Image("users/pekeljf/HAND/HAND_2021");
var hand_merit = ee.Image("MERIT/Hydro/v1_0_1").select("hnd").clip(aoi);
var hand_thr = hand_merit.gt(48.8)  // Global masking threshold 48.8

Map.addLayer(hand_merit, {"min":0,"max":600}, "HAND MERIT", 0)
Map.addLayer(hand_thr.selfMask(), {}, "HAND THR")


dw_tree = dw_tree.clip(aoi)
mix = mix.clip(aoi)

var mix_tree = ((dw_tree.add(mix)).mask().eq(0)).clip(aoi)
Map.addLayer(mix_tree, {}, "MIX Tree Masked")

var hand_mask = hand_merit.updateMask(mix_tree)
Map.addLayer(hand_mask, {"opacity":1,"bands":["hnd"],"min":0,"max":157.9000244140625,"gamma":1}, "HAND MERIT MASKED", 1);

var sum_bands = (vv_sum.unmask().add(vh_sum.unmask())).gt(0).selfMask()
Map.addLayer(sum_bands, {"palette":["12a7ff"]}, "VV/VH water")

var hand_in_bands = hand_mask.updateMask(sum_bands)
Map.addLayer(hand_in_bands, {"min":0,"max":681.449951171875,"palette":["76e6ff","fff4a9","ffb28d","ff6f4e","ff0000"]}, "HAND in Target pixels");



////###################### 
// LAVA Google Embeddings

var lavaFlows = ee.Image("projects/hardy-tenure-383607/assets/Tanganyika/lava_similarity_mask_2024");
Map.addLayer(lavaFlows.selfMask(), {"palette":["orange"]}, "Lava Flows - Embeddings")
