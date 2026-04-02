// ********************************************
// 2025/07/21 Iban Ameztoy JRC Consultancy
// Batch water extraction: Dynamic World + Sentinel-1
// + QA mode for threshold comparison and processing diagnostics
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

// Optional year-based splitting to reduce memory pressure on long ranges.
// 0 or 1 = process as a single range (legacy behavior).
// >= 2   = split [startYear..endYear] into batches of N years.
var yearsPerBatch = 0;

// Probability thresholds for Dynamic World
var water_thr      = 0.5; // Currently not used directly inside processWaterMask()
var floodedveg_thr = 0.3;

// SAR band for Otsu thresholding (e.g., 'VH' or 'VV')
var band = 'VH';

// OTSU OPTION
// true  = use the safe Otsu implementation, which avoids the last-loop split
//         where one class becomes empty and can trigger division-by-zero.
// false = reproduce the original implementation for before/after comparison.
var USE_SAFE_OTSU = true;

// MAIN MODE
// false = normal raster export mode
// true  = QA mode only: export a monthly CSV table with thresholds and diagnostics
var RUN_THRESHOLD_QA_ONLY = true;

// QA OPTIONS
// In QA mode, include area diagnostics (DW no-data, S1 coverage, etc.)
var QA_INCLUDE_AREA_DIAGNOSTICS = true;

// In QA mode, include final output comparison between original/safe Otsu
// (areas from final masks and contribution of DW vs S1)
var QA_INCLUDE_OUTPUT_DIFFERENCE = true;

// QA EXPORT SETTINGS
var QA_EXPORT_DESCRIPTION = 'Tanganyika_threshold_QA_' + band + '_' + startYear + '_' + endYear;
var QA_EXPORT_FOLDER = 'EarthEngine';
var QA_FILE_PREFIX = 'Tanganyika_threshold_QA_' + band + '_' + startYear + '_' + endYear;

// Debug / visualization
var PRINT_COLLECTIONS = false;
var SHOW_HISTOGRAM_CHARTS = false;

// ********************
// HELPERS
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

function makeYearBatches(sY, sM, eY, eM, yearsStep) {
  if (yearsStep <= 1) {
    return [{
      startYear: sY,
      startMonth: sM,
      endYear: eY,
      endMonth: eM
    }];
  }

  var batches = [];
  var currentStartYear = sY;

  while (currentStartYear <= eY) {
    var currentEndYear = Math.min(currentStartYear + yearsStep - 1, eY);
    batches.push({
      startYear: currentStartYear,
      startMonth: currentStartYear === sY ? sM : 1,
      endYear: currentEndYear,
      endMonth: currentEndYear === eY ? eM : 12
    });
    currentStartYear = currentEndYear + 1;
  }

  return batches;
}

function monthKey(y, m) {
  return y + '-' + (m < 10 ? '0' + m : m.toString());
}

function monthStartString(y, m) {
  return y + '-' + (m < 10 ? '0' + m : m.toString()) + '-01';
}

function monthEndString(y, m) {
  var startDate = ee.Date.fromYMD(y, m, 1);
  var endDate = startDate.advance(1, 'month').advance(-1, 'day');
  return endDate.format('YYYY-MM-dd');
}

var aoiAreaKm2 = ee.Number(aoi.area(1)).divide(1e6);

// ********************
// CLIENT-SIDE MONTHLY COUNT MAPS
// One async retrieval per collection for the whole period
// ********************
function buildMonthlyCountMap(collection, startDate, endDate, callback) {
  collection
    .filterDate(startDate, endDate)
    .aggregate_array('system:time_start')
    .evaluate(function(times, err) {
      if (err) {
        print('Monthly count map error:', err);
        callback({});
        return;
      }

      var counts = {};
      (times || []).forEach(function(t) {
        var d = new Date(t);
        var key = d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2);
        counts[key] = (counts[key] || 0) + 1;
      });
      callback(counts);
    });
}

// ********************
// IMAGE / AREA HELPERS
// ********************
function processWaterMask(image) {
  var water = image.select('water');
  var waterMasked = water
    .where(water.lte(0.05), 0)
    .updateMask(water.gt(0.5).or(water.lte(0.05)))
    .where(water.gt(0.5), 1);

  return waterMasked.rename('water')
    .copyProperties(image, image.propertyNames());
}

function areaKm2FromMask(maskImage) {
  var area = ee.Image.pixelArea()
    .updateMask(maskImage)
    .reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: aoi,
      scale: 10,
      maxPixels: 1e13
    })
    .get('area');

  return ee.Number(ee.Algorithms.If(area, area, 0)).divide(1e6);
}

function intFlag(condition) {
  return ee.Number(ee.Algorithms.If(condition, 1, 0));
}

// ********************
// OTSU
// ********************
function otsuOriginal(histogram) {
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

function otsuSafe(histogram) {
  histogram = ee.Dictionary(histogram);

  var counts = ee.Array(histogram.get('histogram'));
  var means  = ee.Array(histogram.get('bucketMeans'));

  var size  = ee.Number(means.length().get([0]));
  var total = ee.Number(counts.reduce(ee.Reducer.sum(), [0]).get([0]));
  var sum   = ee.Number(
    means.multiply(counts).reduce(ee.Reducer.sum(), [0]).get([0])
  );
  var mean  = sum.divide(total);

  // Safe loop: stop at size - 1 so class B is never empty.
  var indices = ee.List.sequence(1, size.subtract(1));

  var bss = indices.map(function(i) {
    i = ee.Number(i);

    var aCounts = counts.slice(0, 0, i);
    var aCount  = ee.Number(aCounts.reduce(ee.Reducer.sum(), [0]).get([0]));

    var aMeans = means.slice(0, 0, i);
    var aMean  = ee.Number(
      aMeans.multiply(aCounts).reduce(ee.Reducer.sum(), [0]).get([0])
    ).divide(aCount);

    var bCount = total.subtract(aCount);
    var bMean  = sum.subtract(aCount.multiply(aMean)).divide(bCount);

    return aCount.multiply(aMean.subtract(mean).pow(2))
      .add(bCount.multiply(bMean.subtract(mean).pow(2)));
  });

  var candidateMeans = means.toList().slice(0, size.subtract(1));
  return ee.Number(candidateMeans.sort(bss).get(-1));
}

// ********************
// OPTIONAL HISTOGRAM CHARTS
// ********************
function printHistogramCharts(globalHistogram, thresholdValue, bandLabel) {
  if (!SHOW_HISTOGRAM_CHARTS) return;

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
        title: bandLabel + ' Global Histogram',
        hAxis: {
          title: 'Backscatter [dB]',
          viewWindow: { min: -35, max: 15 }
        },
        vAxis: { title: 'Count' }
      });
    print(chart);
  });

  var thresholdCol = ee.List.repeat('', x.length());
  var threshIndex  = x.indexOf(thresholdValue);
  thresholdCol = thresholdCol.set(threshIndex, 'Otsu Threshold');

  columnHeader = ee.List([[
    { label: 'Backscatter', role: 'domain',     type: 'number' },
    { label: 'Values',      role: 'data',       type: 'number' },
    { label: 'Threshold',   role: 'annotation', type: 'string' }
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
        title: bandLabel + ' Global Histogram with Threshold annotation',
        hAxis: {
          title: 'Backscatter [dB]',
          viewWindow: { min: -35, max: 15 }
        },
        vAxis: { title: 'Count' },
        annotations: { style: 'line' }
      });
    print(chart);
  });
}

// ********************
// QA FEATURE BUILDER
// One feature per month
// ********************
function buildQaFeature(y, m, dwCount, s1Count) {
  var key = monthKey(y, m);
  var mStr = (m < 10 ? '0' + m : m.toString());
  var startDate = ee.Date.fromYMD(y, m, 1);
  var endDate = startDate.advance(1, 'month');

  var hasDw = dwCount > 0;
  var hasS1 = s1Count > 0;

  var baseProps = {
    year: y,
    month: m,
    month_key: key,
    start_date: monthStartString(y, m),
    end_date: monthEndString(y, m),
    dw_available: hasDw ? 1 : 0,
    s1_available: hasS1 ? 1 : 0,
    dw_image_count: dwCount,
    s1_image_count: s1Count,
    aoi_area_km2: aoiAreaKm2,
    status_code: hasDw ? (hasS1 ? 'DW_AND_S1' : 'DW_ONLY_NO_S1') : 'NO_DW',

    threshold_original: null,
    threshold_safe: null,
    threshold_diff: null,
    threshold_abs_diff: null,
    threshold_same: null,

    dw_has_gaps: null,
    dw_valid_area_km2: null,
    dw_nodata_area_km2: null,
    dw_water_area_raw_km2: null,

    s1_valid_area_km2: null,
    s1_valid_gap_area_km2: null,
    s1_uncovered_gap_area_km2: null,
    unfilled_dw_gap_area_km2: null,

    final_water_area_orig_km2: null,
    final_dw_component_area_orig_km2: null,
    final_s1_component_area_orig_km2: null,

    final_water_area_safe_km2: null,
    final_dw_component_area_safe_km2: null,
    final_s1_component_area_safe_km2: null,

    final_water_area_diff_km2: null,
    final_water_area_abs_diff_km2: null,
    final_dw_component_area_diff_km2: null,
    final_s1_component_area_diff_km2: null
  };

  if (!hasDw) {
    return ee.Feature(null, baseProps);
  }

  // ---- DW ----
  var dwFiltered = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
    .filterBounds(aoi)
    .filterDate(startDate, endDate);

  if (PRINT_COLLECTIONS) print('DW', key, dwFiltered);

  var probabilityBands = [
    'water', 'trees', 'grass', 'flooded_vegetation', 'crops',
    'shrub_and_scrub', 'built', 'bare', 'snow_and_ice'
  ];

  var probabilityImage = dwFiltered.select(probabilityBands).mean();
  var waterMaskCollection = dwFiltered.map(processWaterMask);
  var waterOccurrence = waterMaskCollection.sum().rename('water');

  var water_dw = waterOccurrence.gt(0)
    .or(probabilityImage.select('flooded_vegetation').gt(floodedveg_thr));

  var valid = water_dw.eq(0).or(water_dw.eq(1))
    .updateMask(water_dw.eq(0).or(water_dw.eq(1)))
    .unmask();

  var dw_nodata = valid.eq(0).clip(aoi);
  var dw_valid_mask = valid.eq(1).selfMask();
  var water_dw_masked = water_dw.selfMask();

  var dwNodataAreaKm2 = areaKm2FromMask(dw_nodata);
  var dwValidAreaKm2 = areaKm2FromMask(dw_valid_mask);
  var dwWaterAreaRawKm2 = areaKm2FromMask(water_dw_masked);
  var dwHasGaps = intFlag(dwNodataAreaKm2.gt(0));

  // Start with DW-only defaults
  var props = {
    year: y,
    month: m,
    month_key: key,
    start_date: monthStartString(y, m),
    end_date: monthEndString(y, m),
    dw_available: 1,
    s1_available: hasS1 ? 1 : 0,
    dw_image_count: dwCount,
    s1_image_count: s1Count,
    aoi_area_km2: aoiAreaKm2,
    status_code: hasS1 ? 'DW_AND_S1' : 'DW_ONLY_NO_S1',

    dw_has_gaps: dwHasGaps,
    dw_valid_area_km2: QA_INCLUDE_AREA_DIAGNOSTICS ? dwValidAreaKm2 : null,
    dw_nodata_area_km2: QA_INCLUDE_AREA_DIAGNOSTICS ? dwNodataAreaKm2 : null,
    dw_water_area_raw_km2: QA_INCLUDE_AREA_DIAGNOSTICS ? dwWaterAreaRawKm2 : null,

    threshold_original: null,
    threshold_safe: null,
    threshold_diff: null,
    threshold_abs_diff: null,
    threshold_same: null,

    s1_valid_area_km2: QA_INCLUDE_AREA_DIAGNOSTICS ? 0 : null,
    s1_valid_gap_area_km2: QA_INCLUDE_AREA_DIAGNOSTICS ? 0 : null,
    s1_uncovered_gap_area_km2: QA_INCLUDE_AREA_DIAGNOSTICS ? dwNodataAreaKm2 : null,
    unfilled_dw_gap_area_km2: QA_INCLUDE_AREA_DIAGNOSTICS ? dwNodataAreaKm2 : null,

    final_water_area_orig_km2: null,
    final_dw_component_area_orig_km2: null,
    final_s1_component_area_orig_km2: null,

    final_water_area_safe_km2: null,
    final_dw_component_area_safe_km2: null,
    final_s1_component_area_safe_km2: null,

    final_water_area_diff_km2: null,
    final_water_area_abs_diff_km2: null,
    final_dw_component_area_diff_km2: null,
    final_s1_component_area_diff_km2: null
  };

  // ---- If no S1: still evaluate final DW-only result ----
  if (!hasS1) {
    var water_def_dwonly = water_dw_masked;
    var conpix_dwonly = water_def_dwonly.connectedPixelCount(51, false).gte(50);
    var finalMask_dwonly = water_def_dwonly.updateMask(conpix_dwonly);

    var finalDwOnlyAreaKm2 = areaKm2FromMask(finalMask_dwonly);

    props.final_water_area_orig_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalDwOnlyAreaKm2 : null;
    props.final_dw_component_area_orig_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalDwOnlyAreaKm2 : null;
    props.final_s1_component_area_orig_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? 0 : null;

    props.final_water_area_safe_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalDwOnlyAreaKm2 : null;
    props.final_dw_component_area_safe_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalDwOnlyAreaKm2 : null;
    props.final_s1_component_area_safe_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? 0 : null;

    props.final_water_area_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? 0 : null;
    props.final_water_area_abs_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? 0 : null;
    props.final_dw_component_area_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? 0 : null;
    props.final_s1_component_area_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? 0 : null;

    return ee.Feature(null, props);
  }

  // ---- S1 ----
  var s1Collection = ee.ImageCollection('COPERNICUS/S1_GRD')
    .filterBounds(aoi)
    .filterDate(startDate, endDate)
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', band));

  if (PRINT_COLLECTIONS) print('S1', key, s1Collection);

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

  var thresholdOriginal = ee.Number(otsuOriginal(globalHistogram));
  var thresholdSafe = ee.Number(otsuSafe(globalHistogram));
  var thresholdDiff = thresholdSafe.subtract(thresholdOriginal);
  var thresholdAbsDiff = thresholdDiff.abs();
  var thresholdSame = intFlag(thresholdAbsDiff.lt(1e-12));

  if (SHOW_HISTOGRAM_CHARTS) {
    printHistogramCharts(globalHistogram, USE_SAFE_OTSU ? thresholdSafe : thresholdOriginal, band);
  }

  // S1 valid coverage
  var s1ValidMask = s1Image.select(band).mask().selfMask();
  var s1ValidGapMask = s1ValidMask.updateMask(dw_nodata);

  var s1ValidAreaKm2 = areaKm2FromMask(s1ValidMask);
  var s1ValidGapAreaKm2 = areaKm2FromMask(s1ValidGapMask);
  var s1UncoveredGapAreaKm2 = dwNodataAreaKm2.subtract(s1ValidGapAreaKm2).max(0);

  // ---- ORIGINAL OTSU final output ----
  var s1_water_orig = s1Image.select(band).lt(thresholdOriginal).rename('water');
  var s1_water_mk_orig = s1_water_orig.updateMask(dw_nodata).selfMask();

  var combined_orig = water_dw.unmask(0).add(s1_water_mk_orig.unmask(0));
  var water_def_orig = combined_orig.gt(0).updateMask(combined_orig.gt(0));
  var conpix_orig = water_def_orig.connectedPixelCount(51, false).gte(50);
  var finalMask_orig = water_def_orig.updateMask(conpix_orig);

  var finalDwCompOrig = water_dw_masked.updateMask(conpix_orig);
  var finalS1CompOrig = s1_water_mk_orig.updateMask(conpix_orig);

  var finalWaterAreaOrigKm2 = areaKm2FromMask(finalMask_orig);
  var finalDwCompOrigKm2 = areaKm2FromMask(finalDwCompOrig);
  var finalS1CompOrigKm2 = areaKm2FromMask(finalS1CompOrig);

  // ---- SAFE OTSU final output ----
  var s1_water_safe = s1Image.select(band).lt(thresholdSafe).rename('water');
  var s1_water_mk_safe = s1_water_safe.updateMask(dw_nodata).selfMask();

  var combined_safe = water_dw.unmask(0).add(s1_water_mk_safe.unmask(0));
  var water_def_safe = combined_safe.gt(0).updateMask(combined_safe.gt(0));
  var conpix_safe = water_def_safe.connectedPixelCount(51, false).gte(50);
  var finalMask_safe = water_def_safe.updateMask(conpix_safe);

  var finalDwCompSafe = water_dw_masked.updateMask(conpix_safe);
  var finalS1CompSafe = s1_water_mk_safe.updateMask(conpix_safe);

  var finalWaterAreaSafeKm2 = areaKm2FromMask(finalMask_safe);
  var finalDwCompSafeKm2 = areaKm2FromMask(finalDwCompSafe);
  var finalS1CompSafeKm2 = areaKm2FromMask(finalS1CompSafe);

  props.threshold_original = thresholdOriginal;
  props.threshold_safe = thresholdSafe;
  props.threshold_diff = thresholdDiff;
  props.threshold_abs_diff = thresholdAbsDiff;
  props.threshold_same = thresholdSame;

  props.s1_valid_area_km2 = QA_INCLUDE_AREA_DIAGNOSTICS ? s1ValidAreaKm2 : null;
  props.s1_valid_gap_area_km2 = QA_INCLUDE_AREA_DIAGNOSTICS ? s1ValidGapAreaKm2 : null;
  props.s1_uncovered_gap_area_km2 = QA_INCLUDE_AREA_DIAGNOSTICS ? s1UncoveredGapAreaKm2 : null;
  props.unfilled_dw_gap_area_km2 = QA_INCLUDE_AREA_DIAGNOSTICS ? s1UncoveredGapAreaKm2 : null;

  props.final_water_area_orig_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalWaterAreaOrigKm2 : null;
  props.final_dw_component_area_orig_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalDwCompOrigKm2 : null;
  props.final_s1_component_area_orig_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalS1CompOrigKm2 : null;

  props.final_water_area_safe_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalWaterAreaSafeKm2 : null;
  props.final_dw_component_area_safe_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalDwCompSafeKm2 : null;
  props.final_s1_component_area_safe_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalS1CompSafeKm2 : null;

  props.final_water_area_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE
    ? finalWaterAreaSafeKm2.subtract(finalWaterAreaOrigKm2)
    : null;

  props.final_water_area_abs_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE
    ? finalWaterAreaSafeKm2.subtract(finalWaterAreaOrigKm2).abs()
    : null;

  props.final_dw_component_area_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE
    ? finalDwCompSafeKm2.subtract(finalDwCompOrigKm2)
    : null;

  props.final_s1_component_area_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE
    ? finalS1CompSafeKm2.subtract(finalS1CompOrigKm2)
    : null;

  return ee.Feature(null, props);
}

// ********************
// NORMAL RASTER EXPORT FUNCTION
// ********************
function processMonth(y, m, hasS1) {
  var startDate = ee.Date.fromYMD(y, m, 1);
  var endDate   = startDate.advance(1, 'month');
  var mStr = (m < 10 ? '0' + m : m.toString());

  var desc      = 'water_' + band + '_' + mStr + '_' + y;
  var assetPath = 'projects/ee-iameztoy/assets/Lake_Tanganyika_Basin/WaterSurface/' + desc;

  var dwFiltered = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
    .filter(ee.Filter.date(startDate, endDate))
    .filter(ee.Filter.bounds(aoi));

  if (PRINT_COLLECTIONS) print(dwFiltered);

  var probabilityBands = [
    'water', 'trees', 'grass', 'flooded_vegetation', 'crops',
    'shrub_and_scrub', 'built', 'bare', 'snow_and_ice'
  ];
  var probabilityImage = dwFiltered.select(probabilityBands).mean();

  var waterMaskCollection = dwFiltered.map(processWaterMask);
  if (PRINT_COLLECTIONS) print('Water mask collection', waterMaskCollection);

  var waterOccurrence = waterMaskCollection.sum().rename('water');
  var water_dw = waterOccurrence.gt(0)
    .or(probabilityImage.select('flooded_vegetation').gt(floodedveg_thr));

  var valid = water_dw.eq(0).or(water_dw.eq(1))
    .updateMask(water_dw.eq(0).or(water_dw.eq(1))).unmask();
  var dw_nodata = valid.eq(0).clip(aoi);

  // 0 = no DW gap
  // 1 = DW gap exists and Sentinel-1 is available for filling this month
  // 2 = DW gap exists but Sentinel-1 is NOT available, so the gap remains unfilled
  var fill_flag = ee.Image(0)
    .where(dw_nodata.eq(1), hasS1 ? 1 : 2)
    .rename('fill_flag')
    .clip(aoi)
    .toByte();

  var water_def;

  if (hasS1) {
    var s1Collection = ee.ImageCollection('COPERNICUS/S1_GRD')
      .filterBounds(aoi)
      .filterDate(startDate, endDate)
      .filter(ee.Filter.eq('instrumentMode', 'IW'))
      .filter(ee.Filter.listContains('transmitterReceiverPolarisation', band));

    if (PRINT_COLLECTIONS) print("S1 Collection", s1Collection);

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

    var globalThreshold = ee.Number(
      USE_SAFE_OTSU ? otsuSafe(globalHistogram) : otsuOriginal(globalHistogram)
    );

    print('Global threshold value (' + y + '-' + mStr + '):', globalThreshold);

    if (SHOW_HISTOGRAM_CHARTS) {
      printHistogramCharts(globalHistogram, globalThreshold, band);
    }

    var s1_water    = s1Image.select(band).lt(globalThreshold).rename("water");
    var s1_water_mk = s1_water.updateMask(dw_nodata);

    water_dw = water_dw.unmask(0);
    s1_water_mk = s1_water_mk.unmask(0);

    var combined = water_dw.add(s1_water_mk);
    water_def = combined.gt(0).updateMask(combined.gt(0));

  } else {
    print(
      'No Sentinel-1 for ' + y + '-' + mStr +
      '. Exporting DW-only layer. fill_flag = 2 marks DW no-data gaps left unfilled.'
    );
    water_def = water_dw.selfMask();
  }

  var conpix    = water_def.connectedPixelCount(51, false).gte(50);
  var finalMask = water_def.updateMask(conpix).rename('water').toByte();

  var exportImage = finalMask.addBands(fill_flag).set({
    year: y,
    month: m,
    s1_available: hasS1 ? 1 : 0,
    safe_otsu: USE_SAFE_OTSU ? 1 : 0
  });

  Export.image.toAsset({
    image: exportImage,
    description: desc,
    assetId: assetPath,
    region: aoi,
    scale: 10,
    crs: 'EPSG:4326',
    pyramidingPolicy: 'mode',
    maxPixels: 1e13
  });
}

// ********************
// RUN
// ********************
var batchList = makeYearBatches(startYear, startMonth, endYear, endMonth, yearsPerBatch);

var dwBase = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
  .filterBounds(aoi);

var s1Base = ee.ImageCollection('COPERNICUS/S1_GRD')
  .filterBounds(aoi)
  .filter(ee.Filter.eq('instrumentMode', 'IW'))
  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', band));

function runBatch(batchIndex) {
  if (batchIndex >= batchList.length) {
    print('All batches have been queued.');
    return;
  }

  var batch = batchList[batchIndex];
  var monthList = makeMonthList(
    batch.startYear, batch.startMonth,
    batch.endYear, batch.endMonth
  );

  var batchStartDate = ee.Date.fromYMD(batch.startYear, batch.startMonth, 1);
  var batchEndDate = ee.Date.fromYMD(batch.endYear, batch.endMonth, 1).advance(1, 'month');

  var batchLabel = batch.startYear + '_' + batch.startMonth +
    '__' + batch.endYear + '_' + batch.endMonth;

  print(
    'Running batch ' + (batchIndex + 1) + '/' + batchList.length + ':',
    batch.startYear + '-' + batch.startMonth + ' to ' + batch.endYear + '-' + batch.endMonth
  );

  buildMonthlyCountMap(dwBase, batchStartDate, batchEndDate, function(dwCountMap) {
    buildMonthlyCountMap(s1Base, batchStartDate, batchEndDate, function(s1CountMap) {

      if (RUN_THRESHOLD_QA_ONLY) {
        var features = monthList.map(function(d) {
          var key = monthKey(d.year, d.month);
          var dwCount = dwCountMap[key] || 0;
          var s1Count = s1CountMap[key] || 0;
          return buildQaFeature(d.year, d.month, dwCount, s1Count);
        });

        var qaCollection = ee.FeatureCollection(features);

        print('QA collection preview (batch ' + batchLabel + ')', qaCollection.limit(5));

        Export.table.toDrive({
          collection: qaCollection,
          description: QA_EXPORT_DESCRIPTION + '_' + batchLabel,
          folder: QA_EXPORT_FOLDER,
          fileNamePrefix: QA_FILE_PREFIX + '_' + batchLabel,
          fileFormat: 'CSV',
          selectors: [
            'year', 'month', 'month_key', 'start_date', 'end_date',
            'status_code',
            'dw_available', 's1_available',
            'dw_image_count', 's1_image_count',
            'aoi_area_km2',

            'threshold_original', 'threshold_safe',
            'threshold_diff', 'threshold_abs_diff', 'threshold_same',

            'dw_has_gaps',
            'dw_valid_area_km2', 'dw_nodata_area_km2', 'dw_water_area_raw_km2',

            's1_valid_area_km2', 's1_valid_gap_area_km2',
            's1_uncovered_gap_area_km2', 'unfilled_dw_gap_area_km2',

            'final_water_area_orig_km2',
            'final_dw_component_area_orig_km2',
            'final_s1_component_area_orig_km2',

            'final_water_area_safe_km2',
            'final_dw_component_area_safe_km2',
            'final_s1_component_area_safe_km2',

            'final_water_area_diff_km2',
            'final_water_area_abs_diff_km2',
            'final_dw_component_area_diff_km2',
            'final_s1_component_area_diff_km2'
          ]
        });

      } else {
        monthList.forEach(function(d) {
          var key = monthKey(d.year, d.month);
          var dwCount = dwCountMap[key] || 0;
          var s1Count = s1CountMap[key] || 0;

          if (dwCount > 0) {
            processMonth(d.year, d.month, s1Count > 0);
          } else {
            var mStr = (d.month < 10 ? '0' + d.month : d.month);
            print('Skipping ' + d.year + '-' + mStr + ': no DW images.');
          }
        });
      }

      runBatch(batchIndex + 1);
    });
  });
}

runBatch(0);
