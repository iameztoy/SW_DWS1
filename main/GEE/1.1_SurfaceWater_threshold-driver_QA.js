// ********************************************
// Tanganyika S1 threshold-driver QA
// ********************************************

// Goal:
// Build a monthly QA table to investigate whether threshold variability is
// related to:
// - ASC vs DESC balance
// - Sentinel-1A vs Sentinel-1B availability
// - DW no-data / S1 gap coverage
// - monthly minimum-composite statistics
//
// IMPORTANT:
// This script intentionally mirrors the ORIGINAL S1 filtering logic used in
// the Tanganyika workflow:
//   - filterBounds(aoi)
//   - filterDate(startDate, endDate)
//   - instrumentMode = 'IW'
//   - chosen polarization present
// It does NOT filter by orbit pass or resolution, because the aim is to
// diagnose the original threshold behavior, not to change it.

// ********************
// PARAMETERS
// ********************
var hydrobasins = ee.FeatureCollection("WWF/HydroSHEDS/v1/Basins/hybas_4")
  .filter(ee.Filter.eq('HYBAS_ID', 1041259950));
var aoi = hydrobasins.geometry();

var startYear  = 2015;
var startMonth = 8;
var endYear    = 2025;
var endMonth   = 12;

var band = 'VH';
var floodedveg_thr = 0.3;

// Export settings
var EXPORT_DESCRIPTION = 'Tanganyika_S1_driver_QA_' + band + '_' + startYear + '_' + endYear;
var EXPORT_FOLDER = 'EarthEngine';
var EXPORT_PREFIX = 'Tanganyika_S1_driver_QA_' + band + '_' + startYear + '_' + endYear;

// Optional workload toggles
var INCLUDE_ASC_DESC_THRESHOLDS = true;
var INCLUDE_PLATFORM_THRESHOLDS = true;
var INCLUDE_COMPOSITE_STATS = true;
var INCLUDE_GAP_COVERAGE_STATS = true;

// Reduction scales
var HIST_SCALE = 90;   // keep same scale as your original threshold histogram
var STAT_SCALE = 90;   // composite backscatter / angle stats
var AREA_SCALE = 10;   // area summaries

// Sentinel-1B anomaly / era markers
var S1B_ANOMALY_DATE = ee.Date('2021-12-23');
var S1B_END_OF_MISSION_DATE = ee.Date('2022-08-03');

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

function monthKey(y, m) {
  return y + '-' + (m < 10 ? '0' + m : m.toString());
}

function safeGetNumber(dict, key) {
  dict = ee.Dictionary(dict);
  return ee.Algorithms.If(dict.contains(key), ee.Number(dict.get(key)), null);
}

function safeGetArea(maskImage) {
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

// ********************
// S1 SUBSET HELPERS
// ********************
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

  var empty = ee.Dictionary({
    [prefix + '_threshold_original']: null,
    [prefix + '_threshold_safe']: null,
    [prefix + '_threshold_diff']: null,
    [prefix + '_threshold_abs_diff']: null
  });

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

      return ee.Dictionary({
        [prefix + '_threshold_original']: thrOrig,
        [prefix + '_threshold_safe']: thrSafe,
        [prefix + '_threshold_diff']: diff,
        [prefix + '_threshold_abs_diff']: diff.abs()
      });
    })(),
    empty
  ));

  return computed;
}

function compositeStatsFromCollection(coll, prefix, dwNodataMask) {
  var count = ee.Number(coll.size());

  var empty = ee.Dictionary({
    [prefix + '_valid_area_km2']: null,
    [prefix + '_valid_gap_area_km2']: null,
    [prefix + '_angle_mean_deg']: null,
    [prefix + '_angle_std_deg']: null,
    [prefix + '_band_mean_db']: null,
    [prefix + '_band_std_db']: null
  });

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

      return ee.Dictionary({
        [prefix + '_valid_area_km2']: safeGetArea(validMask),
        [prefix + '_valid_gap_area_km2']: safeGetArea(validGapMask),
        [prefix + '_angle_mean_deg']: safeGetNumber(angleStats, 'angle_mean'),
        [prefix + '_angle_std_deg']: safeGetNumber(angleStats, 'angle_stdDev'),
        [prefix + '_band_mean_db']: safeGetNumber(bandStats, band + '_mean'),
        [prefix + '_band_std_db']: safeGetNumber(bandStats, band + '_stdDev')
      });
    })(),
    empty
  ));

  return computed;
}

// ********************
// MONTHLY FEATURE
// ********************
function buildFeature(y, m) {
  var startDate = ee.Date.fromYMD(y, m, 1);
  var endDate = startDate.advance(1, 'month');
  var key = monthKey(y, m);

  // Dynamic World month
  var dwMonth = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
    .filterBounds(aoi)
    .filterDate(startDate, endDate);

  var dwCount = ee.Number(dwMonth.size());

  // DW no-data exactly as in your workflow
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
  var dwNodataAreaKm2 = safeGetArea(dwNodata);

  // Sentinel-1 month: ORIGINAL FILTERING LOGIC
  var s1Month = ee.ImageCollection('COPERNICUS/S1_GRD')
    .filterBounds(aoi)
    .filterDate(startDate, endDate)
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', band));

  var s1All  = s1Month;
  var s1Asc  = filterPass(s1Month, 'ASCENDING');
  var s1Desc = filterPass(s1Month, 'DESCENDING');
  var s1A    = filterPlatform(s1Month, 'A');
  var s1B    = filterPlatform(s1Month, 'B');

  var s1AA = filterPassPlatform(s1Month, 'ASCENDING', 'A');
  var s1AD = filterPassPlatform(s1Month, 'DESCENDING', 'A');
  var s1BA = filterPassPlatform(s1Month, 'ASCENDING', 'B');
  var s1BD = filterPassPlatform(s1Month, 'DESCENDING', 'B');

  var nAll  = ee.Number(s1All.size());
  var nAsc  = ee.Number(s1Asc.size());
  var nDesc = ee.Number(s1Desc.size());
  var nA    = ee.Number(s1A.size());
  var nB    = ee.Number(s1B.size());

  var nAA = ee.Number(s1AA.size());
  var nAD = ee.Number(s1AD.size());
  var nBA = ee.Number(s1BA.size());
  var nBD = ee.Number(s1BD.size());

  var ascFraction = ee.Algorithms.If(nAll.gt(0), nAsc.divide(nAll), null);
  var descFraction = ee.Algorithms.If(nAll.gt(0), nDesc.divide(nAll), null);
  var AFraction = ee.Algorithms.If(nAll.gt(0), nA.divide(nAll), null);
  var BFraction = ee.Algorithms.If(nAll.gt(0), nB.divide(nAll), null);

  var ascDescImbalance = ee.Algorithms.If(
    nAll.gt(0),
    nAsc.subtract(nDesc).abs().divide(nAll),
    null
  );

  var postS1BAnomaly = startDate.millis().gte(S1B_ANOMALY_DATE.millis());
  var postS1BEnd = startDate.millis().gte(S1B_END_OF_MISSION_DATE.millis());

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

  var props = ee.Dictionary({
    year: y,
    month: m,
    month_key: key,
    month_of_year: m,

    dw_count: dwCount,
    dw_nodata_area_km2: dwNodataAreaKm2,

    s1_total_count: nAll,
    s1_asc_count: nAsc,
    s1_desc_count: nDesc,
    s1_A_count: nA,
    s1_B_count: nB,

    s1_A_asc_count: nAA,
    s1_A_desc_count: nAD,
    s1_B_asc_count: nBA,
    s1_B_desc_count: nBD,

    s1_asc_fraction: ascFraction,
    s1_desc_fraction: descFraction,
    s1_A_fraction: AFraction,
    s1_B_fraction: BFraction,
    s1_asc_desc_imbalance: ascDescImbalance,

    post_s1b_anomaly_flag: ee.Number(ee.Algorithms.If(postS1BAnomaly, 1, 0)),
    post_s1b_end_of_mission_flag: ee.Number(ee.Algorithms.If(postS1BEnd, 1, 0)),
    s1b_era: s1bEra
  });

  // Thresholds
  props = props.combine(thresholdMetricsFromCollection(s1All, 'all'), true);

  if (INCLUDE_ASC_DESC_THRESHOLDS) {
    props = props.combine(thresholdMetricsFromCollection(s1Asc, 'asc'), true);
    props = props.combine(thresholdMetricsFromCollection(s1Desc, 'desc'), true);
  }

  if (INCLUDE_PLATFORM_THRESHOLDS) {
    props = props.combine(thresholdMetricsFromCollection(s1A, 'A'), true);
    props = props.combine(thresholdMetricsFromCollection(s1B, 'B'), true);
  }

  // Composite stats / coverage
  if (INCLUDE_COMPOSITE_STATS || INCLUDE_GAP_COVERAGE_STATS) {
    props = props.combine(compositeStatsFromCollection(s1All, 'all', dwNodata), true);

    if (INCLUDE_ASC_DESC_THRESHOLDS) {
      props = props.combine(compositeStatsFromCollection(s1Asc, 'asc', dwNodata), true);
      props = props.combine(compositeStatsFromCollection(s1Desc, 'desc', dwNodata), true);
    }

    if (INCLUDE_PLATFORM_THRESHOLDS) {
      props = props.combine(compositeStatsFromCollection(s1A, 'A', dwNodata), true);
      props = props.combine(compositeStatsFromCollection(s1B, 'B', dwNodata), true);
    }
  }

  // Derived threshold comparisons
  var allSafe  = props.get('all_threshold_safe');
  var ascSafe  = props.get('asc_threshold_safe');
  var descSafe = props.get('desc_threshold_safe');
  var ASafe    = props.get('A_threshold_safe');
  var BSafe    = props.get('B_threshold_safe');

  props = props.combine(ee.Dictionary({
    safe_thr_all_minus_asc: ee.Algorithms.If(
      ee.Algorithms.IsEqual(allSafe, null).or(ee.Algorithms.IsEqual(ascSafe, null)),
      null,
      ee.Number(allSafe).subtract(ee.Number(ascSafe))
    ),
    safe_thr_all_minus_desc: ee.Algorithms.If(
      ee.Algorithms.IsEqual(allSafe, null).or(ee.Algorithms.IsEqual(descSafe, null)),
      null,
      ee.Number(allSafe).subtract(ee.Number(descSafe))
    ),
    safe_thr_asc_minus_desc: ee.Algorithms.If(
      ee.Algorithms.IsEqual(ascSafe, null).or(ee.Algorithms.IsEqual(descSafe, null)),
      null,
      ee.Number(ascSafe).subtract(ee.Number(descSafe))
    ),
    safe_thr_A_minus_B: ee.Algorithms.If(
      ee.Algorithms.IsEqual(ASafe, null).or(ee.Algorithms.IsEqual(BSafe, null)),
      null,
      ee.Number(ASafe).subtract(ee.Number(BSafe))
    )
  }), true);

  return ee.Feature(null, props);
}

// ********************
// RUN
// ********************
var monthList = makeMonthList(startYear, startMonth, endYear, endMonth);

var features = monthList.map(function(d) {
  return buildFeature(d.year, d.month);
});

var out = ee.FeatureCollection(features);

print('Preview', out.limit(5));

Export.table.toDrive({
  collection: out,
  description: EXPORT_DESCRIPTION,
  folder: EXPORT_FOLDER,
  fileNamePrefix: EXPORT_PREFIX,
  fileFormat: 'CSV',
  selectors: [
    'year', 'month', 'month_key', 'month_of_year',
    's1b_era', 'post_s1b_anomaly_flag', 'post_s1b_end_of_mission_flag',

    'dw_count', 'dw_nodata_area_km2',

    's1_total_count',
    's1_asc_count', 's1_desc_count',
    's1_A_count', 's1_B_count',
    's1_A_asc_count', 's1_A_desc_count',
    's1_B_asc_count', 's1_B_desc_count',

    's1_asc_fraction', 's1_desc_fraction',
    's1_A_fraction', 's1_B_fraction',
    's1_asc_desc_imbalance',

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

    'safe_thr_all_minus_asc',
    'safe_thr_all_minus_desc',
    'safe_thr_asc_minus_desc',
    'safe_thr_A_minus_B',

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
    'B_band_mean_db', 'B_band_std_db'
  ]
});
