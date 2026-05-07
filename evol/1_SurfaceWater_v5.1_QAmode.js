// ********************************************
// 2025/07/21 Iban Ameztoy JRC Consultancy
// Batch water extraction: Dynamic World + Sentinel-1
// + QA mode for threshold comparison and processing diagnostics
//
// VERSION: v5f_export_profiles
// - Builds on v5e_explicit_water_s1_diagnostics.
// - Keeps the same water-detection methodology.
// - Adds EXPORT_PROFILE to control raster band content and avoid unnecessary
//   diagnostic calculations when lighter outputs are needed.
// - Default profile is FULL, so the script keeps the richest diagnostic output
//   unless explicitly changed.
// ********************************************

/*
======================================================================
VERSION HISTORY CONTEXT
======================================================================

v5a_refactor_same_outputs
  Refactored the script so QA mode and raster export mode use a shared monthly
  processing core. No intended methodological change.

v5b_source_validity
  Added source and validity bands: valid_final, gap_status, water_source.

v5c_dw_observation_accounting
  Added DW observation accounting bands: dw_obs_count, dw_valid_count,
  dw_water_count, dw_uncertain_count, dw_occurrence_pct,
  dw_floodedveg_mean_pct.

v5e_explicit_water_s1_diagnostics
  Changed water to explicit 0/1 over valid pixels and added Sentinel-1
  diagnostic bands.

v5f_export_profiles
  Adds export profiles:
    CORE      = light operational product
    STANDARD  = core + key DW/S1 diagnostics
    FULL      = all diagnostics, default

======================================================================
MODES
======================================================================

RUN_THRESHOLD_QA_ONLY = false
  Normal raster export mode. Exports monthly raster assets.

RUN_THRESHOLD_QA_ONLY = true
  QA mode only. Exports a monthly CSV table with:
  - original Otsu threshold
  - safe Otsu threshold
  - threshold differences
  - DW and Sentinel-1 availability
  - DW no-data/gap area
  - Sentinel-1 valid coverage over DW gaps
  - DW/S1 contribution to final mapped water
  - DW-only month diagnostics

======================================================================
EXPORT PROFILES
======================================================================

EXPORT_PROFILE = 'CORE'
  Exports only the core operational bands:
    water
    valid_final
    gap_status
    water_source
  plus fill_flag if EXPORT_LEGACY_FILL_FLAG = true.

EXPORT_PROFILE = 'STANDARD'
  Exports CORE bands plus key diagnostics:
    dw_obs_count
    dw_valid_count
    dw_water_count
    dw_uncertain_count
    dw_occurrence_pct
    dw_floodedveg_mean_pct
    s1_obs_count
    s1_gapfill_used

EXPORT_PROFILE = 'FULL'
  Exports all STANDARD bands plus full S1 debugging bands:
    s1_valid_gap
    s1_water_gap
    s1_threshold_x100
    s1_min_db_x100

Default: FULL.

======================================================================
MAIN EXPORTED BAND CODES
======================================================================

water
  1 = final mapped water
  0 = valid final estimate, but non-water
  masked = no valid final estimate for that pixel-month

valid_final
  0 = no valid final estimate
  1 = valid final estimate from DW or from S1 over a DW gap

gap_status
  0 = DW valid / no DW gap
  1 = DW gap with valid Sentinel-1 pixel coverage
  2 = DW gap without valid Sentinel-1 pixel coverage

water_source
  0 = no final mapped water pixel / non-water / invalid
  1 = Dynamic World open-water probability component
  2 = Dynamic World flooded-vegetation probability component
  3 = Dynamic World open-water + flooded-vegetation components
  4 = Sentinel-1 Otsu gap-fill component

DW ACCOUNTING BANDS

dw_obs_count
  Number of available Dynamic World water-band observations in the pixel-month.

dw_valid_count
  Number of Dynamic World observations with a clear water/non-water decision under
  the current threshold logic: water > water_thr OR water <= water_low_thr.

dw_water_count
  Number of high-confidence Dynamic World water detections: water > water_thr.

dw_uncertain_count
  Number of Dynamic World observations with intermediate water probability:
  water_low_thr < water <= water_thr.

dw_occurrence_pct
  100 * dw_water_count / dw_valid_count. Pixels with dw_valid_count = 0 are set to 0,
  and must be interpreted together with dw_valid_count.

dw_floodedveg_mean_pct
  Monthly mean flooded-vegetation probability scaled to 0–100.

SENTINEL-1 ACCOUNTING BANDS

s1_obs_count
  Number of valid Sentinel-1 observations at the pixel-month before monthly reduction.
  The workflow then reduces these observations to one monthly minimum-backscatter
  composite and applies one monthly Otsu threshold to that composite.

s1_valid_gap
  1 where a DW gap has valid Sentinel-1 pixel coverage.

s1_water_gap
  1 where Sentinel-1 classifies water inside a DW gap before final connected-pixel filtering.

s1_gapfill_used
  1 where the final mapped water pixel comes from Sentinel-1 after connected-pixel filtering.

s1_threshold_x100
  Selected Otsu threshold for the month multiplied by 100. Example: -1845 = -18.45 dB.

s1_min_db_x100
  Monthly minimum Sentinel-1 backscatter composite multiplied by 100.
  Use s1_obs_count to identify pixels without valid S1 observations.
*/

// =====================================================================
// 0) PARAMETERS
// =====================================================================

// Area of interest: Lake Tanganyika basin (HYBAS_ID 1041259950)
var hydrobasins = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_4')
  .filter(ee.Filter.eq('HYBAS_ID', 1041259950));
var aoi = hydrobasins.geometry();

// Temporal range for batch processing
var startYear  = 2015;
var startMonth =    8;
var endYear    = 2021;
var endMonth   =   12;

// Probability thresholds for Dynamic World
var water_thr      = 0.5;
var water_low_thr  = 0.05;
var floodedveg_thr = 0.3;

// SAR band for Otsu thresholding: 'VH' or 'VV'
var band = 'VH';

// OTSU OPTION
// true  = use safe Otsu implementation, avoiding final split where class B is empty.
// false = reproduce original implementation for before/after comparison.
var USE_SAFE_OTSU = true;

// MAIN MODE
// false = normal raster export mode
// true  = QA mode only: export monthly CSV table with thresholds and diagnostics
var RUN_THRESHOLD_QA_ONLY = false;

// EXPORT PROFILE
// 'CORE'     = water + validity/source/gap bands only
// 'STANDARD' = CORE + key DW diagnostics + key S1 contribution diagnostics
// 'FULL'     = STANDARD + full S1 debug bands
var EXPORT_PROFILE = 'FULL';

// Compatibility option
// true  = export the previous fill_flag band together with the new gap_status band.
// false = omit fill_flag and use gap_status as the main gap-diagnostic band.
var EXPORT_LEGACY_FILL_FLAG = true;

// QA OPTIONS
var QA_INCLUDE_AREA_DIAGNOSTICS = true;
var QA_INCLUDE_OUTPUT_DIFFERENCE = true;

// QA EXPORT SETTINGS
var QA_EXPORT_DESCRIPTION = 'Tanganyika_threshold_QA_' + band + '_' + startYear + '_' + endYear;
var QA_EXPORT_FOLDER = 'EarthEngine';
var QA_FILE_PREFIX = 'Tanganyika_threshold_QA_' + band + '_' + startYear + '_' + endYear;

// Debug / visualization
var PRINT_COLLECTIONS = false;
var SHOW_HISTOGRAM_CHARTS = false;

// Output settings
var EXPORT_ASSET_FOLDER = 'projects/ee-iameztoy/assets/Lake_Tanganyika_Basin/WaterSurface';
var EXPORT_SCALE = 10;
var EXPORT_CRS = 'EPSG:4326';
var EXPORT_MAX_PIXELS = 1e13;

// =====================================================================
// 1) PROFILE HELPERS
// =====================================================================

function useDwDiagnostics() {
  return EXPORT_PROFILE === 'STANDARD' || EXPORT_PROFILE === 'FULL';
}

function useS1StandardDiagnostics() {
  return EXPORT_PROFILE === 'STANDARD' || EXPORT_PROFILE === 'FULL';
}

function useS1FullDiagnostics() {
  return EXPORT_PROFILE === 'FULL';
}

function profileIsValid() {
  return EXPORT_PROFILE === 'CORE' || EXPORT_PROFILE === 'STANDARD' || EXPORT_PROFILE === 'FULL';
}

if (!profileIsValid()) {
  print('WARNING: EXPORT_PROFILE must be CORE, STANDARD or FULL. Current value:', EXPORT_PROFILE);
}

// =====================================================================
// 2) HELPERS
// =====================================================================

function makeMonthList(sY, sM, eY, eM) {
  var list = [];
  var y = sY;
  var m = sM;
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

function monthString(m) {
  return (m < 10 ? '0' + m : m.toString());
}

var monthList = makeMonthList(startYear, startMonth, endYear, endMonth);
var aoiAreaKm2 = ee.Number(aoi.area(1)).divide(1e6);

// Common AOI mask used to make diagnostic bands explicit across the basin.
var aoiMask = ee.Image.constant(1).clip(aoi).selfMask();

// ---------------------------------------------------------------------
// Client-side monthly count maps
// One async retrieval per collection for the whole period.
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Image / area helpers
// ---------------------------------------------------------------------
function processWaterMask(image) {
  var water = image.select('water');
  var waterMasked = water
    .where(water.lte(water_low_thr), 0)
    .updateMask(water.gt(water_thr).or(water.lte(water_low_thr)))
    .where(water.gt(water_thr), 1);

  return waterMasked.rename('water')
    .copyProperties(image, image.propertyNames());
}

function areaKm2FromMask(maskImage) {
  var area = ee.Image.pixelArea()
    .updateMask(maskImage)
    .reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: aoi,
      scale: EXPORT_SCALE,
      maxPixels: EXPORT_MAX_PIXELS
    })
    .get('area');

  return ee.Number(ee.Algorithms.If(area, area, 0)).divide(1e6);
}

function intFlag(condition) {
  return ee.Number(ee.Algorithms.If(condition, 1, 0));
}

function byteToAoi(img, name) {
  return ee.Image(img)
    .unmask(0)
    .rename(name)
    .clip(aoi)
    .updateMask(aoiMask)
    .toByte();
}

function uint16ToAoi(img, name) {
  return ee.Image(img)
    .unmask(0)
    .rename(name)
    .clip(aoi)
    .updateMask(aoiMask)
    .toUint16();
}

function int16ToAoi(img, name) {
  return ee.Image(img)
    .unmask(0)
    .rename(name)
    .clip(aoi)
    .updateMask(aoiMask)
    .toInt16();
}

function emptyByteImage(name) {
  return byteToAoi(ee.Image(0), name);
}

function emptyUint16Image(name) {
  return uint16ToAoi(ee.Image(0), name);
}

function emptyInt16Image(name) {
  return int16ToAoi(ee.Image(0), name);
}

function emptyMaskedWaterImage() {
  return ee.Image(0).rename('water').updateMask(ee.Image(0)).clip(aoi).toByte();
}

function buildExplicitWaterBand(finalMask, validFinal) {
  // Final water is explicit 0/1 where a valid final estimate exists.
  // It remains masked only where valid_final = 0.
  return ee.Image(finalMask)
    .unmask(0)
    .rename('water')
    .clip(aoi)
    .updateMask(ee.Image(validFinal).eq(1))
    .toByte();
}

function baseQaProps(y, m, dwCount, s1Count) {
  var hasDw = dwCount > 0;
  var hasS1 = s1Count > 0;

  return {
    year: y,
    month: m,
    month_key: monthKey(y, m),
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
}

// =====================================================================
// 3) OTSU
// =====================================================================

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

// =====================================================================
// 4) OPTIONAL HISTOGRAM CHARTS
// =====================================================================

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

// =====================================================================
// 5) SHARED MONTHLY PROCESSING CORE
// =====================================================================

function buildDwBundle(y, m, startDate, endDate, dwCount) {
  var key = monthKey(y, m);

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

  // Separate DW components for source tracing.
  var dwWaterComponent = waterOccurrence.gt(0).rename('dw_water_component');
  var dwFloodedVegComponent = probabilityImage
    .select('flooded_vegetation')
    .gt(floodedveg_thr)
    .rename('dw_floodedveg_component');

  var water_dw = dwWaterComponent.or(dwFloodedVegComponent).rename('water');

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

  var out = {
    dwFiltered: dwFiltered,
    probabilityImage: probabilityImage,
    waterMaskCollection: waterMaskCollection,
    waterOccurrence: waterOccurrence,
    dwWaterComponent: dwWaterComponent,
    dwFloodedVegComponent: dwFloodedVegComponent,
    water_dw: water_dw,
    water_dw_masked: water_dw_masked,
    valid: valid,
    dw_nodata: dw_nodata,
    dw_valid_mask: dw_valid_mask,
    dwNodataAreaKm2: dwNodataAreaKm2,
    dwValidAreaKm2: dwValidAreaKm2,
    dwWaterAreaRawKm2: dwWaterAreaRawKm2,
    dwHasGaps: dwHasGaps
  };

  if (useDwDiagnostics()) {
    // DW observation accounting.
    // These bands do not change the water mask; they document the denominator and
    // uncertainty structure behind the monthly DW component.
    var dwObsCount = uint16ToAoi(
      dwFiltered.select('water').count(),
      'dw_obs_count'
    );

    var dwValidCountRaw = dwFiltered.map(function(img) {
      var w = img.select('water');
      return w.gt(water_thr)
        .or(w.lte(water_low_thr))
        .unmask(0)
        .rename('valid_obs');
    }).sum();
    var dwValidCount = uint16ToAoi(dwValidCountRaw, 'dw_valid_count');

    var dwWaterCountRaw = dwFiltered.map(function(img) {
      var w = img.select('water');
      return w.gt(water_thr)
        .unmask(0)
        .rename('water_obs');
    }).sum();
    var dwWaterCount = uint16ToAoi(dwWaterCountRaw, 'dw_water_count');

    var dwUncertainCountRaw = dwFiltered.map(function(img) {
      var w = img.select('water');
      return w.gt(water_low_thr)
        .and(w.lte(water_thr))
        .unmask(0)
        .rename('uncertain_obs');
    }).sum();
    var dwUncertainCount = uint16ToAoi(dwUncertainCountRaw, 'dw_uncertain_count');

    var dwOccurrencePct = byteToAoi(
      ee.Image(0).where(
        dwValidCount.gt(0),
        dwWaterCount.toFloat().divide(dwValidCount.toFloat()).multiply(100).round()
      ),
      'dw_occurrence_pct'
    );

    var dwFloodedVegMeanPct = byteToAoi(
      probabilityImage.select('flooded_vegetation').multiply(100).round(),
      'dw_floodedveg_mean_pct'
    );

    out.dwObsCount = dwObsCount;
    out.dwValidCount = dwValidCount;
    out.dwWaterCount = dwWaterCount;
    out.dwUncertainCount = dwUncertainCount;
    out.dwOccurrencePct = dwOccurrencePct;
    out.dwFloodedVegMeanPct = dwFloodedVegMeanPct;
  }

  return out;
}

function buildS1Bundle(y, m, startDate, endDate, dw_nodata) {
  var key = monthKey(y, m);

  var s1Collection = ee.ImageCollection('COPERNICUS/S1_GRD')
    .filterBounds(aoi)
    .filterDate(startDate, endDate)
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', band));

  if (PRINT_COLLECTIONS) print('S1', key, s1Collection);

  // Current workflow: reduce all monthly S1 observations to one monthly minimum
  // backscatter composite, then apply one monthly Otsu threshold to that composite.
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

  var s1ValidMask = s1Image.select(band).mask().selfMask();
  var s1ValidGapMask = s1ValidMask.updateMask(dw_nodata);

  var s1ValidAreaKm2 = areaKm2FromMask(s1ValidMask);
  var s1ValidGapAreaKm2 = areaKm2FromMask(s1ValidGapMask);
  var s1UncoveredGapAreaKm2 = ee.Number(0); // filled later in monthly core

  var out = {
    s1Collection: s1Collection,
    s1Image: s1Image,
    globalHistogram: globalHistogram,
    thresholdOriginal: thresholdOriginal,
    thresholdSafe: thresholdSafe,
    thresholdDiff: thresholdDiff,
    thresholdAbsDiff: thresholdAbsDiff,
    thresholdSame: thresholdSame,
    s1ValidMask: s1ValidMask,
    s1ValidGapMask: s1ValidGapMask,
    s1ValidAreaKm2: s1ValidAreaKm2,
    s1ValidGapAreaKm2: s1ValidGapAreaKm2,
    s1UncoveredGapAreaKm2: s1UncoveredGapAreaKm2
  };

  if (useS1StandardDiagnostics()) {
    out.s1ObsCount = uint16ToAoi(
      s1Collection.select(band).count(),
      's1_obs_count'
    );
  }

  if (useS1FullDiagnostics()) {
    out.s1MinDbX100 = int16ToAoi(
      s1Image.select(band).multiply(100).round(),
      's1_min_db_x100'
    );
  }

  return out;
}

function buildWaterSource(dw, s1WaterGap, finalMask) {
  var dwOpen = dw.dwWaterComponent.unmask(0).eq(1);
  var dwFlooded = dw.dwFloodedVegComponent.unmask(0).eq(1);
  var s1Water = ee.Image(s1WaterGap).unmask(0).eq(1);

  var source = ee.Image(0)
    .where(dwOpen, 1)
    .where(dwFlooded, 2)
    .where(dwOpen.and(dwFlooded), 3)
    .where(s1Water, 4)
    .updateMask(finalMask)
    .unmask(0);

  return byteToAoi(source, 'water_source');
}

function buildValidFinal(dw, s1, hasS1) {
  var dwValid = dw.valid.eq(1);

  var validFinal;
  if (hasS1) {
    var s1ValidGap = s1.s1ValidMask.unmask(0).eq(1).and(dw.dw_nodata.eq(1));
    validFinal = dwValid.or(s1ValidGap);
  } else {
    validFinal = dwValid;
  }

  return byteToAoi(validFinal, 'valid_final');
}

function buildGapStatus(dw, s1, hasS1) {
  var gapStatus;

  if (hasS1) {
    var s1Valid = s1.s1ValidMask.unmask(0).eq(1);
    gapStatus = ee.Image(0)
      .where(dw.dw_nodata.eq(1).and(s1Valid), 1)
      .where(dw.dw_nodata.eq(1).and(s1Valid.not()), 2);
  } else {
    gapStatus = ee.Image(0)
      .where(dw.dw_nodata.eq(1), 2);
  }

  return byteToAoi(gapStatus, 'gap_status');
}

function buildEmptyS1Diagnostics() {
  return {
    s1ObsCount: emptyUint16Image('s1_obs_count'),
    s1ValidGap: emptyByteImage('s1_valid_gap'),
    s1WaterGap: emptyByteImage('s1_water_gap'),
    s1GapfillUsed: emptyByteImage('s1_gapfill_used'),
    s1ThresholdX100: emptyInt16Image('s1_threshold_x100'),
    s1MinDbX100: emptyInt16Image('s1_min_db_x100')
  };
}

function buildS1Diagnostics(dw, s1, finalObj, selectedThreshold) {
  var out = {};

  if (useS1StandardDiagnostics()) {
    out.s1ObsCount = s1.s1ObsCount;
    out.s1GapfillUsed = byteToAoi(
      finalObj.finalS1Component,
      's1_gapfill_used'
    );
  }

  if (useS1FullDiagnostics()) {
    out.s1ValidGap = byteToAoi(
      s1.s1ValidMask.unmask(0).eq(1).and(dw.dw_nodata.eq(1)),
      's1_valid_gap'
    );

    out.s1WaterGap = byteToAoi(
      finalObj.s1_water_mk,
      's1_water_gap'
    );

    out.s1ThresholdX100 = int16ToAoi(
      ee.Image.constant(ee.Number(selectedThreshold).multiply(100).round()),
      's1_threshold_x100'
    );

    out.s1MinDbX100 = s1.s1MinDbX100;
  }

  return out;
}

function buildFinalDwOnly(dw) {
  var water_def = dw.water_dw_masked;
  var conpix = water_def.connectedPixelCount(51, false).gte(50);
  var finalMask = water_def.updateMask(conpix).rename('water').toByte();

  var finalAreaKm2 = areaKm2FromMask(finalMask);
  var source = buildWaterSource(dw, emptyMaskedWaterImage(), finalMask);

  return {
    water_def: water_def,
    conpix: conpix,
    finalMask: finalMask,
    waterSource: source,
    finalWaterAreaKm2: finalAreaKm2,
    finalDwComponent: finalMask,
    finalS1Component: emptyMaskedWaterImage(),
    finalDwComponentAreaKm2: finalAreaKm2,
    finalS1ComponentAreaKm2: ee.Number(0)
  };
}

function buildFinalWithS1(dw, s1Image, threshold) {
  var s1_water = s1Image.select(band).lt(threshold).rename('water');
  var s1_water_mk = s1_water.updateMask(dw.dw_nodata).selfMask();

  var combined = dw.water_dw.unmask(0).add(s1_water_mk.unmask(0));
  var water_def = combined.gt(0).updateMask(combined.gt(0));

  var conpix = water_def.connectedPixelCount(51, false).gte(50);
  var finalMask = water_def.updateMask(conpix).rename('water').toByte();

  var finalDwComponent = dw.water_dw_masked.updateMask(conpix).rename('water');
  var finalS1Component = s1_water_mk.updateMask(conpix).rename('water');
  var source = buildWaterSource(dw, s1_water_mk, finalMask);

  return {
    s1_water: s1_water,
    s1_water_mk: s1_water_mk,
    combined: combined,
    water_def: water_def,
    conpix: conpix,
    finalMask: finalMask,
    waterSource: source,
    finalDwComponent: finalDwComponent,
    finalS1Component: finalS1Component,
    finalWaterAreaKm2: areaKm2FromMask(finalMask),
    finalDwComponentAreaKm2: areaKm2FromMask(finalDwComponent),
    finalS1ComponentAreaKm2: areaKm2FromMask(finalS1Component)
  };
}

function buildFillFlag(dw_nodata, hasS1) {
  // Legacy flag kept for compatibility with previous exports.
  // 0 = no DW gap
  // 1 = DW gap exists and Sentinel-1 is available for filling this month
  // 2 = DW gap exists but Sentinel-1 is NOT available, so the gap remains unfilled
  return byteToAoi(
    ee.Image(0).where(dw_nodata.eq(1), hasS1 ? 1 : 2),
    'fill_flag'
  );
}

function buildMonthlyCore(y, m, dwCount, s1Count) {
  var key = monthKey(y, m);
  var startDate = ee.Date.fromYMD(y, m, 1);
  var endDate = startDate.advance(1, 'month');
  var hasDw = dwCount > 0;
  var hasS1 = s1Count > 0;

  var core = {
    y: y,
    m: m,
    key: key,
    mStr: monthString(m),
    startDate: startDate,
    endDate: endDate,
    hasDw: hasDw,
    hasS1: hasS1,
    dwCount: dwCount,
    s1Count: s1Count,
    baseProps: baseQaProps(y, m, dwCount, s1Count)
  };

  if (!hasDw) {
    return core;
  }

  var dw = buildDwBundle(y, m, startDate, endDate, dwCount);
  core.dw = dw;
  core.fillFlag = buildFillFlag(dw.dw_nodata, hasS1);

  if (!hasS1) {
    var finalDwOnly = buildFinalDwOnly(dw);
    core.finalOrig = finalDwOnly;
    core.finalSafe = finalDwOnly;
    core.finalSelected = finalDwOnly;
    core.validFinal = buildValidFinal(dw, null, false);
    core.gapStatus = buildGapStatus(dw, null, false);
    core.waterBand = buildExplicitWaterBand(core.finalSelected.finalMask, core.validFinal);
    core.s1Diagnostics = buildEmptyS1Diagnostics();
    return core;
  }

  var s1 = buildS1Bundle(y, m, startDate, endDate, dw.dw_nodata);
  s1.s1UncoveredGapAreaKm2 = dw.dwNodataAreaKm2.subtract(s1.s1ValidGapAreaKm2).max(0);
  core.s1 = s1;

  var finalOrig = buildFinalWithS1(dw, s1.s1Image, s1.thresholdOriginal);
  var finalSafe = buildFinalWithS1(dw, s1.s1Image, s1.thresholdSafe);

  core.finalOrig = finalOrig;
  core.finalSafe = finalSafe;
  core.finalSelected = USE_SAFE_OTSU ? finalSafe : finalOrig;
  core.validFinal = buildValidFinal(dw, s1, true);
  core.gapStatus = buildGapStatus(dw, s1, true);
  core.waterBand = buildExplicitWaterBand(core.finalSelected.finalMask, core.validFinal);

  var selectedThreshold = USE_SAFE_OTSU ? s1.thresholdSafe : s1.thresholdOriginal;
  core.s1Diagnostics = buildS1Diagnostics(dw, s1, core.finalSelected, selectedThreshold);

  return core;
}

// =====================================================================
// 6) QA FEATURE BUILDER
// =====================================================================

function buildQaFeature(y, m, dwCount, s1Count) {
  var core = buildMonthlyCore(y, m, dwCount, s1Count);
  var props = core.baseProps;

  if (!core.hasDw) {
    return ee.Feature(null, props);
  }

  var dw = core.dw;

  props.dw_has_gaps = dw.dwHasGaps;
  props.dw_valid_area_km2 = QA_INCLUDE_AREA_DIAGNOSTICS ? dw.dwValidAreaKm2 : null;
  props.dw_nodata_area_km2 = QA_INCLUDE_AREA_DIAGNOSTICS ? dw.dwNodataAreaKm2 : null;
  props.dw_water_area_raw_km2 = QA_INCLUDE_AREA_DIAGNOSTICS ? dw.dwWaterAreaRawKm2 : null;

  if (!core.hasS1) {
    props.s1_valid_area_km2 = QA_INCLUDE_AREA_DIAGNOSTICS ? 0 : null;
    props.s1_valid_gap_area_km2 = QA_INCLUDE_AREA_DIAGNOSTICS ? 0 : null;
    props.s1_uncovered_gap_area_km2 = QA_INCLUDE_AREA_DIAGNOSTICS ? dw.dwNodataAreaKm2 : null;
    props.unfilled_dw_gap_area_km2 = QA_INCLUDE_AREA_DIAGNOSTICS ? dw.dwNodataAreaKm2 : null;

    props.final_water_area_orig_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? core.finalOrig.finalWaterAreaKm2 : null;
    props.final_dw_component_area_orig_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? core.finalOrig.finalDwComponentAreaKm2 : null;
    props.final_s1_component_area_orig_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? 0 : null;

    props.final_water_area_safe_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? core.finalSafe.finalWaterAreaKm2 : null;
    props.final_dw_component_area_safe_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? core.finalSafe.finalDwComponentAreaKm2 : null;
    props.final_s1_component_area_safe_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? 0 : null;

    props.final_water_area_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? 0 : null;
    props.final_water_area_abs_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? 0 : null;
    props.final_dw_component_area_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? 0 : null;
    props.final_s1_component_area_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? 0 : null;

    return ee.Feature(null, props);
  }

  var s1 = core.s1;
  var finalOrig = core.finalOrig;
  var finalSafe = core.finalSafe;

  props.threshold_original = s1.thresholdOriginal;
  props.threshold_safe = s1.thresholdSafe;
  props.threshold_diff = s1.thresholdDiff;
  props.threshold_abs_diff = s1.thresholdAbsDiff;
  props.threshold_same = s1.thresholdSame;

  props.s1_valid_area_km2 = QA_INCLUDE_AREA_DIAGNOSTICS ? s1.s1ValidAreaKm2 : null;
  props.s1_valid_gap_area_km2 = QA_INCLUDE_AREA_DIAGNOSTICS ? s1.s1ValidGapAreaKm2 : null;
  props.s1_uncovered_gap_area_km2 = QA_INCLUDE_AREA_DIAGNOSTICS ? s1.s1UncoveredGapAreaKm2 : null;
  props.unfilled_dw_gap_area_km2 = QA_INCLUDE_AREA_DIAGNOSTICS ? s1.s1UncoveredGapAreaKm2 : null;

  props.final_water_area_orig_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalOrig.finalWaterAreaKm2 : null;
  props.final_dw_component_area_orig_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalOrig.finalDwComponentAreaKm2 : null;
  props.final_s1_component_area_orig_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalOrig.finalS1ComponentAreaKm2 : null;

  props.final_water_area_safe_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalSafe.finalWaterAreaKm2 : null;
  props.final_dw_component_area_safe_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalSafe.finalDwComponentAreaKm2 : null;
  props.final_s1_component_area_safe_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalSafe.finalS1ComponentAreaKm2 : null;

  props.final_water_area_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE
    ? finalSafe.finalWaterAreaKm2.subtract(finalOrig.finalWaterAreaKm2)
    : null;

  props.final_water_area_abs_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE
    ? finalSafe.finalWaterAreaKm2.subtract(finalOrig.finalWaterAreaKm2).abs()
    : null;

  props.final_dw_component_area_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE
    ? finalSafe.finalDwComponentAreaKm2.subtract(finalOrig.finalDwComponentAreaKm2)
    : null;

  props.final_s1_component_area_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE
    ? finalSafe.finalS1ComponentAreaKm2.subtract(finalOrig.finalS1ComponentAreaKm2)
    : null;

  return ee.Feature(null, props);
}

// =====================================================================
// 7) NORMAL RASTER EXPORT FUNCTION
// =====================================================================

function buildExportImage(core) {
  var exportImage = core.waterBand;

  if (EXPORT_LEGACY_FILL_FLAG) {
    exportImage = exportImage.addBands(core.fillFlag);
  }

  // Core operational bands.
  exportImage = exportImage
    .addBands(core.validFinal)
    .addBands(core.gapStatus)
    .addBands(core.finalSelected.waterSource);

  // STANDARD and FULL: DW diagnostics.
  if (useDwDiagnostics()) {
    exportImage = exportImage
      .addBands(core.dw.dwObsCount)
      .addBands(core.dw.dwValidCount)
      .addBands(core.dw.dwWaterCount)
      .addBands(core.dw.dwUncertainCount)
      .addBands(core.dw.dwOccurrencePct)
      .addBands(core.dw.dwFloodedVegMeanPct);
  }

  // STANDARD and FULL: key S1 diagnostics.
  if (useS1StandardDiagnostics()) {
    exportImage = exportImage
      .addBands(core.s1Diagnostics.s1ObsCount)
      .addBands(core.s1Diagnostics.s1GapfillUsed);
  }

  // FULL only: full S1 debug diagnostics.
  if (useS1FullDiagnostics()) {
    exportImage = exportImage
      .addBands(core.s1Diagnostics.s1ValidGap)
      .addBands(core.s1Diagnostics.s1WaterGap)
      .addBands(core.s1Diagnostics.s1ThresholdX100)
      .addBands(core.s1Diagnostics.s1MinDbX100);
  }

  return exportImage;
}

function processMonth(y, m, dwCount, s1Count) {
  var core = buildMonthlyCore(y, m, dwCount, s1Count);

  if (!core.hasDw) {
    print('Skipping ' + core.key + ': no DW images.');
    return;
  }

  if (core.hasS1) {
    var selectedThreshold = USE_SAFE_OTSU ? core.s1.thresholdSafe : core.s1.thresholdOriginal;
    print('Global threshold value (' + core.key + '):', selectedThreshold);
  } else {
    print(
      'No Sentinel-1 for ' + core.key +
      '. Exporting DW-only layer. fill_flag = 2 marks DW no-data gaps left unfilled.'
    );
  }

  var desc = 'water_' + band + '_' + core.mStr + '_' + y;
  var assetPath = EXPORT_ASSET_FOLDER + '/' + desc;

  var exportImage = buildExportImage(core).set({
    version: 'v5f_export_profiles',
    export_profile: EXPORT_PROFILE,
    year: y,
    month: m,
    s1_available: core.hasS1 ? 1 : 0,
    safe_otsu: USE_SAFE_OTSU ? 1 : 0,
    water_codes: '1=water;0=valid_nonwater;masked=no_valid_final_estimate',
    water_source_codes: '0=none_nonwater_invalid;1=DW_water;2=DW_floodedveg;3=DW_water_and_floodedveg;4=S1_Otsu_gapfill',
    gap_status_codes: '0=DW_valid_no_gap;1=DW_gap_S1_valid_pixel;2=DW_gap_no_S1_valid_pixel',
    valid_final_codes: '0=no_valid_final_estimate;1=valid_final_estimate',
    dw_observation_bands: 'STANDARD/FULL only; dw_occurrence_pct=100*dw_water_count/dw_valid_count;use dw_valid_count as denominator/confidence flag',
    s1_processing: 'S1 images reduced to monthly min composite; one Otsu threshold applied to monthly composite; threshold stored as s1_threshold_x100 in FULL profile',
    s1_scaled_bands: 'FULL only; s1_threshold_x100 and s1_min_db_x100 are dB multiplied by 100',
    fill_flag_exported: EXPORT_LEGACY_FILL_FLAG ? 1 : 0
  });

  Export.image.toAsset({
    image: exportImage,
    description: desc,
    assetId: assetPath,
    region: aoi,
    scale: EXPORT_SCALE,
    crs: EXPORT_CRS,
    pyramidingPolicy: 'mode',
    maxPixels: EXPORT_MAX_PIXELS
  });
}

// =====================================================================
// 8) RUN
// =====================================================================

var globalStartDate = ee.Date.fromYMD(startYear, startMonth, 1);
var globalEndDate = ee.Date.fromYMD(endYear, endMonth, 1).advance(1, 'month');

var dwBase = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
  .filterBounds(aoi);

var s1Base = ee.ImageCollection('COPERNICUS/S1_GRD')
  .filterBounds(aoi)
  .filter(ee.Filter.eq('instrumentMode', 'IW'))
  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', band));

print('Running script version:', 'v5f_export_profiles');
print('EXPORT_PROFILE:', EXPORT_PROFILE);
print('EXPORT_LEGACY_FILL_FLAG:', EXPORT_LEGACY_FILL_FLAG);
print('RUN_THRESHOLD_QA_ONLY:', RUN_THRESHOLD_QA_ONLY);

buildMonthlyCountMap(dwBase, globalStartDate, globalEndDate, function(dwCountMap) {
  buildMonthlyCountMap(s1Base, globalStartDate, globalEndDate, function(s1CountMap) {

    if (RUN_THRESHOLD_QA_ONLY) {
      var features = monthList.map(function(d) {
        var key = monthKey(d.year, d.month);
        var dwCount = dwCountMap[key] || 0;
        var s1Count = s1CountMap[key] || 0;
        return buildQaFeature(d.year, d.month, dwCount, s1Count);
      });

      var qaCollection = ee.FeatureCollection(features);
      print('QA collection preview', qaCollection.limit(5));

      Export.table.toDrive({
        collection: qaCollection,
        description: QA_EXPORT_DESCRIPTION,
        folder: QA_EXPORT_FOLDER,
        fileNamePrefix: QA_FILE_PREFIX,
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
          processMonth(d.year, d.month, dwCount, s1Count);
        } else {
          var mStr = monthString(d.month);
          print('Skipping ' + d.year + '-' + mStr + ': no DW images.');
        }
      });
    }

  });
});

