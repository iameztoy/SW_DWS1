// ********************************************
// 2026/05/28 Iban Ameztoy - Tanganyika Surface Water workflow
// Unified Dynamic World + Sentinel-1 water extraction and QA script
//
// FILE: 1_SurfaceWater_v5.2_unified.js
// VERSION: v5.2_unified
//
// PURPOSE
// This unified script replaces the need to maintain separate production and QA
// scripts for the Tanganyika Dynamic World + Sentinel-1 workflow.
//
// It combines the capabilities of:
//   0_SurfaceWater_v5.js
//     - legacy monthly water raster production
//   1_SurfaceWater_v5.1_QAmode.js
//     - production raster export + general threshold QA + export profiles
//   1_SurfaceWater_v5.1_QAmode.S1.js
//     - Sentinel-1 threshold-driver QA by orbit pass and platform
//
// ********************************************

/*
===============================================================================
QUICK START
===============================================================================

1) To calculate monthly water extent rasters
-------------------------------------------
Set:

  var RUN_MODE = 'EXPORT_WATER';

Then choose the raster band set:

  var EXPORT_PROFILE = 'CORE';      // smallest operational product
  var EXPORT_PROFILE = 'STANDARD';  // recommended scientific production product
  var EXPORT_PROFILE = 'FULL';      // full diagnostic product, largest assets

Recommended first production setting:

  RUN_MODE = 'EXPORT_WATER';
  EXPORT_PROFILE = 'STANDARD';
  USE_SAFE_OTSU = true;


2) To run the general monthly threshold QA table
------------------------------------------------
Set:

  var RUN_MODE = 'THRESHOLD_QA';

This exports a CSV table with, per month:
  - original and safe Otsu thresholds
  - threshold differences
  - DW and S1 availability
  - DW no-data/gap area
  - S1 valid coverage over DW gaps
  - final water area using original/safe Otsu
  - DW/S1 component areas in the final product

This mode is useful to compare original vs safe Otsu and understand final mapped
area differences. It does not export raster assets.


3) To run the Sentinel-1 threshold-driver QA table
--------------------------------------------------
Set:

  var RUN_MODE = 'S1_DRIVER_QA';

This exports CSV table(s) designed to investigate whether Sentinel-1 threshold
variability is related to:
  - ASCENDING vs DESCENDING orbit balance
  - Sentinel-1A / Sentinel-1B / Sentinel-1C availability
  - S1B anomaly / end-of-mission period
  - S1C launch / user-opening / calibration period
  - DW no-data / S1 gap coverage
  - monthly minimum-composite backscatter and incidence-angle statistics

This mode does not create final water rasters.


===============================================================================
RUN MODES
===============================================================================

RUN_MODE = 'EXPORT_WATER'
  Exports monthly raster assets.

RUN_MODE = 'THRESHOLD_QA'
  Exports the general monthly QA CSV table inherited from v5.1_QAmode.

RUN_MODE = 'S1_DRIVER_QA'
  Exports Sentinel-1 threshold-driver QA CSV table(s), inherited from the
  dedicated v5.1_QAmode.S1 workflow.


===============================================================================
EXPORT PROFILES FOR RUN_MODE = 'EXPORT_WATER'
===============================================================================

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
  Exports STANDARD bands plus full S1 debugging bands:
    s1_valid_gap
    s1_water_gap
    s1_threshold_x100
    s1_min_db_x100

Default: STANDARD in this unified version.
Change to FULL when debugging selected months or when asset size is acceptable.


===============================================================================
MAIN RASTER BAND CODES
===============================================================================

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

fill_flag, optional legacy band
  0 = no DW gap
  1 = DW gap exists and Sentinel-1 is available somewhere in the month
  2 = DW gap exists but Sentinel-1 is not available that month

Prefer gap_status over fill_flag because gap_status is pixel-level and checks
actual S1 pixel coverage.


===============================================================================
DYNAMIC WORLD LOGIC
===============================================================================

For each DW observation:
  water > water_thr       -> high-confidence water
  water <= water_low_thr  -> high-confidence non-water
  intermediate values     -> uncertain / masked in the DW water component

Monthly DW open-water component:
  at least one high-confidence water observation in the month

Monthly flooded-vegetation component:
  monthly mean flooded_vegetation probability > floodedveg_thr

Monthly DW water candidate:
  DW open-water component OR flooded-vegetation component


===============================================================================
SENTINEL-1 LOGIC
===============================================================================

For each month:
  1. Filter S1 GRD by AOI, month, IW mode, and selected polarization.
  2. Reduce all monthly scenes to a monthly minimum-backscatter composite.
  3. Compute one Otsu threshold over the monthly composite.
  4. Classify S1 water where monthly minimum backscatter < Otsu threshold.
  5. Use S1 only over DW gaps.
  6. Merge DW water and S1 gap-fill water.
  7. Remove small connected components.

Otsu:
  USE_SAFE_OTSU = true is recommended.
*/

// =====================================================================
// 0) PARAMETERS
// =====================================================================

// ------------------------
// Main mode
// ------------------------
var RUN_MODE = 'EXPORT_WATER';
// Options: 'EXPORT_WATER' | 'THRESHOLD_QA' | 'S1_DRIVER_QA'

// ------------------------
// AOI
// ------------------------
var hydrobasins = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_4')
  .filter(ee.Filter.eq('HYBAS_ID', 1041259950));
var aoi = hydrobasins.geometry();

// ------------------------
// Temporal range
// ------------------------
var startYear  = 2015;
var startMonth =    8;
var endYear    = 2021;
var endMonth   =   12;

// ------------------------
// Dynamic World thresholds
// ------------------------
var water_thr      = 0.5;
var water_low_thr  = 0.05;
var floodedveg_thr = 0.3;

// ------------------------
// Sentinel-1 settings
// ------------------------
var band = 'VH'; // 'VH' or 'VV'

var USE_SAFE_OTSU = true;

// ------------------------
// Raster export profile
// ------------------------
var EXPORT_PROFILE = 'STANDARD';
// Options: 'CORE' | 'STANDARD' | 'FULL'

var EXPORT_LEGACY_FILL_FLAG = true;

// ------------------------
// Output settings for raster exports
// ------------------------
var EXPORT_ASSET_FOLDER = 'projects/ee-iameztoy/assets/Lake_Tanganyika_Basin/WaterSurface';
var EXPORT_SCALE = 10;
var EXPORT_CRS = 'EPSG:4326';
var EXPORT_MAX_PIXELS = 1e13;

// ------------------------
// General threshold QA settings
// ------------------------
var QA_INCLUDE_AREA_DIAGNOSTICS = true;
var QA_INCLUDE_OUTPUT_DIFFERENCE = true;
var QA_EXPORT_FOLDER = 'EarthEngine';
var QA_EXPORT_DESCRIPTION = 'Tanganyika_threshold_QA_' + band + '_' + startYear + '_' + endYear;
var QA_FILE_PREFIX = 'Tanganyika_threshold_QA_' + band + '_' + startYear + '_' + endYear;

// ------------------------
// S1 driver QA settings
// ------------------------
var S1_DRIVER_EXPORT_IN_BATCHES = true;
var S1_DRIVER_BATCH_YEARS = 0.5;  // 1=yearly, 0.5=half-year, 0.25=quarterly, 2=two-year
var S1_DRIVER_QUEUE_ALL_BATCHES = true;
var S1_DRIVER_TARGET_BATCH_LABEL = '2015_08_to_2015_12';
var S1_DRIVER_EXPORT_FOLDER = 'EarthEngine';
var S1_DRIVER_EXPORT_PREFIX_BASE = 'Tanganyika_S1_driver_QA_' + band;

var S1_DRIVER_INCLUDE_ASC_DESC_THRESHOLDS = true;
var S1_DRIVER_INCLUDE_PLATFORM_THRESHOLDS = true;
var S1_DRIVER_INCLUDE_COMPOSITE_STATS = true;
var S1_DRIVER_INCLUDE_GAP_COVERAGE_STATS = true;

// Reduction scales for S1 driver QA
var HIST_SCALE = 90;
var STAT_SCALE = 90;
var AREA_SCALE = 10;

// Sentinel numeric placeholder for QA tables
var NO_NUM = -9999;

// Key mission dates, used only as interpretation aids in S1_DRIVER_QA mode
var S1B_ANOMALY_DATE = ee.Date('2021-12-23');
var S1B_END_OF_MISSION_DATE = ee.Date('2022-08-03');
var S1C_LAUNCH_DATE = ee.Date('2024-12-05');
var S1C_USER_OPENING_DATE = ee.Date('2025-03-26');
var S1C_FULLY_CALIBRATED_DATE = ee.Date('2025-05-19');

// ------------------------
// Debug / visualisation
// ------------------------
var SHOW_VIS = true;               // standalone toggle for charts/prints/map preview logic
var PRINT_COLLECTIONS = false;
var SHOW_HISTOGRAM_CHARTS = false; // only used if SHOW_VIS = true

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

function runModeIsValid() {
  return RUN_MODE === 'EXPORT_WATER' || RUN_MODE === 'THRESHOLD_QA' || RUN_MODE === 'S1_DRIVER_QA';
}

if (!profileIsValid()) {
  print('WARNING: EXPORT_PROFILE must be CORE, STANDARD or FULL. Current value:', EXPORT_PROFILE);
}
if (!runModeIsValid()) {
  print('WARNING: RUN_MODE must be EXPORT_WATER, THRESHOLD_QA or S1_DRIVER_QA. Current value:', RUN_MODE);
}

// =====================================================================
// 2) GENERAL HELPERS
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

function twoDigit(n) {
  return (n < 10 ? '0' + n : '' + n);
}

function monthString(m) {
  return twoDigit(m);
}

function monthStartString(y, m) {
  return y + '-' + twoDigit(m) + '-01';
}

function monthEndString(y, m) {
  var startDate = ee.Date.fromYMD(y, m, 1);
  var endDate = startDate.advance(1, 'month').advance(-1, 'day');
  return endDate.format('YYYY-MM-dd');
}

function batchLabel(sY, sM, eY, eM) {
  return sY + '_' + twoDigit(sM) + '_to_' + eY + '_' + twoDigit(eM);
}

function makeBatchList(sY, sM, eY, eM, batchMonths) {
  var batches = [];

  if (batchMonths < 12) {
    for (var y = sY; y <= eY; y++) {
      for (var blockStart = 1; blockStart <= 12; blockStart += batchMonths) {
        var blockEnd = blockStart + batchMonths - 1;
        if (y === sY && blockEnd < sM) continue;
        if (y === eY && blockStart > eM) continue;

        var startMon = (y === sY) ? Math.max(blockStart, sM) : blockStart;
        var endMon = (y === eY) ? Math.min(blockEnd, eM) : blockEnd;

        if (startMon <= endMon) {
          batches.push({
            startYear: y,
            startMonth: startMon,
            endYear: y,
            endMonth: endMon,
            label: batchLabel(y, startMon, y, endMon)
          });
        }
      }
    }
    return batches;
  }

  var yearsPerBatch = batchMonths / 12;
  var batchStartYear = sY;

  while (batchStartYear <= eY) {
    var batchEndYear = Math.min(batchStartYear + yearsPerBatch - 1, eY);
    var batchStartMonth = (batchStartYear === sY) ? sM : 1;
    var batchEndMonth = (batchEndYear === eY) ? eM : 12;

    if (batchStartYear === batchEndYear && batchStartMonth > batchEndMonth) break;

    batches.push({
      startYear: batchStartYear,
      startMonth: batchStartMonth,
      endYear: batchEndYear,
      endMonth: batchEndMonth,
      label: batchLabel(batchStartYear, batchStartMonth, batchEndYear, batchEndMonth)
    });

    batchStartYear += yearsPerBatch;
  }

  return batches;
}

var monthList = makeMonthList(startYear, startMonth, endYear, endMonth);
var aoiAreaKm2 = ee.Number(aoi.area(1)).divide(1e6);
var aoiMask = ee.Image.constant(1).clip(aoi).selfMask();

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

function safeGetAreaKm2(maskImage) {
  var area = ee.Image.pixelArea()
    .rename('area')
    .updateMask(maskImage)
    .reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: aoi,
      scale: AREA_SCALE,
      maxPixels: 1e13
    })
    .get('area');

  return ee.Number(ee.Algorithms.If(area, area, 0)).divide(1e6);
}

function safeGetNumberOrNo(dict, key) {
  dict = ee.Dictionary(dict);
  return ee.Number(ee.Algorithms.If(dict.contains(key), dict.get(key), NO_NUM));
}

function intFlag(condition) {
  return ee.Number(ee.Algorithms.If(condition, 1, 0));
}

function toFlag(boolCondition) {
  return ee.Number(ee.Algorithms.If(boolCondition, 1, 0));
}

function subtractOrNo(a, b) {
  return ee.Number(
    ee.Algorithms.If(
      ee.Number(a).eq(NO_NUM),
      NO_NUM,
      ee.Algorithms.If(ee.Number(b).eq(NO_NUM), NO_NUM, ee.Number(a).subtract(ee.Number(b)))
    )
  );
}

function absOrNo(x) {
  return ee.Number(ee.Algorithms.If(ee.Number(x).eq(NO_NUM), NO_NUM, ee.Number(x).abs()));
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
  return ee.Image(finalMask)
    .unmask(0)
    .rename('water')
    .clip(aoi)
    .updateMask(ee.Image(validFinal).eq(1))
    .toByte();
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
  var sum    = means.multiply(counts).reduce(ee.Reducer.sum(), [0]).get([0]);
  var mean   = sum.divide(total);

  var indices = ee.List.sequence(1, size);

  var bss = indices.map(function(i) {
    var aCounts = counts.slice(0, 0, i);
    var aCount  = aCounts.reduce(ee.Reducer.sum(), [0]).get([0]);
    var aMeans  = means.slice(0, 0, i);
    var aMean   = aMeans.multiply(aCounts).reduce(ee.Reducer.sum(), [0]).get([0]).divide(aCount);
    var bCount  = total.subtract(aCount);
    var bMean   = sum.subtract(aCount.multiply(aMean)).divide(bCount);

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
  var sum   = ee.Number(means.multiply(counts).reduce(ee.Reducer.sum(), [0]).get([0]));
  var mean  = sum.divide(total);

  var indices = ee.List.sequence(1, size.subtract(1));

  var bss = indices.map(function(i) {
    i = ee.Number(i);
    var aCounts = counts.slice(0, 0, i);
    var aCount  = ee.Number(aCounts.reduce(ee.Reducer.sum(), [0]).get([0]));
    var aMeans = means.slice(0, 0, i);
    var aMean  = ee.Number(aMeans.multiply(aCounts).reduce(ee.Reducer.sum(), [0]).get([0])).divide(aCount);
    var bCount = total.subtract(aCount);
    var bMean  = sum.subtract(aCount.multiply(aMean)).divide(bCount);

    return aCount.multiply(aMean.subtract(mean).pow(2))
      .add(bCount.multiply(bMean.subtract(mean).pow(2)));
  });

  var candidateMeans = means.toList().slice(0, size.subtract(1));
  return ee.Number(candidateMeans.sort(bss).get(-1));
}

function printHistogramCharts(globalHistogram, thresholdValue, bandLabel) {
  if (!SHOW_VIS || !SHOW_HISTOGRAM_CHARTS) return;

  var x = ee.List(globalHistogram.get('bucketMeans'));
  var yHist = ee.List(globalHistogram.get('histogram'));
  var dataCol = ee.Array.cat([x, yHist], 1).toList();

  var columnHeader = ee.List([[
    { label: 'Backscatter', role: 'domain', type: 'number' },
    { label: 'Values', role: 'data', type: 'number' }
  ]]);

  var dataTable = columnHeader.cat(dataCol);

  dataTable.evaluate(function(dataTableClient) {
    var chart = ui.Chart(dataTableClient)
      .setChartType('AreaChart')
      .setOptions({
        title: bandLabel + ' Global Histogram',
        hAxis: { title: 'Backscatter [dB]', viewWindow: { min: -35, max: 15 } },
        vAxis: { title: 'Count' }
      });
    print(chart);
  });

  var thresholdCol = ee.List.repeat('', x.length());
  var threshIndex = x.indexOf(thresholdValue);
  thresholdCol = thresholdCol.set(threshIndex, 'Otsu Threshold');

  columnHeader = ee.List([[
    { label: 'Backscatter', role: 'domain', type: 'number' },
    { label: 'Values', role: 'data', type: 'number' },
    { label: 'Threshold', role: 'annotation', type: 'string' }
  ]]);

  dataCol = ee.List.sequence(0, x.length().subtract(1)).map(function(i) {
    i = ee.Number(i);
    var row = ee.List(dataCol.get(i));
    return row.add(ee.String(thresholdCol.get(i)));
  });

  dataTable = columnHeader.cat(dataCol);

  dataTable.evaluate(function(dataTableClient) {
    for (var i = 0; i < dataTableClient.length; i++) {
      if (dataTableClient[i][2] === '') dataTableClient[i][2] = null;
    }
    var chart = ui.Chart(dataTableClient)
      .setChartType('AreaChart')
      .setOptions({
        title: bandLabel + ' Global Histogram with Threshold annotation',
        hAxis: { title: 'Backscatter [dB]', viewWindow: { min: -35, max: 15 } },
        vAxis: { title: 'Count' },
        annotations: { style: 'line' }
      });
    print(chart);
  });
}

// =====================================================================
// 4) PRODUCTION + GENERAL QA CORE
// =====================================================================

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

function buildDwBundle(y, m, startDate, endDate, dwCount) {
  var key = monthKey(y, m);

  var dwFiltered = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
    .filterBounds(aoi)
    .filterDate(startDate, endDate);

  if (SHOW_VIS && PRINT_COLLECTIONS) print('DW', key, dwFiltered);

  var probabilityBands = [
    'water', 'trees', 'grass', 'flooded_vegetation', 'crops',
    'shrub_and_scrub', 'built', 'bare', 'snow_and_ice'
  ];

  var probabilityImage = dwFiltered.select(probabilityBands).mean();
  var waterMaskCollection = dwFiltered.map(processWaterMask);
  var waterOccurrence = waterMaskCollection.sum().rename('water');

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
    var dwObsCount = uint16ToAoi(dwFiltered.select('water').count(), 'dw_obs_count');

    var dwValidCountRaw = dwFiltered.map(function(img) {
      var w = img.select('water');
      return w.gt(water_thr).or(w.lte(water_low_thr)).unmask(0).rename('valid_obs');
    }).sum();
    var dwValidCount = uint16ToAoi(dwValidCountRaw, 'dw_valid_count');

    var dwWaterCountRaw = dwFiltered.map(function(img) {
      var w = img.select('water');
      return w.gt(water_thr).unmask(0).rename('water_obs');
    }).sum();
    var dwWaterCount = uint16ToAoi(dwWaterCountRaw, 'dw_water_count');

    var dwUncertainCountRaw = dwFiltered.map(function(img) {
      var w = img.select('water');
      return w.gt(water_low_thr).and(w.lte(water_thr)).unmask(0).rename('uncertain_obs');
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

  if (SHOW_VIS && PRINT_COLLECTIONS) print('S1', key, s1Collection);

  var s1Image = s1Collection.min().clip(aoi);

  var histogramReducer = ee.Reducer.histogram(255, 0.1);
  var globalHistogram = ee.Dictionary(
    s1Image.select(band).reduceRegion({
      reducer: histogramReducer,
      geometry: aoi,
      scale: HIST_SCALE,
      maxPixels: 1e10
    }).get(band)
  );

  var thresholdOriginal = ee.Number(otsuOriginal(globalHistogram));
  var thresholdSafe = ee.Number(otsuSafe(globalHistogram));
  var thresholdDiff = thresholdSafe.subtract(thresholdOriginal);
  var thresholdAbsDiff = thresholdDiff.abs();
  var thresholdSame = intFlag(thresholdAbsDiff.lt(1e-12));

  printHistogramCharts(globalHistogram, USE_SAFE_OTSU ? thresholdSafe : thresholdOriginal, band);

  var s1ValidMask = s1Image.select(band).mask().selfMask();
  var s1ValidGapMask = s1ValidMask.updateMask(dw_nodata);

  var s1ValidAreaKm2 = areaKm2FromMask(s1ValidMask);
  var s1ValidGapAreaKm2 = areaKm2FromMask(s1ValidGapMask);
  var s1UncoveredGapAreaKm2 = ee.Number(0);

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
    out.s1ObsCount = uint16ToAoi(s1Collection.select(band).count(), 's1_obs_count');
  }

  if (useS1FullDiagnostics()) {
    out.s1MinDbX100 = int16ToAoi(s1Image.select(band).multiply(100).round(), 's1_min_db_x100');
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
    gapStatus = ee.Image(0).where(dw.dw_nodata.eq(1), 2);
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
    out.s1GapfillUsed = byteToAoi(finalObj.finalS1Component, 's1_gapfill_used');
  }
  if (useS1FullDiagnostics()) {
    out.s1ValidGap = byteToAoi(s1.s1ValidMask.unmask(0).eq(1).and(dw.dw_nodata.eq(1)), 's1_valid_gap');
    out.s1WaterGap = byteToAoi(finalObj.s1_water_mk, 's1_water_gap');
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
  return byteToAoi(ee.Image(0).where(dw_nodata.eq(1), hasS1 ? 1 : 2), 'fill_flag');
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

  if (!hasDw) return core;

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

function buildQaFeature(y, m, dwCount, s1Count) {
  var core = buildMonthlyCore(y, m, dwCount, s1Count);
  var props = core.baseProps;

  if (!core.hasDw) return ee.Feature(null, props);

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

  props.final_water_area_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalSafe.finalWaterAreaKm2.subtract(finalOrig.finalWaterAreaKm2) : null;
  props.final_water_area_abs_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalSafe.finalWaterAreaKm2.subtract(finalOrig.finalWaterAreaKm2).abs() : null;
  props.final_dw_component_area_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalSafe.finalDwComponentAreaKm2.subtract(finalOrig.finalDwComponentAreaKm2) : null;
  props.final_s1_component_area_diff_km2 = QA_INCLUDE_OUTPUT_DIFFERENCE ? finalSafe.finalS1ComponentAreaKm2.subtract(finalOrig.finalS1ComponentAreaKm2) : null;

  return ee.Feature(null, props);
}

function buildExportImage(core) {
  var exportImage = core.waterBand;

  if (EXPORT_LEGACY_FILL_FLAG) exportImage = exportImage.addBands(core.fillFlag);

  exportImage = exportImage
    .addBands(core.validFinal)
    .addBands(core.gapStatus)
    .addBands(core.finalSelected.waterSource);

  if (useDwDiagnostics()) {
    exportImage = exportImage
      .addBands(core.dw.dwObsCount)
      .addBands(core.dw.dwValidCount)
      .addBands(core.dw.dwWaterCount)
      .addBands(core.dw.dwUncertainCount)
      .addBands(core.dw.dwOccurrencePct)
      .addBands(core.dw.dwFloodedVegMeanPct);
  }

  if (useS1StandardDiagnostics()) {
    exportImage = exportImage
      .addBands(core.s1Diagnostics.s1ObsCount)
      .addBands(core.s1Diagnostics.s1GapfillUsed);
  }

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

  if (SHOW_VIS && core.hasS1) {
    var selectedThreshold = USE_SAFE_OTSU ? core.s1.thresholdSafe : core.s1.thresholdOriginal;
    print('Global threshold value (' + core.key + '):', selectedThreshold);
  }

  var desc = 'water_' + band + '_' + core.mStr + '_' + y;
  var assetPath = EXPORT_ASSET_FOLDER + '/' + desc;

  var exportImage = buildExportImage(core).set({
    version: 'v5.2_unified',
    run_mode: RUN_MODE,
    export_profile: EXPORT_PROFILE,
    year: y,
    month: m,
    s1_available: core.hasS1 ? 1 : 0,
    safe_otsu: USE_SAFE_OTSU ? 1 : 0,
    water_codes: '1=water;0=valid_nonwater;masked=no_valid_final_estimate',
    water_source_codes: '0=none_nonwater_invalid;1=DW_water;2=DW_floodedveg;3=DW_water_and_floodedveg;4=S1_Otsu_gapfill',
    gap_status_codes: '0=DW_valid_no_gap;1=DW_gap_S1_valid_pixel;2=DW_gap_no_S1_valid_pixel',
    valid_final_codes: '0=no_valid_final_estimate;1=valid_final_estimate',
    s1_processing: 'S1 images reduced to monthly min composite; one Otsu threshold applied to monthly composite',
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

function exportThresholdQaFromCountMaps(dwCountMap, s1CountMap) {
  var features = monthList.map(function(d) {
    var key = monthKey(d.year, d.month);
    var dwCount = dwCountMap[key] || 0;
    var s1Count = s1CountMap[key] || 0;
    return buildQaFeature(d.year, d.month, dwCount, s1Count);
  });

  var qaCollection = ee.FeatureCollection(features);
  if (SHOW_VIS) print('General threshold QA preview', qaCollection.limit(5));

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
}

function runExportWaterOrThresholdQa() {
  var globalStartDate = ee.Date.fromYMD(startYear, startMonth, 1);
  var globalEndDate = ee.Date.fromYMD(endYear, endMonth, 1).advance(1, 'month');

  var dwBase = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1').filterBounds(aoi);
  var s1Base = ee.ImageCollection('COPERNICUS/S1_GRD')
    .filterBounds(aoi)
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', band));

  buildMonthlyCountMap(dwBase, globalStartDate, globalEndDate, function(dwCountMap) {
    buildMonthlyCountMap(s1Base, globalStartDate, globalEndDate, function(s1CountMap) {

      if (RUN_MODE === 'THRESHOLD_QA') {
        exportThresholdQaFromCountMaps(dwCountMap, s1CountMap);
      }

      if (RUN_MODE === 'EXPORT_WATER') {
        monthList.forEach(function(d) {
          var key = monthKey(d.year, d.month);
          var dwCount = dwCountMap[key] || 0;
          var s1Count = s1CountMap[key] || 0;

          if (dwCount > 0) {
            processMonth(d.year, d.month, dwCount, s1Count);
          } else {
            print('Skipping ' + d.year + '-' + monthString(d.month) + ': no DW images.');
          }
        });
      }
    });
  });
}

// =====================================================================
// 5) S1 DRIVER QA MODE
// =====================================================================

function filterPass(coll, pass) {
  return coll.filter(ee.Filter.eq('orbitProperties_pass', pass));
}

function filterPlatform(coll, platform) {
  return coll.filter(ee.Filter.eq('platform_number', platform));
}

function filterPassPlatform(coll, pass, platform) {
  return coll
    .filter(ee.Filter.eq('orbitProperties_pass', pass))
    .filter(ee.Filter.eq('platform_number', platform));
}

function thresholdMetricsFromCollection(coll, prefix) {
  var count = ee.Number(coll.size());

  var empty = ee.Dictionary({})
    .set(prefix + '_threshold_original', NO_NUM)
    .set(prefix + '_threshold_safe', NO_NUM)
    .set(prefix + '_threshold_diff', NO_NUM)
    .set(prefix + '_threshold_abs_diff', NO_NUM);

  var computed = ee.Dictionary(ee.Algorithms.If(
    count.gt(0),
    (function() {
      var comp = coll.min().clip(aoi);
      var hist = ee.Dictionary(
        comp.select(band).reduceRegion({
          reducer: ee.Reducer.histogram(255, 0.1),
          geometry: aoi,
          scale: HIST_SCALE,
          maxPixels: 1e10
        }).get(band)
      );

      var thrOrig = ee.Number(otsuOriginal(hist));
      var thrSafe = ee.Number(otsuSafe(hist));
      var diff = thrSafe.subtract(thrOrig);

      return ee.Dictionary({})
        .set(prefix + '_threshold_original', thrOrig)
        .set(prefix + '_threshold_safe', thrSafe)
        .set(prefix + '_threshold_diff', diff)
        .set(prefix + '_threshold_abs_diff', diff.abs());
    })(),
    empty
  ));

  return computed;
}

function compositeStatsFromCollection(coll, prefix, dwNodataMask, hasDw) {
  var count = ee.Number(coll.size());

  var empty = ee.Dictionary({})
    .set(prefix + '_valid_area_km2', NO_NUM)
    .set(prefix + '_valid_gap_area_km2', NO_NUM)
    .set(prefix + '_angle_mean_deg', NO_NUM)
    .set(prefix + '_angle_std_deg', NO_NUM)
    .set(prefix + '_band_mean_db', NO_NUM)
    .set(prefix + '_band_std_db', NO_NUM);

  var computed = ee.Dictionary(ee.Algorithms.If(
    count.gt(0),
    (function() {
      var comp = coll.min().clip(aoi);
      var validMask = comp.select(band).mask().selfMask();
      var validGapMask = validMask.updateMask(dwNodataMask);

      var angleStats = comp.select('angle').reduceRegion({
        reducer: ee.Reducer.mean().combine({ reducer2: ee.Reducer.stdDev(), sharedInputs: true }),
        geometry: aoi,
        scale: STAT_SCALE,
        maxPixels: 1e10
      });

      var bandStats = comp.select(band).reduceRegion({
        reducer: ee.Reducer.mean().combine({ reducer2: ee.Reducer.stdDev(), sharedInputs: true }),
        geometry: aoi,
        scale: STAT_SCALE,
        maxPixels: 1e10
      });

      return ee.Dictionary({})
        .set(prefix + '_valid_area_km2', safeGetAreaKm2(validMask))
        .set(prefix + '_valid_gap_area_km2', ee.Number(ee.Algorithms.If(hasDw, safeGetAreaKm2(validGapMask), NO_NUM)))
        .set(prefix + '_angle_mean_deg', safeGetNumberOrNo(angleStats, 'angle_mean'))
        .set(prefix + '_angle_std_deg', safeGetNumberOrNo(angleStats, 'angle_stdDev'))
        .set(prefix + '_band_mean_db', safeGetNumberOrNo(bandStats, band + '_mean'))
        .set(prefix + '_band_std_db', safeGetNumberOrNo(bandStats, band + '_stdDev'));
    })(),
    empty
  ));

  return computed;
}

function buildS1DriverFeature(y, m) {
  var startDate = ee.Date.fromYMD(y, m, 1);
  var endDate = startDate.advance(1, 'month');
  var key = monthKey(y, m);

  var dwMonth = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
    .filterBounds(aoi)
    .filterDate(startDate, endDate);

  var dwCount = ee.Number(dwMonth.size());
  var hasDw = dwCount.gt(0);

  var dwComputed = ee.Dictionary(ee.Algorithms.If(
    hasDw,
    (function() {
      var probabilityBands = [
        'water', 'trees', 'grass', 'flooded_vegetation', 'crops',
        'shrub_and_scrub', 'built', 'bare', 'snow_and_ice'
      ];
      var probabilityImage = dwMonth.select(probabilityBands).mean();
      var waterMaskCollection = dwMonth.map(processWaterMask);
      var waterOccurrence = waterMaskCollection.sum().rename('water');
      var water_dw = waterOccurrence.gt(0)
        .or(probabilityImage.select('flooded_vegetation').gt(floodedveg_thr));

      var valid = water_dw.eq(0).or(water_dw.eq(1))
        .updateMask(water_dw.eq(0).or(water_dw.eq(1)))
        .unmask();

      var dwNodata = valid.eq(0).clip(aoi);

      return ee.Dictionary({})
        .set('dw_nodata_area_km2', safeGetAreaKm2(dwNodata))
        .set('dw_nodata_image', dwNodata)
        .set('dw_available', 1);
    })(),
    ee.Dictionary({})
      .set('dw_nodata_area_km2', NO_NUM)
      .set('dw_nodata_image', ee.Image(0).selfMask().clip(aoi))
      .set('dw_available', 0)
  ));

  var dwNodataAreaKm2 = ee.Number(dwComputed.get('dw_nodata_area_km2'));
  var dwNodata = ee.Image(dwComputed.get('dw_nodata_image'));
  var dwAvailableFlag = ee.Number(dwComputed.get('dw_available'));

  var s1Month = ee.ImageCollection('COPERNICUS/S1_GRD')
    .filterBounds(aoi)
    .filterDate(startDate, endDate)
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', band));

  var s1All = s1Month;
  var s1Asc = filterPass(s1Month, 'ASCENDING');
  var s1Desc = filterPass(s1Month, 'DESCENDING');

  var s1A = filterPlatform(s1Month, 'A');
  var s1B = filterPlatform(s1Month, 'B');
  var s1C = filterPlatform(s1Month, 'C');

  var s1AA = filterPassPlatform(s1Month, 'ASCENDING', 'A');
  var s1AD = filterPassPlatform(s1Month, 'DESCENDING', 'A');
  var s1BA = filterPassPlatform(s1Month, 'ASCENDING', 'B');
  var s1BD = filterPassPlatform(s1Month, 'DESCENDING', 'B');
  var s1CA = filterPassPlatform(s1Month, 'ASCENDING', 'C');
  var s1CD = filterPassPlatform(s1Month, 'DESCENDING', 'C');

  var nAll = ee.Number(s1All.size());
  var nAsc = ee.Number(s1Asc.size());
  var nDesc = ee.Number(s1Desc.size());
  var nA = ee.Number(s1A.size());
  var nB = ee.Number(s1B.size());
  var nC = ee.Number(s1C.size());
  var nAA = ee.Number(s1AA.size());
  var nAD = ee.Number(s1AD.size());
  var nBA = ee.Number(s1BA.size());
  var nBD = ee.Number(s1BD.size());
  var nCA = ee.Number(s1CA.size());
  var nCD = ee.Number(s1CD.size());

  var ascFraction = ee.Number(ee.Algorithms.If(nAll.gt(0), nAsc.divide(nAll), NO_NUM));
  var descFraction = ee.Number(ee.Algorithms.If(nAll.gt(0), nDesc.divide(nAll), NO_NUM));
  var AFraction = ee.Number(ee.Algorithms.If(nAll.gt(0), nA.divide(nAll), NO_NUM));
  var BFraction = ee.Number(ee.Algorithms.If(nAll.gt(0), nB.divide(nAll), NO_NUM));
  var CFraction = ee.Number(ee.Algorithms.If(nAll.gt(0), nC.divide(nAll), NO_NUM));
  var ascDescImbalance = ee.Number(ee.Algorithms.If(nAll.gt(0), nAsc.subtract(nDesc).abs().divide(nAll), NO_NUM));

  var postS1BAnomaly = startDate.millis().gte(S1B_ANOMALY_DATE.millis());
  var postS1BEnd = startDate.millis().gte(S1B_END_OF_MISSION_DATE.millis());
  var postS1CLaunch = startDate.millis().gte(S1C_LAUNCH_DATE.millis());
  var postS1CUserOpening = startDate.millis().gte(S1C_USER_OPENING_DATE.millis());
  var postS1CFullyCalibrated = startDate.millis().gte(S1C_FULLY_CALIBRATED_DATE.millis());

  var s1bEra = ee.String(
    ee.Algorithms.If(
      startDate.millis().lt(S1B_ANOMALY_DATE.millis()),
      'PRE_S1B_ANOMALY',
      ee.Algorithms.If(
        startDate.millis().lt(S1B_END_OF_MISSION_DATE.millis()),
        'POST_ANOMALY_PRE_END_OF_MISSION',
        'POST_S1B_END_OF_MISSION'
      )
    )
  );

  var s1cEra = ee.String(
    ee.Algorithms.If(
      startDate.millis().lt(S1C_LAUNCH_DATE.millis()),
      'PRE_S1C_LAUNCH',
      ee.Algorithms.If(
        startDate.millis().lt(S1C_USER_OPENING_DATE.millis()),
        'POST_S1C_LAUNCH_PRE_USER_OPENING',
        ee.Algorithms.If(
          startDate.millis().lt(S1C_FULLY_CALIBRATED_DATE.millis()),
          'POST_S1C_USER_OPENING_PRE_FULL_CALIBRATION',
          'POST_S1C_FULLY_CALIBRATED'
        )
      )
    )
  );

  var props = ee.Dictionary({})
    .set('year', y)
    .set('month', m)
    .set('month_key', key)
    .set('month_of_year', m)
    .set('dw_available', dwAvailableFlag)
    .set('dw_count', dwCount)
    .set('dw_nodata_area_km2', dwNodataAreaKm2)
    .set('s1_total_count', nAll)
    .set('s1_available', toFlag(nAll.gt(0)))
    .set('s1_asc_count', nAsc)
    .set('s1_desc_count', nDesc)
    .set('s1_A_count', nA)
    .set('s1_B_count', nB)
    .set('s1_C_count', nC)
    .set('s1_A_asc_count', nAA)
    .set('s1_A_desc_count', nAD)
    .set('s1_B_asc_count', nBA)
    .set('s1_B_desc_count', nBD)
    .set('s1_C_asc_count', nCA)
    .set('s1_C_desc_count', nCD)
    .set('s1_asc_fraction', ascFraction)
    .set('s1_desc_fraction', descFraction)
    .set('s1_A_fraction', AFraction)
    .set('s1_B_fraction', BFraction)
    .set('s1_C_fraction', CFraction)
    .set('s1_asc_desc_imbalance', ascDescImbalance)
    .set('s1b_era', s1bEra)
    .set('post_s1b_anomaly_flag', toFlag(postS1BAnomaly))
    .set('post_s1b_end_of_mission_flag', toFlag(postS1BEnd))
    .set('s1c_era', s1cEra)
    .set('post_s1c_launch_flag', toFlag(postS1CLaunch))
    .set('post_s1c_user_opening_flag', toFlag(postS1CUserOpening))
    .set('post_s1c_fully_calibrated_flag', toFlag(postS1CFullyCalibrated));

  props = props.combine(thresholdMetricsFromCollection(s1All, 'all'), true);

  if (S1_DRIVER_INCLUDE_ASC_DESC_THRESHOLDS) {
    props = props.combine(thresholdMetricsFromCollection(s1Asc, 'asc'), true);
    props = props.combine(thresholdMetricsFromCollection(s1Desc, 'desc'), true);
  } else {
    props = props
      .set('asc_threshold_original', NO_NUM).set('asc_threshold_safe', NO_NUM)
      .set('asc_threshold_diff', NO_NUM).set('asc_threshold_abs_diff', NO_NUM)
      .set('desc_threshold_original', NO_NUM).set('desc_threshold_safe', NO_NUM)
      .set('desc_threshold_diff', NO_NUM).set('desc_threshold_abs_diff', NO_NUM);
  }

  if (S1_DRIVER_INCLUDE_PLATFORM_THRESHOLDS) {
    props = props.combine(thresholdMetricsFromCollection(s1A, 'A'), true);
    props = props.combine(thresholdMetricsFromCollection(s1B, 'B'), true);
    props = props.combine(thresholdMetricsFromCollection(s1C, 'C'), true);
  } else {
    props = props
      .set('A_threshold_original', NO_NUM).set('A_threshold_safe', NO_NUM)
      .set('A_threshold_diff', NO_NUM).set('A_threshold_abs_diff', NO_NUM)
      .set('B_threshold_original', NO_NUM).set('B_threshold_safe', NO_NUM)
      .set('B_threshold_diff', NO_NUM).set('B_threshold_abs_diff', NO_NUM)
      .set('C_threshold_original', NO_NUM).set('C_threshold_safe', NO_NUM)
      .set('C_threshold_diff', NO_NUM).set('C_threshold_abs_diff', NO_NUM);
  }

  if (S1_DRIVER_INCLUDE_COMPOSITE_STATS || S1_DRIVER_INCLUDE_GAP_COVERAGE_STATS) {
    props = props.combine(compositeStatsFromCollection(s1All, 'all', dwNodata, hasDw), true);

    if (S1_DRIVER_INCLUDE_ASC_DESC_THRESHOLDS) {
      props = props.combine(compositeStatsFromCollection(s1Asc, 'asc', dwNodata, hasDw), true);
      props = props.combine(compositeStatsFromCollection(s1Desc, 'desc', dwNodata, hasDw), true);
    } else {
      props = props
        .set('asc_valid_area_km2', NO_NUM).set('asc_valid_gap_area_km2', NO_NUM)
        .set('asc_angle_mean_deg', NO_NUM).set('asc_angle_std_deg', NO_NUM)
        .set('asc_band_mean_db', NO_NUM).set('asc_band_std_db', NO_NUM)
        .set('desc_valid_area_km2', NO_NUM).set('desc_valid_gap_area_km2', NO_NUM)
        .set('desc_angle_mean_deg', NO_NUM).set('desc_angle_std_deg', NO_NUM)
        .set('desc_band_mean_db', NO_NUM).set('desc_band_std_db', NO_NUM);
    }

    if (S1_DRIVER_INCLUDE_PLATFORM_THRESHOLDS) {
      props = props.combine(compositeStatsFromCollection(s1A, 'A', dwNodata, hasDw), true);
      props = props.combine(compositeStatsFromCollection(s1B, 'B', dwNodata, hasDw), true);
      props = props.combine(compositeStatsFromCollection(s1C, 'C', dwNodata, hasDw), true);
    } else {
      props = props
        .set('A_valid_area_km2', NO_NUM).set('A_valid_gap_area_km2', NO_NUM)
        .set('A_angle_mean_deg', NO_NUM).set('A_angle_std_deg', NO_NUM)
        .set('A_band_mean_db', NO_NUM).set('A_band_std_db', NO_NUM)
        .set('B_valid_area_km2', NO_NUM).set('B_valid_gap_area_km2', NO_NUM)
        .set('B_angle_mean_deg', NO_NUM).set('B_angle_std_deg', NO_NUM)
        .set('B_band_mean_db', NO_NUM).set('B_band_std_db', NO_NUM)
        .set('C_valid_area_km2', NO_NUM).set('C_valid_gap_area_km2', NO_NUM)
        .set('C_angle_mean_deg', NO_NUM).set('C_angle_std_deg', NO_NUM)
        .set('C_band_mean_db', NO_NUM).set('C_band_std_db', NO_NUM);
    }
  }

  var allSafe = ee.Number(props.get('all_threshold_safe'));
  var ascSafe = ee.Number(props.get('asc_threshold_safe'));
  var descSafe = ee.Number(props.get('desc_threshold_safe'));
  var ASafe = ee.Number(props.get('A_threshold_safe'));
  var BSafe = ee.Number(props.get('B_threshold_safe'));
  var CSafe = ee.Number(props.get('C_threshold_safe'));

  var diffAllAsc = subtractOrNo(allSafe, ascSafe);
  var diffAllDesc = subtractOrNo(allSafe, descSafe);
  var diffAscDesc = subtractOrNo(ascSafe, descSafe);
  var diffAllA = subtractOrNo(allSafe, ASafe);
  var diffAllB = subtractOrNo(allSafe, BSafe);
  var diffAllC = subtractOrNo(allSafe, CSafe);
  var diffAB = subtractOrNo(ASafe, BSafe);
  var diffAC = subtractOrNo(ASafe, CSafe);
  var diffBC = subtractOrNo(BSafe, CSafe);

  props = props
    .set('safe_thr_all_minus_asc', diffAllAsc)
    .set('safe_thr_all_minus_asc_abs', absOrNo(diffAllAsc))
    .set('safe_thr_all_minus_desc', diffAllDesc)
    .set('safe_thr_all_minus_desc_abs', absOrNo(diffAllDesc))
    .set('safe_thr_asc_minus_desc', diffAscDesc)
    .set('safe_thr_asc_minus_desc_abs', absOrNo(diffAscDesc))
    .set('safe_thr_all_minus_A', diffAllA)
    .set('safe_thr_all_minus_A_abs', absOrNo(diffAllA))
    .set('safe_thr_all_minus_B', diffAllB)
    .set('safe_thr_all_minus_B_abs', absOrNo(diffAllB))
    .set('safe_thr_all_minus_C', diffAllC)
    .set('safe_thr_all_minus_C_abs', absOrNo(diffAllC))
    .set('safe_thr_A_minus_B', diffAB)
    .set('safe_thr_A_minus_B_abs', absOrNo(diffAB))
    .set('safe_thr_A_minus_C', diffAC)
    .set('safe_thr_A_minus_C_abs', absOrNo(diffAC))
    .set('safe_thr_B_minus_C', diffBC)
    .set('safe_thr_B_minus_C_abs', absOrNo(diffBC));

  return ee.Feature(null, props);
}

function s1DriverSelectors() {
  return [
    'year', 'month', 'month_key', 'month_of_year',
    'dw_available', 'dw_count', 'dw_nodata_area_km2',
    's1_total_count', 's1_available',
    's1_asc_count', 's1_desc_count',
    's1_A_count', 's1_B_count', 's1_C_count',
    's1_A_asc_count', 's1_A_desc_count',
    's1_B_asc_count', 's1_B_desc_count',
    's1_C_asc_count', 's1_C_desc_count',
    's1_asc_fraction', 's1_desc_fraction',
    's1_A_fraction', 's1_B_fraction', 's1_C_fraction',
    's1_asc_desc_imbalance',
    's1b_era', 'post_s1b_anomaly_flag', 'post_s1b_end_of_mission_flag',
    's1c_era', 'post_s1c_launch_flag', 'post_s1c_user_opening_flag', 'post_s1c_fully_calibrated_flag',
    'all_threshold_original', 'all_threshold_safe', 'all_threshold_diff', 'all_threshold_abs_diff',
    'asc_threshold_original', 'asc_threshold_safe', 'asc_threshold_diff', 'asc_threshold_abs_diff',
    'desc_threshold_original', 'desc_threshold_safe', 'desc_threshold_diff', 'desc_threshold_abs_diff',
    'A_threshold_original', 'A_threshold_safe', 'A_threshold_diff', 'A_threshold_abs_diff',
    'B_threshold_original', 'B_threshold_safe', 'B_threshold_diff', 'B_threshold_abs_diff',
    'C_threshold_original', 'C_threshold_safe', 'C_threshold_diff', 'C_threshold_abs_diff',
    'safe_thr_all_minus_asc', 'safe_thr_all_minus_asc_abs',
    'safe_thr_all_minus_desc', 'safe_thr_all_minus_desc_abs',
    'safe_thr_asc_minus_desc', 'safe_thr_asc_minus_desc_abs',
    'safe_thr_all_minus_A', 'safe_thr_all_minus_A_abs',
    'safe_thr_all_minus_B', 'safe_thr_all_minus_B_abs',
    'safe_thr_all_minus_C', 'safe_thr_all_minus_C_abs',
    'safe_thr_A_minus_B', 'safe_thr_A_minus_B_abs',
    'safe_thr_A_minus_C', 'safe_thr_A_minus_C_abs',
    'safe_thr_B_minus_C', 'safe_thr_B_minus_C_abs',
    'all_valid_area_km2', 'all_valid_gap_area_km2', 'all_angle_mean_deg', 'all_angle_std_deg', 'all_band_mean_db', 'all_band_std_db',
    'asc_valid_area_km2', 'asc_valid_gap_area_km2', 'asc_angle_mean_deg', 'asc_angle_std_deg', 'asc_band_mean_db', 'asc_band_std_db',
    'desc_valid_area_km2', 'desc_valid_gap_area_km2', 'desc_angle_mean_deg', 'desc_angle_std_deg', 'desc_band_mean_db', 'desc_band_std_db',
    'A_valid_area_km2', 'A_valid_gap_area_km2', 'A_angle_mean_deg', 'A_angle_std_deg', 'A_band_mean_db', 'A_band_std_db',
    'B_valid_area_km2', 'B_valid_gap_area_km2', 'B_angle_mean_deg', 'B_angle_std_deg', 'B_band_mean_db', 'B_band_std_db',
    'C_valid_area_km2', 'C_valid_gap_area_km2', 'C_angle_mean_deg', 'C_angle_std_deg', 'C_band_mean_db', 'C_band_std_db'
  ];
}

function exportS1DriverBatch(batch) {
  var months = makeMonthList(batch.startYear, batch.startMonth, batch.endYear, batch.endMonth);

  var features = months.map(function(d) {
    return buildS1DriverFeature(d.year, d.month);
  });

  var out = ee.FeatureCollection(features);
  var description = S1_DRIVER_EXPORT_PREFIX_BASE + '_' + batch.label;
  var filePrefix = S1_DRIVER_EXPORT_PREFIX_BASE + '_' + batch.label;

  if (SHOW_VIS) {
    print('Preparing S1_DRIVER_QA export for batch:', batch.label, 'months:', months.length);
    print('Preview ' + batch.label, out.limit(3));
  }

  Export.table.toDrive({
    collection: out,
    description: description,
    folder: S1_DRIVER_EXPORT_FOLDER,
    fileNamePrefix: filePrefix,
    fileFormat: 'CSV',
    selectors: s1DriverSelectors()
  });
}

function runS1DriverQa() {
  var batchMonthsFloat = S1_DRIVER_BATCH_YEARS * 12;
  var batchMonths = Math.round(batchMonthsFloat);
  var validBatchConfig =
    Math.abs(batchMonths - batchMonthsFloat) < 1e-9 &&
    batchMonths >= 1 &&
    ((batchMonths < 12 && (12 % batchMonths === 0)) ||
     (batchMonths >= 12 && (batchMonths % 12 === 0)));

  if (!validBatchConfig) {
    print('ERROR: Invalid S1_DRIVER_BATCH_YEARS. Use values like 0.25, 0.5, 1, 2. Current:', S1_DRIVER_BATCH_YEARS);
    return;
  }

  if (S1_DRIVER_EXPORT_IN_BATCHES) {
    var batches = makeBatchList(startYear, startMonth, endYear, endMonth, batchMonths);
    if (SHOW_VIS) print('S1_DRIVER_QA batches', batches);

    batches.forEach(function(batch) {
      if (S1_DRIVER_QUEUE_ALL_BATCHES || batch.label === S1_DRIVER_TARGET_BATCH_LABEL) {
        exportS1DriverBatch(batch);
      }
    });
  } else {
    exportS1DriverBatch({
      startYear: startYear,
      startMonth: startMonth,
      endYear: endYear,
      endMonth: endMonth,
      label: batchLabel(startYear, startMonth, endYear, endMonth)
    });
  }
}

// =====================================================================
// 6) RUN
// =====================================================================

print('Running unified script:', '1_SurfaceWater_v5.2_unified.js');
print('VERSION:', 'v5.2_unified');
print('RUN_MODE:', RUN_MODE);
print('EXPORT_PROFILE:', EXPORT_PROFILE);
print('USE_SAFE_OTSU:', USE_SAFE_OTSU);
print('EXPORT_LEGACY_FILL_FLAG:', EXPORT_LEGACY_FILL_FLAG);

if (RUN_MODE === 'EXPORT_WATER' || RUN_MODE === 'THRESHOLD_QA') {
  runExportWaterOrThresholdQa();
}

if (RUN_MODE === 'S1_DRIVER_QA') {
  runS1DriverQa();
}
