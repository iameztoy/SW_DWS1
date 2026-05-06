// ********************************************
// Tanganyika S1 threshold-driver QA
// Batched export version with Sentinel-1C support
// ********************************************

// Goal:
// Build monthly QA tables to investigate whether threshold variability is related to:
// - ASC vs DESC balance
// - Sentinel-1A / 1B / 1C availability
// - DW no-data / S1 gap coverage
// - monthly minimum-composite statistics
//
// This script mirrors the ORIGINAL S1 filtering logic used in the Tanganyika workflow:
//   - filterBounds(aoi)
//   - filterDate(startDate, endDate)
//   - instrumentMode = 'IW'
//   - chosen polarization present
//
// It does NOT filter by orbit pass or resolution for the "all scenes" stack,
// because the aim is to diagnose the original threshold behavior.

// ======================================================
// 0) PARAMETERS
// ======================================================

// AOI: Lake Tanganyika basin (HYBAS_ID 1041259950)
var hydrobasins = ee.FeatureCollection("WWF/HydroSHEDS/v1/Basins/hybas_4")
  .filter(ee.Filter.eq('HYBAS_ID', 1041259950));
var aoi = hydrobasins.geometry();

// Global period of interest
var startYear  = 2015;
var startMonth = 8;
var endYear    = 2025;
var endMonth   = 12;

// Dynamic World / Sentinel-1 settings
var band = 'VH';
var floodedveg_thr = 0.3;

// ------------------------------------------------------
// Batch export options
// ------------------------------------------------------

// true  -> export separate CSV tasks by batches
// false -> export a single CSV task for the whole period
var EXPORT_IN_BATCHES = true;

// Batch size in years.
// Examples:
// 1     = yearly batches
// 0.5   = half-year batches
// 0.25  = quarterly batches
// 1/3   = 4-month batches
// 2     = two-year batches
var BATCH_YEARS = 0.5;

// true  -> queue all batches
// false -> queue only the batch whose label matches TARGET_BATCH_LABEL
var QUEUE_ALL_BATCHES = true;

// Only used if QUEUE_ALL_BATCHES = false
// Examples:
// '2015_08_to_2015_12'
// '2016_01_to_2016_06'
// '2016_07_to_2016_12'
// '2025_01_to_2025_06'
var TARGET_BATCH_LABEL = '2015_08_to_2015_12';

// Export naming
var EXPORT_FOLDER = 'EarthEngine';
var EXPORT_PREFIX_BASE = 'Tanganyika_S1_driver_QA_' + band;

// ------------------------------------------------------
// Optional workload toggles
// If exports are still too heavy, turn some of these off.
// ------------------------------------------------------
var INCLUDE_ASC_DESC_THRESHOLDS = true;
var INCLUDE_PLATFORM_THRESHOLDS = true;   // A, B, C
var INCLUDE_COMPOSITE_STATS = true;
var INCLUDE_GAP_COVERAGE_STATS = true;

// Reduction scales
var HIST_SCALE = 90;   // keep same scale as original threshold histogram
var STAT_SCALE = 90;   // composite backscatter / angle stats
var AREA_SCALE = 10;   // area summaries

// Sentinel numeric placeholder to avoid null errors in Feature properties
var NO_NUM = -9999;

// Key mission dates kept as optional interpretation aids
var S1B_ANOMALY_DATE = ee.Date('2021-12-23');
var S1B_END_OF_MISSION_DATE = ee.Date('2022-08-03');

var S1C_LAUNCH_DATE = ee.Date('2024-12-05');
var S1C_USER_OPENING_DATE = ee.Date('2025-03-26');
var S1C_FULLY_CALIBRATED_DATE = ee.Date('2025-05-19');

// ======================================================
// 1) HELPERS
// ======================================================
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

function monthKey(y, m) {
  return y + '-' + (m < 10 ? '0' + m : m.toString());
}

function twoDigit(n) {
  return (n < 10 ? '0' + n : '' + n);
}

// Clear batch labels:
// 2015_08_to_2015_12
// 2016_01_to_2016_06
// 2016_07_to_2016_12
function batchLabel(sY, sM, eY, eM) {
  return sY + '_' + twoDigit(sM) + '_to_' + eY + '_' + twoDigit(eM);
}

// BATCH_YEARS -> months
var BATCH_MONTHS_FLOAT = BATCH_YEARS * 12;
var BATCH_MONTHS = Math.round(BATCH_MONTHS_FLOAT);

// Valid if:
// - batch length is a whole number of months
// - batch length >= 1 month
// - and either:
//    * it divides 12 cleanly (calendar sub-annual batches), or
//    * it is a multiple of 12 (multi-year batches)
var BATCH_CONFIG_VALID =
  Math.abs(BATCH_MONTHS - BATCH_MONTHS_FLOAT) < 1e-9 &&
  BATCH_MONTHS >= 1 &&
  (
    (BATCH_MONTHS < 12 && (12 % BATCH_MONTHS === 0)) ||
    (BATCH_MONTHS >= 12 && (BATCH_MONTHS % 12 === 0))
  );

// Calendar-aligned batch builder
function makeBatchList(sY, sM, eY, eM, batchMonths) {
  var batches = [];

  // Case 1: sub-annual calendar batches (e.g. 6, 4, 3, 2, 1 months)
  if (batchMonths < 12) {
    for (var y = sY; y <= eY; y++) {
      for (var blockStart = 1; blockStart <= 12; blockStart += batchMonths) {
        var blockEnd = blockStart + batchMonths - 1;

        // Skip blocks fully before start
        if (y === sY && blockEnd < sM) continue;

        // Skip blocks fully after end
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

  // Case 2: full-year or multi-year batches (12, 24, 36... months)
  var yearsPerBatch = batchMonths / 12;
  var batchStartYear = sY;

  while (batchStartYear <= eY) {
    var batchEndYear = Math.min(batchStartYear + yearsPerBatch - 1, eY);

    var batchStartMonth = (batchStartYear === sY) ? sM : 1;
    var batchEndMonth   = (batchEndYear === eY) ? eM : 12;

    if (batchStartYear === batchEndYear && batchStartMonth > batchEndMonth) {
      break;
    }

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

function safeGetNumberOrNo(dict, key) {
  dict = ee.Dictionary(dict);
  return ee.Number(
    ee.Algorithms.If(dict.contains(key), dict.get(key), NO_NUM)
  );
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

function processWaterMask(image) {
  var water = image.select('water');
  var waterMasked = water
    .where(water.lte(0.05), 0)
    .updateMask(water.gt(0.5).or(water.lte(0.05)))
    .where(water.gt(0.5), 1);

  return waterMasked.rename('water')
    .copyProperties(image, image.propertyNames());
}

function toFlag(boolCondition) {
  return ee.Number(ee.Algorithms.If(boolCondition, 1, 0));
}

function subtractOrNo(a, b) {
  return ee.Number(
    ee.Algorithms.If(
      ee.Number(a).eq(NO_NUM),
      NO_NUM,
      ee.Algorithms.If(
        ee.Number(b).eq(NO_NUM),
        NO_NUM,
        ee.Number(a).subtract(ee.Number(b))
      )
    )
  );
}

function absOrNo(x) {
  return ee.Number(
    ee.Algorithms.If(
      ee.Number(x).eq(NO_NUM),
      NO_NUM,
      ee.Number(x).abs()
    )
  );
}

// ======================================================
// 2) OTSU
// ======================================================
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
    var aMean   = aMeans.multiply(aCounts)
      .reduce(ee.Reducer.sum(), [0]).get([0])
      .divide(aCount);
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
  var sum   = ee.Number(
    means.multiply(counts).reduce(ee.Reducer.sum(), [0]).get([0])
  );
  var mean  = sum.divide(total);

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

// ======================================================
// 3) SENTINEL-1 SUBSET HELPERS
// ======================================================
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
        reducer: ee.Reducer.mean().combine({
          reducer2: ee.Reducer.stdDev(),
          sharedInputs: true
        }),
        geometry: aoi,
        scale: STAT_SCALE,
        maxPixels: 1e10
      });

      var bandStats = comp.select(band).reduceRegion({
        reducer: ee.Reducer.mean().combine({
          reducer2: ee.Reducer.stdDev(),
          sharedInputs: true
        }),
        geometry: aoi,
        scale: STAT_SCALE,
        maxPixels: 1e10
      });

      return ee.Dictionary({})
        .set(prefix + '_valid_area_km2', safeGetAreaKm2(validMask))
        .set(
          prefix + '_valid_gap_area_km2',
          ee.Number(ee.Algorithms.If(hasDw, safeGetAreaKm2(validGapMask), NO_NUM))
        )
        .set(prefix + '_angle_mean_deg', safeGetNumberOrNo(angleStats, 'angle_mean'))
        .set(prefix + '_angle_std_deg', safeGetNumberOrNo(angleStats, 'angle_stdDev'))
        .set(prefix + '_band_mean_db', safeGetNumberOrNo(bandStats, band + '_mean'))
        .set(prefix + '_band_std_db', safeGetNumberOrNo(bandStats, band + '_stdDev'));
    })(),
    empty
  ));

  return computed;
}

// ======================================================
// 4) MONTHLY FEATURE BUILDER
// ======================================================
function buildFeature(y, m) {
  var startDate = ee.Date.fromYMD(y, m, 1);
  var endDate = startDate.advance(1, 'month');
  var key = monthKey(y, m);

  // -----------------------
  // Dynamic World
  // -----------------------
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

  // -----------------------
  // Sentinel-1 month
  // ORIGINAL FILTERING LOGIC
  // -----------------------
  var s1Month = ee.ImageCollection('COPERNICUS/S1_GRD')
    .filterBounds(aoi)
    .filterDate(startDate, endDate)
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', band));

  var s1All  = s1Month;
  var s1Asc  = filterPass(s1Month, 'ASCENDING');
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

  var nAll  = ee.Number(s1All.size());
  var nAsc  = ee.Number(s1Asc.size());
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

  var ascDescImbalance = ee.Number(
    ee.Algorithms.If(nAll.gt(0), nAsc.subtract(nDesc).abs().divide(nAll), NO_NUM)
  );

  // -----------------------
  // Mission-era flags
  // -----------------------
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

  // -----------------------
  // Base properties
  // -----------------------
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

  // -----------------------
  // Thresholds
  // -----------------------
  props = props.combine(thresholdMetricsFromCollection(s1All, 'all'), true);

  if (INCLUDE_ASC_DESC_THRESHOLDS) {
    props = props.combine(thresholdMetricsFromCollection(s1Asc, 'asc'), true);
    props = props.combine(thresholdMetricsFromCollection(s1Desc, 'desc'), true);
  } else {
    props = props
      .set('asc_threshold_original', NO_NUM)
      .set('asc_threshold_safe', NO_NUM)
      .set('asc_threshold_diff', NO_NUM)
      .set('asc_threshold_abs_diff', NO_NUM)
      .set('desc_threshold_original', NO_NUM)
      .set('desc_threshold_safe', NO_NUM)
      .set('desc_threshold_diff', NO_NUM)
      .set('desc_threshold_abs_diff', NO_NUM);
  }

  if (INCLUDE_PLATFORM_THRESHOLDS) {
    props = props.combine(thresholdMetricsFromCollection(s1A, 'A'), true);
    props = props.combine(thresholdMetricsFromCollection(s1B, 'B'), true);
    props = props.combine(thresholdMetricsFromCollection(s1C, 'C'), true);
  } else {
    props = props
      .set('A_threshold_original', NO_NUM)
      .set('A_threshold_safe', NO_NUM)
      .set('A_threshold_diff', NO_NUM)
      .set('A_threshold_abs_diff', NO_NUM)
      .set('B_threshold_original', NO_NUM)
      .set('B_threshold_safe', NO_NUM)
      .set('B_threshold_diff', NO_NUM)
      .set('B_threshold_abs_diff', NO_NUM)
      .set('C_threshold_original', NO_NUM)
      .set('C_threshold_safe', NO_NUM)
      .set('C_threshold_diff', NO_NUM)
      .set('C_threshold_abs_diff', NO_NUM);
  }

  // -----------------------
  // Composite stats / gap coverage
  // -----------------------
  if (INCLUDE_COMPOSITE_STATS || INCLUDE_GAP_COVERAGE_STATS) {
    props = props.combine(compositeStatsFromCollection(s1All, 'all', dwNodata, hasDw), true);

    if (INCLUDE_ASC_DESC_THRESHOLDS) {
      props = props.combine(compositeStatsFromCollection(s1Asc, 'asc', dwNodata, hasDw), true);
      props = props.combine(compositeStatsFromCollection(s1Desc, 'desc', dwNodata, hasDw), true);
    } else {
      props = props
        .set('asc_valid_area_km2', NO_NUM)
        .set('asc_valid_gap_area_km2', NO_NUM)
        .set('asc_angle_mean_deg', NO_NUM)
        .set('asc_angle_std_deg', NO_NUM)
        .set('asc_band_mean_db', NO_NUM)
        .set('asc_band_std_db', NO_NUM)
        .set('desc_valid_area_km2', NO_NUM)
        .set('desc_valid_gap_area_km2', NO_NUM)
        .set('desc_angle_mean_deg', NO_NUM)
        .set('desc_angle_std_deg', NO_NUM)
        .set('desc_band_mean_db', NO_NUM)
        .set('desc_band_std_db', NO_NUM);
    }

    if (INCLUDE_PLATFORM_THRESHOLDS) {
      props = props.combine(compositeStatsFromCollection(s1A, 'A', dwNodata, hasDw), true);
      props = props.combine(compositeStatsFromCollection(s1B, 'B', dwNodata, hasDw), true);
      props = props.combine(compositeStatsFromCollection(s1C, 'C', dwNodata, hasDw), true);
    } else {
      props = props
        .set('A_valid_area_km2', NO_NUM)
        .set('A_valid_gap_area_km2', NO_NUM)
        .set('A_angle_mean_deg', NO_NUM)
        .set('A_angle_std_deg', NO_NUM)
        .set('A_band_mean_db', NO_NUM)
        .set('A_band_std_db', NO_NUM)

        .set('B_valid_area_km2', NO_NUM)
        .set('B_valid_gap_area_km2', NO_NUM)
        .set('B_angle_mean_deg', NO_NUM)
        .set('B_angle_std_deg', NO_NUM)
        .set('B_band_mean_db', NO_NUM)
        .set('B_band_std_db', NO_NUM)

        .set('C_valid_area_km2', NO_NUM)
        .set('C_valid_gap_area_km2', NO_NUM)
        .set('C_angle_mean_deg', NO_NUM)
        .set('C_angle_std_deg', NO_NUM)
        .set('C_band_mean_db', NO_NUM)
        .set('C_band_std_db', NO_NUM);
    }
  } else {
    props = props
      .set('all_valid_area_km2', NO_NUM)
      .set('all_valid_gap_area_km2', NO_NUM)
      .set('all_angle_mean_deg', NO_NUM)
      .set('all_angle_std_deg', NO_NUM)
      .set('all_band_mean_db', NO_NUM)
      .set('all_band_std_db', NO_NUM)

      .set('asc_valid_area_km2', NO_NUM)
      .set('asc_valid_gap_area_km2', NO_NUM)
      .set('asc_angle_mean_deg', NO_NUM)
      .set('asc_angle_std_deg', NO_NUM)
      .set('asc_band_mean_db', NO_NUM)
      .set('asc_band_std_db', NO_NUM)

      .set('desc_valid_area_km2', NO_NUM)
      .set('desc_valid_gap_area_km2', NO_NUM)
      .set('desc_angle_mean_deg', NO_NUM)
      .set('desc_angle_std_deg', NO_NUM)
      .set('desc_band_mean_db', NO_NUM)
      .set('desc_band_std_db', NO_NUM)

      .set('A_valid_area_km2', NO_NUM)
      .set('A_valid_gap_area_km2', NO_NUM)
      .set('A_angle_mean_deg', NO_NUM)
      .set('A_angle_std_deg', NO_NUM)
      .set('A_band_mean_db', NO_NUM)
      .set('A_band_std_db', NO_NUM)

      .set('B_valid_area_km2', NO_NUM)
      .set('B_valid_gap_area_km2', NO_NUM)
      .set('B_angle_mean_deg', NO_NUM)
      .set('B_angle_std_deg', NO_NUM)
      .set('B_band_mean_db', NO_NUM)
      .set('B_band_std_db', NO_NUM)

      .set('C_valid_area_km2', NO_NUM)
      .set('C_valid_gap_area_km2', NO_NUM)
      .set('C_angle_mean_deg', NO_NUM)
      .set('C_angle_std_deg', NO_NUM)
      .set('C_band_mean_db', NO_NUM)
      .set('C_band_std_db', NO_NUM);
  }

  // -----------------------
  // Derived comparisons
  // -----------------------
  var allSafe  = ee.Number(props.get('all_threshold_safe'));
  var ascSafe  = ee.Number(props.get('asc_threshold_safe'));
  var descSafe = ee.Number(props.get('desc_threshold_safe'));
  var ASafe    = ee.Number(props.get('A_threshold_safe'));
  var BSafe    = ee.Number(props.get('B_threshold_safe'));
  var CSafe    = ee.Number(props.get('C_threshold_safe'));

  var diffAllAsc  = subtractOrNo(allSafe, ascSafe);
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

// ======================================================
// 5) EXPORT HELPERS
// ======================================================
function exportBatch(batch) {
  var months = makeMonthList(batch.startYear, batch.startMonth, batch.endYear, batch.endMonth);

  var features = months.map(function(d) {
    return buildFeature(d.year, d.month);
  });

  var out = ee.FeatureCollection(features);

  var description = EXPORT_PREFIX_BASE + '_' + batch.label;
  var filePrefix  = EXPORT_PREFIX_BASE + '_' + batch.label;

  print('Preparing export for batch:', batch.label, 'months:', months.length);
  print('Preview ' + batch.label, out.limit(3));

  Export.table.toDrive({
    collection: out,
    description: description,
    folder: EXPORT_FOLDER,
    fileNamePrefix: filePrefix,
    fileFormat: 'CSV',
    selectors: [
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

      'all_threshold_original', 'all_threshold_safe',
      'all_threshold_diff', 'all_threshold_abs_diff',

      'asc_threshold_original', 'asc_threshold_safe',
      'asc_threshold_diff', 'asc_threshold_abs_diff',

      'desc_threshold_original', 'desc_threshold_safe',
      'desc_threshold_diff', 'desc_threshold_abs_diff',

      'A_threshold_original', 'A_threshold_safe',
      'A_threshold_diff', 'A_threshold_abs_diff',

      'B_threshold_original', 'B_threshold_safe',
      'B_threshold_diff', 'B_threshold_abs_diff',

      'C_threshold_original', 'C_threshold_safe',
      'C_threshold_diff', 'C_threshold_abs_diff',

      'safe_thr_all_minus_asc', 'safe_thr_all_minus_asc_abs',
      'safe_thr_all_minus_desc', 'safe_thr_all_minus_desc_abs',
      'safe_thr_asc_minus_desc', 'safe_thr_asc_minus_desc_abs',

      'safe_thr_all_minus_A', 'safe_thr_all_minus_A_abs',
      'safe_thr_all_minus_B', 'safe_thr_all_minus_B_abs',
      'safe_thr_all_minus_C', 'safe_thr_all_minus_C_abs',

      'safe_thr_A_minus_B', 'safe_thr_A_minus_B_abs',
      'safe_thr_A_minus_C', 'safe_thr_A_minus_C_abs',
      'safe_thr_B_minus_C', 'safe_thr_B_minus_C_abs',

      'all_valid_area_km2', 'all_valid_gap_area_km2',
      'all_angle_mean_deg', 'all_angle_std_deg',
      'all_band_mean_db', 'all_band_std_db',

      'asc_valid_area_km2', 'asc_valid_gap_area_km2',
      'asc_angle_mean_deg', 'asc_angle_std_deg',
      'asc_band_mean_db', 'asc_band_std_db',

      'desc_valid_area_km2', 'desc_valid_gap_area_km2',
      'desc_angle_mean_deg', 'desc_angle_std_deg',
      'desc_band_mean_db', 'desc_band_std_db',

      'A_valid_area_km2', 'A_valid_gap_area_km2',
      'A_angle_mean_deg', 'A_angle_std_deg',
      'A_band_mean_db', 'A_band_std_db',

      'B_valid_area_km2', 'B_valid_gap_area_km2',
      'B_angle_mean_deg', 'B_angle_std_deg',
      'B_band_mean_db', 'B_band_std_db',

      'C_valid_area_km2', 'C_valid_gap_area_km2',
      'C_angle_mean_deg', 'C_angle_std_deg',
      'C_band_mean_db', 'C_band_std_db'
    ]
  });
}

// ======================================================
// 6) RUN
// ======================================================
if (!BATCH_CONFIG_VALID) {
  print('Invalid BATCH_YEARS value:', BATCH_YEARS);
  print('Use a value that corresponds to a whole number of months and aligns with the calendar.');
  print('Examples: 1, 0.5, 0.25, 1/3, 1/12, 2');
} else {
  if (EXPORT_IN_BATCHES) {
    var batches = makeBatchList(startYear, startMonth, endYear, endMonth, BATCH_MONTHS);
    print('Batches to export:', batches);

    batches.forEach(function(batch) {
      if (QUEUE_ALL_BATCHES || batch.label === TARGET_BATCH_LABEL) {
        exportBatch(batch);
      }
    });

  } else {
    exportBatch({
      startYear: startYear,
      startMonth: startMonth,
      endYear: endYear,
      endMonth: endMonth,
      label: batchLabel(startYear, startMonth, endYear, endMonth)
    });
  }
}
