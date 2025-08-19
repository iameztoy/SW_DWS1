// ********************************************
// 2025/07/21 Iban Ameztoy JRC Consultancy
// Batch water extraction: Dynamic World + Sentinel-1
// ********************************************

// ********************
// PARAMETERS
// ********************

// Area of interest: Lake Tanganyika basin (HYBAS_ID 1041259950)
var hydrobasins = ee.FeatureCollection("WWF/HydroSHEDS/v1/Basins/hybas_4")
  .filter(ee.Filter.eq('HYBAS_ID', 1041259950));
var aoi = hydrobasins.geometry();

// Temporal range for batch processing
var startYear  = 2015;
var startMonth =    8;  
var endYear    = 2021;
var endMonth   =   12;  

// Probability thresholds for Dynamic World
var water_thr      = 0.5; // We are currently not using this : See thresholds witihn the function | Process water mask fx.
var floodedveg_thr = 0.3;

// SAR band for Otsu thresholding (e.g., 'VH' or 'VV')
var band = 'VH';

// ********************
// Helper: generate list of {year, month} pairs
// ********************
function makeMonthList(sY, sM, eY, eM) {
  var list = [];
  var y = sY, m = sM;
  while (true) {
    list.push({ year: y, month: m });
    if (y === eY && m === eM) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return list;
}

var monthList = makeMonthList(startYear, startMonth, endYear, endMonth);

// ********************
// Main per-month processing
// ********************
function processMonth(y, m) {
  // Build start/end dates
  var startDate = ee.Date.fromYMD(y, m, 1);
  var endDate   = startDate.advance(1, 'month');
  var mStr = (m < 10 ? '0' + m : m.toString());

  // ── NEW: build clean, client‑side strings for name and path
  var desc      = 'water_' + band + '_' + mStr + '_' + y;
  var assetPath = 'projects/ee-iameztoy/assets/Lake_Tanganyika_Basin/WaterSurface/' + desc;

  // ********************
  // INPUT DATASETS
  // ********************

  var dwFiltered = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
      .filter(ee.Filter.date(startDate, endDate))
      .filter(ee.Filter.bounds(aoi));

  print(dwFiltered);

  var probabilityBands = [
    'water', 'trees', 'grass', 'flooded_vegetation', 'crops',
    'shrub_and_scrub', 'built', 'bare', 'snow_and_ice'
  ];
  var probabilityImage = dwFiltered.select(probabilityBands).mean();

  // ********************
  // 2. Extract Water (Dynamic World)
  // ********************
  
  //Side note: DW does not identify NODATAS correctly, many non-valid pixel values are = 0. 
  //Therefore, we need to differentiate also these. | Couldn´t have added eq = 0? (Double check)
  function processWaterMask(image) {
    var water = image.select('water');
    var waterMasked = water
      .where(water.lte(0.05), 0)
      .updateMask(water.gt(0.5).or(water.lte(0.05)))
      .where(water.gt(0.5), 1);
    return waterMasked.rename('water')
                     .copyProperties(image, image.propertyNames());
  }

  var waterMaskCollection = dwFiltered.map(processWaterMask);
  print('Water mask collection', waterMaskCollection);

  var waterOccurrence = waterMaskCollection.sum().rename('water');
  var water_dw = waterOccurrence.gt(0)
    .or(probabilityImage.select('flooded_vegetation').gt(floodedveg_thr));

  // ***************************************
  // DW No‑data mask
  var valid = water_dw.eq(0).or(water_dw.eq(1))
    .updateMask(water_dw.eq(0).or(water_dw.eq(1))).unmask();
  var dw_nodata = valid.eq(0).clip(aoi);

  // ***************************************
  // Sentinel‑1 and Otsu thresholding
  // ***************************************
  var s1Collection = ee.ImageCollection('COPERNICUS/S1_GRD')
      .filterBounds(aoi)
      .filterDate(startDate, endDate)
      .filter(ee.Filter.eq('instrumentMode', 'IW'))
      .filter(ee.Filter.listContains('transmitterReceiverPolarisation', band)); //added to avoid "bands missing" errors

  print("S1 Collection", s1Collection);

  var s1Image = s1Collection.min().clip(aoi);
  var histogramReducer = ee.Reducer.histogram(255, 0.1);

  var globalHistogram = ee.Dictionary(
    s1Image.select(band).reduceRegion({
      reducer: histogramReducer,
      geometry: aoi,
      scale: 90,
      maxPixels: 1e10
    }).get(band)
  );

  var x        = ee.List(globalHistogram.get('bucketMeans'));
  var yHist    = ee.List(globalHistogram.get('histogram'));
  var dataCol  = ee.Array.cat([x, yHist], 1).toList();
  var columnHeader = ee.List([[
    { label: 'Backscatter', role: 'domain', type: 'number' },
    { label: 'Values',      role: 'data',   type: 'number' }
  ]]);
  var dataTable = columnHeader.cat(dataCol);

  dataTable.evaluate(function(dataTableClient) {
    var chart = ui.Chart(dataTableClient)
      .setChartType('AreaChart')
      .setOptions({
        title: band + ' Global Histogram',
        hAxis: {
          title: 'Backscatter [dB]',
          viewWindow: { min: -35, max: 15 }
        },
        vAxis: { title: 'Count' }
      });
    print(chart);
  });

  function otsu(histogram) {
    histogram = ee.Dictionary(histogram);
    var counts = ee.Array(histogram.get('histogram'));
    var means  = ee.Array(histogram.get('bucketMeans'));
    var size   = means.length().get([0]);
    var total  = counts.reduce(ee.Reducer.sum(), [0]).get([0]);
    var sum    = means.multiply(counts)
                      .reduce(ee.Reducer.sum(), [0]).get([0]);
    var mean   = sum.divide(total);
    var indices = ee.List.sequence(1, size);
    var bss = indices.map(function(i) {
      var aCounts = counts.slice(0, 0, i);
      var aCount  = aCounts.reduce(ee.Reducer.sum(), [0]).get([0]);
      var aMeans  = means.slice(0, 0, i);
      var aMean   = aMeans.multiply(aCounts)
                         .reduce(ee.Reducer.sum(), [0]).get([0])
                         .divide(aCount);
      var bCount  = total.subtract(aCount);
      var bMean   = sum.subtract(aCount.multiply(aMean))
                         .divide(bCount);
      return aCount.multiply(aMean.subtract(mean).pow(2))
           .add(bCount.multiply(bMean.subtract(mean).pow(2)));
    });
    return means.sort(bss).get([-1]);
  }

  var globalThreshold = otsu(globalHistogram);
  print('Global threshold value:', globalThreshold);

  // Optional: annotate threshold on the histogram
  var thresholdCol = ee.List.repeat('', x.length());
  var threshIndex  = x.indexOf(globalThreshold);
  thresholdCol = thresholdCol.set(threshIndex, 'Otsu Threshold');
  columnHeader = ee.List([[
    { label: 'Backscatter', role: 'domain',      type: 'number' },
    { label: 'Values',      role: 'data',        type: 'number' },
    { label: 'Threshold',   role: 'annotation',  type: 'string' }
  ]]);
  dataCol = ee.List.sequence(0, x.length().subtract(1)).map(function(i) {
    i = ee.Number(i);
    var row = ee.List(dataCol.get(i));
    return row.add(ee.String(thresholdCol.get(i)));
  });
  dataTable = columnHeader.cat(dataCol);

  dataTable.evaluate(function(dataTableClient) {
    for (var i = 0; i < dataTableClient.length; i++) {
      if (dataTableClient[i][2] === '') {
        dataTableClient[i][2] = null;
      }
    }
    var chart = ui.Chart(dataTableClient)
      .setChartType('AreaChart')
      .setOptions({
        title: band + ' Global Histogram with Threshold annotation',
        hAxis: {
          title: 'Backscatter [dB]',
          viewWindow: { min: -35, max: 15 }
        },
        vAxis: { title: 'Count' },
        annotations: { style: 'line' }
      });
    print(chart);
  });

  // Apply threshold and combine with DW mask
  var s1_water    = s1Image.select(band).lt(globalThreshold).rename("water");
  var s1_water_mk = s1_water.updateMask(dw_nodata);
  water_dw = water_dw.unmask();
  s1_water_mk = s1_water_mk.unmask();
  var water_def = water_dw.add(s1_water_mk).gt(0).updateMask(water_dw.add(s1_water_mk).gt(0));
  
  //Otherwise:
  //var water_def = s1Image.select(band).lt(globalThreshold).updateMask(dw_nodata).unmask(0).or(water_dw.unmask(0)).selfMask();
  

  // #########################################
  // Post‑processing: remove small speckles
  var conpix    = water_def.connectedPixelCount(51, false).gte(50);
  var finalMask = water_def.updateMask(conpix);

  // 7) Export using clean names
  Export.image.toAsset({
    image: finalMask,
    description: desc,
    assetId:    assetPath,
    region:     aoi,
    scale:      10,
    crs:        'EPSG:4326',
    pyramidingPolicy: 'mode',
    maxPixels:  1e13
  });
}

// ********************
// Run batch with empty‑month check
// ********************
monthList.forEach(function(d) {
  var startDate = ee.Date.fromYMD(d.year, d.month, 1);
  var endDate   = startDate.advance(1, 'month');
  var dwTest = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
    .filterBounds(aoi)
    .filterDate(startDate, endDate);

  dwTest.size().getInfo(function(cnt) {
    if (cnt > 0) {
      processMonth(d.year, d.month);
    } else {
      var mStr = (d.month < 10 ? '0' + d.month : d.month);
      print('Skipping ' + d.year + '-' + mStr + ': no DW images.');
    }
  });
});
