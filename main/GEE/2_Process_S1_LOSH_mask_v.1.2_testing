var image = ee.Image("projects/ee-iameztoy/assets/Lake_Tanganyika_Basin/WaterSurface/water_VH_01_2024");
Map.addLayer(image)

//----------------------------------------------------------------------------//
// USER PARAMETERS
//----------------------------------------------------------------------------//

// 1. Study-area geometry
// Area of interest: Lake Tanganyika basin (HYBAS_ID 1041259950)
var hydrobasins = ee.FeatureCollection("WWF/HydroSHEDS/v1/Basins/hybas_4")
  .filter(ee.Filter.eq('HYBAS_ID', 1041259950));
var aoi = hydrobasins.geometry();
Map.addLayer(aoi)
// Select band
var band = "VH"


// Temporal range for batch processing
var sY = 2015;
var sM = 8;  
var eY = 2025;
var eM = 8;

function makeDate(year, month) {
  var mm = month < 10 ? '0' + month : '' + month;
  return year + '-' + mm + '-01';
}

var sD = makeDate(sY, sM); // "2024-01-01"
var eD = makeDate(eY, eM); 

// 2. Sentinel-1 band (both orbits) over your AOI  
var collection = ee.ImageCollection('COPERNICUS/S1_GRD')
  .filterBounds(aoi)
  .filterDate(sD, eD)
  .filter(ee.Filter.eq('instrumentMode', 'IW'))
  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', band));

// 3. DEM for slope/aspect
var DEM = ee.Image('USGS/SRTMGL1_003');

// 4. Layover toggle & angular margin
var includeLayover       = false;
var shadowAngleBufferDeg = 30;  // degrees

// 5. Export folder
var outFolder            = 
  'projects/hardy-tenure-383607/assets/Tanganyika/s1Preprocessing';


//----------------------------------------------------------------------------//
// YOUR makeMask(image) FUNCTION (unchanged)
//----------------------------------------------------------------------------//
function makeMask(image) {
  var toRad     = Math.PI / 180;
  var ninetyRad = ee.Image.constant(Math.PI / 2);
  
  //IA: We do 1, 2 and 4 to get rid of the long strip line in the edges that is not masked otherwise
  // This is because the "angle" band is not fully masked as VH/VV bands are.
  // 1) Band valid-data mask
  var dataMask = image.select(band).mask(); //This selects all valid values (no nodatas)

  // 2) erode footprint by 1px //We still need to erode further because a thin line of useless pixels remain.
  var safeFootprint = dataMask
    .focal_min({kernel: ee.Kernel.square(1), iterations: 1})
    .unmask(0);

  // 3) masked incidence angle
  var theta_i = image.select('angle')
                     .updateMask(dataMask)
                     .multiply(toRad);

  // 4) masked DEM in radar grid // We align also the dem with the VV/VH bands via the mask (dataMask created before)
  var proj = image.select(band).projection();
  var elev = DEM.resample('bilinear')
                .reproject({crs: proj, scale: proj.nominalScale()})
                //.clip(image.geometry()) // See version 1.1. I am testing this here. 
                .updateMask(dataMask);

  // 5) slope & uphill aspect (rad)
  var slope     = ee.Terrain.slope(elev).multiply(toRad);
  var aspectDeg = ee.Terrain.aspect(elev);
  var aspectRad = aspectDeg
    .where(aspectDeg.gt(180), aspectDeg.subtract(360))
    .multiply(-1).multiply(toRad);

  // 6) look-direction (rad)
  var headingDeg = ee.Dictionary(
    ee.Terrain.aspect(image.select('angle'))
      .reduceRegion(ee.Reducer.mean(), image.geometry(), 1000)
  ).getNumber('aspect');
  var headingRad = headingDeg.mod(360).subtract(180).multiply(toRad);

  // 7) range-slope αᵣ (rad)
  var phi_r   = ee.Image.constant(headingRad).subtract(aspectRad);
  var alpha_r = slope.tan().multiply(phi_r.cos()).atan();

  // 8) shifted shadow threshold (rad)
  var shadowBufRad = ee.Image.constant(shadowAngleBufferDeg).multiply(toRad);
  var rawThresh    = ninetyRad.subtract(theta_i).multiply(-1);
  var threshRad    = rawThresh.add(shadowBufRad);

  // 9) shadow mask
  var shadowMask = alpha_r.gt(threshRad).rename('shadow_mask');
  var mask       = shadowMask;

  // 10) optional layover
  if (includeLayover) {
    var layMask = alpha_r.lt(theta_i).rename('layover_mask');
    mask = mask.or(layMask);
  }

  // 11) clip out 1-px border
  mask = mask.updateMask(safeFootprint);
  

  return mask.copyProperties(image, ['system:time_start']);
}


//----------------------------------------------------------------------------//
// HELPER: build client list of months
//----------------------------------------------------------------------------//
function makeMonthList(sY, sM, eY, eM) {
  var list = [], y = sY, m = sM;
  while (true) {
    list.push({ year: y, month: m });
    if (y === eY && m === eM) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return list;
}

// Generate months from Jan 2024 to Mar 2025
var monthList = makeMonthList(sY, sM, eY, eM);


//----------------------------------------------------------------------------//
// LOOP: build & export one shadow mask per month
//----------------------------------------------------------------------------//
monthList.forEach(function(d) {
  // start/end of month
  var start = ee.Date.fromYMD(d.year, d.month, 1);
  var end   = start.advance(1, 'month');
  var mon   = (d.month < 10 ? '0' : '') + d.month;
  var year  = d.year;

  // Filter Sentinel-1 for that month
  var monthlyS1 = collection.filterDate(start, end);

  // Map shadow mask over every scene → ImageCollection of masks
  var monthlyMasks = monthlyS1.map(makeMask);

  // Union-reduce (max) to get any‐shadow per pixel
  var monthlyMask = ee.Image(monthlyMasks.min()).clip(aoi)
    .rename('shadow_mask');
  Map.addLayer(monthlyMask)
  // Export single monthly mask
  Export.image.toAsset({
    image:       monthlyMask,
    description: 'shadow_'+ year + mon,
    assetId:     outFolder + '/shadow_' + year + mon,
    region:      aoi,
    scale:       10,
    crs:        'EPSG:4326',
    maxPixels:   1e13,
    pyramidingPolicy: { '.default': 'mode' }
  });
});
