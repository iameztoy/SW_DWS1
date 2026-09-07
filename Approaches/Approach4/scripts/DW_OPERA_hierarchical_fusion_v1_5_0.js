// SCRIPT VERSION: v1.5.0
// Product logic: DW -> HLS-Landsat valid 0/1/2 -> HLS-Sentinel-2 valid
// 0/1/2 -> S1 valid 0/1/3, with optional
// post-fusion S1 HAND commission correction (disabled by default) and an
// optional combined Dynamic World class 3 (enabled by default).
var SCRIPT_VERSION = 'v1.5.0';

// ============================================================================
// HIERARCHICAL SURFACE-WATER FUSION — TIME-SERIES / MOVING-WINDOW VERSION
// Dynamic World -> OPERA DSWx-HLS Landsat -> OPERA DSWx-HLS Sentinel-2
// -> OPERA DSWx-S1
//
// For each temporal window:
//   1. Derive Dynamic World open water and inundated vegetation.
//   2. Resolve Dynamic World NoData with valid Landsat OPERA DSWx-HLS
//      classes: 0=not water, 1=open water, 2=partial surface water.
//   3. Resolve remaining gaps with Sentinel-2 OPERA DSWx-HLS classes 0/1/2.
//      By default, each HLS-S2 daily pixel is eligible only where the official
//      DW label is invalid on that same UTC date.
//   4. Use OPERA DSWx-S1 only on gaps still unresolved after both HLS branches. Valid
//      native S1 classes are 0=not water, 1=open water and 3=inundated vegetation.
//   5. Optionally apply a separate post-fusion S1 HAND commission correction.
//   6. Preserve harmonized class, provenance and final unresolved NoData.
//   7. Produce optional binary/reclassified products and diagnostics.
//   8. Export one multiband image per temporal window to an ImageCollection.
//   9. Alternatively, evaluate final NoData coverage for every temporal window
//      and export one CSV table without exporting the water-mask images.
//
// The end date of every period is exclusive.
// No area calculations are included. Pixel-count reduceRegion operations are
// used only when RUN_MODE = 'NODATA_EVALUATION'.
// ============================================================================

// ============================================================================
// 0) USER SETTINGS
// ============================================================================

// -------------------------
// Main processing mode
// -------------------------
// Options:
//   'WATER_MASKS'       -> preview the selected window and, when DO_EXPORTS is
//                          true, export one image per temporal window.
//   'NODATA_EVALUATION' -> do not export water-mask images; calculate pixel
//                          coverage statistics for every temporal window and
//                          export one CSV table.
//
// Both modes use exactly the same AOI, dates, temporal windows, thresholds,
// Dynamic World settings and OPERA source hierarchy configured below.
//
// IMPORTANT:
// Both HLS branches have priority over S1. HLS class 0 is valid evidence of
// "not water", so it resolves a gap and prevents lower-priority replacement.
// S1 valid thematic classes 0/1/3 resolve only gaps remaining after both HLS branches.
// S1 mask/fill values 250/251/254/255 never resolve a gap.
var RUN_MODE = 'WATER_MASKS';

// -------------------------
// AOI: choose either HydroBASINS or a drawn/imported polygon
// -------------------------
// Options:
//   'HYDROBASINS'    -> use the selected HydroBASINS level and HYBAS_ID
//   'DRAWN_GEOMETRY' -> use a polygon drawn/imported in the Code Editor
var AOI_MODE = 'HYDROBASINS';

// ----- Option A: HydroBASINS -----
// HydroBASINS levels available in Earth Engine: 1 through 12.
// HYBAS_ID values are specific to each HydroBASINS level.
var HYDROBASINS_LEVEL = 3;
var HYDROBASINS_ID = 1030040200;

// ----- Option B: Drawn/imported geometry -----
// Draw/import a polygon, ensure it appears in Imports, then assign it here:
// var DRAWN_AOI = geometry;
// Leave null when using HydroBASINS.
var DRAWN_AOI = null;

// -------------------------
// Overall time-series range
// -------------------------
// SERIES_END_DATE is exclusive.
// Examples:
//   Entire 2025:      2025-01-01 to 2026-01-01
//   2024 through 2026: 2024-01-01 to 2027-01-01
var SERIES_START_DATE = '2024-08-01';
var SERIES_END_DATE   = '2026-08-01';

// -------------------------
// Temporal-window definition
// -------------------------
// Options:
//   'MONTHS' -> window and step are expressed in calendar months.
//   'DAYS'   -> window and step are expressed in fixed days.
//
// MONTHS example — monthly, non-overlapping:
//   WINDOW_SIZE_MONTHS = 1
//   WINDOW_STEP_MONTHS = 1
//
// DAYS example — 21-day, non-overlapping:
//   WINDOW_SIZE_DAYS = 21
//   WINDOW_STEP_DAYS = 21
//
// Overlapping moving-window example:
//   WINDOW_SIZE_DAYS = 21
//   WINDOW_STEP_DAYS = 10
var TIME_STEP_MODE = 'MONTHS';

var WINDOW_SIZE_MONTHS = 1;
var WINDOW_STEP_MONTHS = 1;

var WINDOW_SIZE_DAYS = 21;
var WINDOW_STEP_DAYS = 21;

// true: include a shortened final window ending exactly on SERIES_END_DATE.
// false: omit the final window if it would be shorter than the requested size.
var INCLUDE_PARTIAL_FINAL_WINDOW = true;

// Safety limit against accidentally generating very large numbers of windows.
var MAX_WINDOWS_TO_BUILD = 500;

// -------------------------
// Source hierarchy toggles
// -------------------------
var USE_HLS_LANDSAT_FILL = true;
var USE_HLS_SENTINEL2_FILL = true;
var USE_OPERA_S1_FILL = true;

// Recommended native-diagnostic alignment with the annual v6.9 application.
// Before its temporal mode, each daily HLS-Sentinel-2 pixel is retained only
// where the official Dynamic World label has no valid pixel on the same UTC
// date. Strict window-level DW priority already subsumes this rule for the
// final fused class; applying it here also aligns native S2 diagnostics.
var HLS_SENTINEL2_SAME_DAY_DW_GAP_ONLY = true;

// Optional commission correction applied only after the complete DW ->
// HLS-Landsat -> HLS-Sentinel-2 -> S1 hierarchy. When enabled, a pre-HAND
// water-related final class is changed
// to valid non-water only where at least one S1 WTR observation is class 250
// and there are zero valid S1 thematic observations 0/1/3 in the window.
// It never creates NoData and never participates in source-priority decisions.
var APPLY_S1_HAND_POSTPROCESSING = false;

// -------------------------
// Dynamic World thresholds
// -------------------------
// WATER_THRESHOLD is applied to every individual DW observation.
var WATER_THRESHOLD       = 0.50;
var WATER_LOW_THRESHOLD   = 0.05;
var FLOODED_VEG_THRESHOLD = 0.40;

// Flooded-vegetation detection rule.
// Options:
//   'PROBABILITY'           = flooded_vegetation probability > threshold
//   'LABEL'                 = official DW label equals 3
//   'LABEL_AND_PROBABILITY' = both conditions must be true
var FLOODED_VEG_DETECTION_MODE = 'LABEL_AND_PROBABILITY';

// COUNT-mode thresholds.
var MIN_WATER_OBSERVATIONS = 1;
var MIN_FLOODED_VEG_OBSERVATIONS = 1;

// Dynamic World combined-class handling.
// true  -> a pixel meeting both DW water-component rules becomes class 3.
// false -> assign the component with the larger qualifying-observation count;
//          equal counts are assigned to open water (class 1).
var USE_DW_COMBINED_CLASS_3 = true;

// Temporal aggregation for each DW component.
// Options:
//   'COUNT'     = qualifying observations >= MIN_*_OBSERVATIONS
//   'FREQUENCY' = qualifying observations / total valid observations
//                 >= *_FREQUENCY_THRESHOLD
//
// COUNT remains the default, preserving the previous script behaviour.
var WATER_TEMPORAL_AGGREGATION_MODE = 'COUNT';
var FLOODED_VEG_TEMPORAL_AGGREGATION_MODE = 'COUNT';

// Frequency thresholds in the range [0, 1].
var WATER_FREQUENCY_THRESHOLD = 0.50;
var FLOODED_VEG_FREQUENCY_THRESHOLD = 0.50;

// -------------------------
// Preview settings
// -------------------------
// Only one temporal window is displayed on the map.
var PREVIEW_WINDOW_INDEX = 0;

var SHOW_AOI = false;
var SHOW_FINAL_HARMONIZED_CLASS = true;
var SHOW_FINAL_SOURCE = false;
var SHOW_FINAL_NODATA = true;
var SHOW_PRE_HAND_HARMONIZED_CLASS = false;
var SHOW_HAND_POSTPROCESSING_APPLIED = false;

var SHOW_RECLASSIFIED_BINARY_WATER = false;
var SHOW_RECLASSIFIED_OPEN_WATER = false;
var SHOW_RECLASSIFIED_INUNDATED_PARTIAL = false;

// These names are kept for compatibility with the single-period script;
// in this version they refer to the selected preview window, not necessarily a month.
var SHOW_DW_MONTHLY_MODE_CLASS = true;
var SHOW_DW_MONTHLY_MEAN_ARGMAX_CLASS = false;
var SHOW_DW_MONTHLY_MEAN_PROBABILITIES = false;
var SHOW_DW_COMPONENT_MASKS = false;

var SHOW_DW_TOTAL_OBSERVATION_COUNT = true;
var SHOW_DW_HIT_COUNTS = false;
var SHOW_DW_HIT_FREQUENCIES = false;

var SHOW_HLS_LANDSAT_NATIVE_MODE_CLASS = false;
var SHOW_HLS_LANDSAT_HARMONIZED_CLASS = false;
var SHOW_HLS_SENTINEL2_NATIVE_MODE_CLASS = false;
var SHOW_HLS_SENTINEL2_HARMONIZED_CLASS = false;
var SHOW_S1_NATIVE_MODE_CLASS = false;
var SHOW_S1_HARMONIZED_CLASS = false;

var SHOW_NODATA_AFTER_DW = false;
var SHOW_NODATA_AFTER_HLS_LANDSAT = false;
var SHOW_NODATA_AFTER_HLS = false;

var SHOW_INDIVIDUAL_DW_LABEL_IMAGES = false;
var MAX_INDIVIDUAL_DW_LAYERS = 50;

// -------------------------
// Export settings
// -------------------------
// Used only when RUN_MODE = 'WATER_MASKS'.
// The target ImageCollection asset(s) must already exist in Earth Engine.
var DO_EXPORTS = true;

// Recommended default: keep operational and selected diagnostic bands together
// in one multiband image per temporal window.
// Options:
//   'SINGLE_COLLECTION'
//   'SPLIT_CORE_DIAGNOSTICS'
var EXPORT_LAYOUT = 'SINGLE_COLLECTION';

var OUTPUT_IMAGE_COLLECTION =
  'projects/hardy-tenure-383607/assets/Okavango/SurfaceWater';

// Used only when EXPORT_LAYOUT = 'SPLIT_CORE_DIAGNOSTICS'.
var OUTPUT_DIAGNOSTICS_IMAGE_COLLECTION =
  'projects/hardy-tenure-383607/assets/Okavango/SurfaceWater_Diag';

var ASSET_NAME_PREFIX = 'SWF_v1_5';
var PRODUCT_VERSION =
  'v1_5_dw_hls_landsat_hls_sentinel2_s1_daily_hierarchy_optional_hand';

// Bands exported when using SINGLE_COLLECTION.
// Keep this list fixed for a given ImageCollection so that all images have
// the same schema.
var EXPORT_BANDS = [
  'water_class',
  'remaining_nodata',
  'hand_postprocessing_applied',
  //'water_source',
  //'water_binary',
  //'open_water_reclassified',
  //'inundated_partial_reclassified',
  //'dw_observation_count',
  //'water_class_pre_hand'
];

// Bands exported to the main collection when using SPLIT_CORE_DIAGNOSTICS.
var CORE_EXPORT_BANDS = [
  'water_class',
  'water_source',
  'remaining_nodata',
  'hand_postprocessing_applied',
  'water_binary',
  'open_water_reclassified',
  'inundated_partial_reclassified'
];

// Bands exported to the diagnostics collection when using split layout.
var DIAGNOSTIC_EXPORT_BANDS = [
  'dw_observation_count',
  'dw_water_observation_count',
  'dw_flooded_veg_observation_count',
  'dw_water_hit_frequency_x10000',
  'dw_flooded_veg_hit_frequency_x10000',
  'nodata_after_dw',
  'nodata_after_hls_landsat',
  'nodata_after_hls',
  'water_class_pre_hand'
];

// Batch controls: useful when a long series would generate many tasks.
// END_INDEX = -1 means the last available window.
var EXPORT_WINDOW_START_INDEX = 0;
var EXPORT_WINDOW_END_INDEX = -1;
var MAX_WINDOWS_PER_RUN = 200;

var EXPORT_SCALE = 10;
var EXPORT_CRS = 'EPSG:4326';
var EXPORT_MAX_PIXELS = 1e13;
var EXPORT_TASK_PRIORITY = 100;
var EXPORT_OVERWRITE = false;

// -------------------------
// NoData-evaluation CSV settings
// -------------------------
// Used only when RUN_MODE = 'NODATA_EVALUATION'.
//
// This scale defines the grid on which coverage pixels are counted. It does
// not alter the water-mask calculation or raster-export resolution. A 100 m QA
// grid is used by default to make long AOI-wide time-series coverage evaluation
// practical. The CSV records this scale explicitly.
var NODATA_QA_SCALE = 100;
var NODATA_QA_CRS = EXPORT_CRS;
var NODATA_QA_MAX_PIXELS = 1e13;
var NODATA_QA_TILE_SCALE = 16;

// NoData CSV task organization.
//
// Options:
//   'SINGLE_TASK'  = one CSV task containing the complete selected time series.
//   'YEAR_BATCHES' = several CSV tasks, grouped into consecutive batches whose
//                    length is controlled by NODATA_BATCH_YEARS.
//
// YEAR_BATCHES is recommended for long time series. Each task still creates
// one CSV containing every temporal window assigned to that batch.
//
// NODATA_BATCH_YEARS can be fractional. Internally it is converted to an
// effective number of whole months using:
//   round(NODATA_BATCH_YEARS * 12)
// with a minimum of 1 month.
// Examples:
//   2.0 -> 24 months
//   1.0 -> 12 months
//   0.5 ->  6 months
//   0.3 ->  4 months (rounded from 3.6)
var NODATA_EXPORT_TASK_MODE = 'YEAR_BATCHES';
var NODATA_BATCH_YEARS = 0.4;

var NODATA_CSV_FOLDER = 'EarthEngine';
var NODATA_CSV_BASE_NAME =
  'SWF_v1_5_NoData_QA_' + SERIES_START_DATE.replace(/-/g, '') + '_' +
  SERIES_END_DATE.replace(/-/g, '');

// ============================================================================
// 1) AOI BUILDING
// ============================================================================

var HYDROBASINS_ASSET = null;
var hydrobasins = ee.FeatureCollection([]);
var aoi;

if (AOI_MODE === 'HYDROBASINS') {
  if (
    HYDROBASINS_LEVEL < 1 ||
    HYDROBASINS_LEVEL > 12 ||
    Math.floor(HYDROBASINS_LEVEL) !== HYDROBASINS_LEVEL
  ) {
    throw new Error('HYDROBASINS_LEVEL must be an integer from 1 to 12.');
  }

  HYDROBASINS_ASSET =
    'WWF/HydroSHEDS/v1/Basins/hybas_' + HYDROBASINS_LEVEL;

  hydrobasins = ee.FeatureCollection(HYDROBASINS_ASSET)
    .filter(ee.Filter.eq('HYBAS_ID', HYDROBASINS_ID));

  aoi = hydrobasins.geometry();

  print('AOI mode:', AOI_MODE);
  print('HydroBASINS dataset:', HYDROBASINS_ASSET);
  print('Selected HydroBASINS level:', HYDROBASINS_LEVEL);
  print('Selected HYBAS_ID:', HYDROBASINS_ID);
  print('Number of matching basin features (expected: 1):', hydrobasins.size());

} else if (AOI_MODE === 'DRAWN_GEOMETRY') {
  if (DRAWN_AOI === null) {
    throw new Error(
      'AOI_MODE is DRAWN_GEOMETRY, but DRAWN_AOI is null. ' +
      'Draw/import a polygon and assign it to DRAWN_AOI.'
    );
  }

  aoi = ee.Geometry(DRAWN_AOI);
  print('AOI mode:', AOI_MODE);
  print('Using user-provided drawn/imported geometry as AOI.');

} else {
  throw new Error("AOI_MODE must be 'HYDROBASINS' or 'DRAWN_GEOMETRY'.");
}

// ============================================================================
// 2) PARAMETER VALIDATION
// ============================================================================

var validRunModes = ['WATER_MASKS', 'NODATA_EVALUATION'];
if (validRunModes.indexOf(RUN_MODE) === -1) {
  throw new Error(
    "RUN_MODE must be 'WATER_MASKS' or 'NODATA_EVALUATION'."
  );
}

var validNoDataTaskModes = ['SINGLE_TASK', 'YEAR_BATCHES'];
if (validNoDataTaskModes.indexOf(NODATA_EXPORT_TASK_MODE) === -1) {
  throw new Error(
    "NODATA_EXPORT_TASK_MODE must be 'SINGLE_TASK' or 'YEAR_BATCHES'."
  );
}

if (NODATA_BATCH_YEARS <= 0) {
  throw new Error('NODATA_BATCH_YEARS must be > 0. Fractions are allowed.');
}

var NODATA_BATCH_MONTHS = Math.max(1, Math.round(NODATA_BATCH_YEARS * 12));

var validTimeStepModes = ['MONTHS', 'DAYS'];
if (validTimeStepModes.indexOf(TIME_STEP_MODE) === -1) {
  throw new Error("TIME_STEP_MODE must be 'MONTHS' or 'DAYS'.");
}

if (WINDOW_SIZE_MONTHS < 1 || WINDOW_STEP_MONTHS < 1) {
  throw new Error('WINDOW_SIZE_MONTHS and WINDOW_STEP_MONTHS must be >= 1.');
}

if (WINDOW_SIZE_DAYS < 1 || WINDOW_STEP_DAYS < 1) {
  throw new Error('WINDOW_SIZE_DAYS and WINDOW_STEP_DAYS must be >= 1.');
}

if (MIN_WATER_OBSERVATIONS < 1) {
  throw new Error('MIN_WATER_OBSERVATIONS must be at least 1.');
}

if (MIN_FLOODED_VEG_OBSERVATIONS < 1) {
  throw new Error('MIN_FLOODED_VEG_OBSERVATIONS must be at least 1.');
}

var validTemporalAggregationModes = ['COUNT', 'FREQUENCY'];
if (validTemporalAggregationModes.indexOf(WATER_TEMPORAL_AGGREGATION_MODE) === -1) {
  throw new Error(
    "WATER_TEMPORAL_AGGREGATION_MODE must be 'COUNT' or 'FREQUENCY'."
  );
}

if (validTemporalAggregationModes.indexOf(FLOODED_VEG_TEMPORAL_AGGREGATION_MODE) === -1) {
  throw new Error(
    "FLOODED_VEG_TEMPORAL_AGGREGATION_MODE must be 'COUNT' or 'FREQUENCY'."
  );
}

if (WATER_FREQUENCY_THRESHOLD < 0 || WATER_FREQUENCY_THRESHOLD > 1) {
  throw new Error('WATER_FREQUENCY_THRESHOLD must be between 0 and 1.');
}

if (FLOODED_VEG_FREQUENCY_THRESHOLD < 0 || FLOODED_VEG_FREQUENCY_THRESHOLD > 1) {
  throw new Error('FLOODED_VEG_FREQUENCY_THRESHOLD must be between 0 and 1.');
}

var validFloodedVegModes = [
  'PROBABILITY',
  'LABEL',
  'LABEL_AND_PROBABILITY'
];
if (validFloodedVegModes.indexOf(FLOODED_VEG_DETECTION_MODE) === -1) {
  throw new Error(
    'FLOODED_VEG_DETECTION_MODE must be PROBABILITY, LABEL, or ' +
    'LABEL_AND_PROBABILITY.'
  );
}

var validExportLayouts = ['SINGLE_COLLECTION', 'SPLIT_CORE_DIAGNOSTICS'];
if (validExportLayouts.indexOf(EXPORT_LAYOUT) === -1) {
  throw new Error(
    "EXPORT_LAYOUT must be 'SINGLE_COLLECTION' or 'SPLIT_CORE_DIAGNOSTICS'."
  );
}

// ============================================================================
// 3) CLIENT-SIDE TIME-WINDOW GENERATION
// ============================================================================

function parseIsoDateUtc(isoString) {
  var parts = isoString.split('-').map(Number);
  if (parts.length !== 3) {
    throw new Error('Invalid ISO date: ' + isoString);
  }
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}

function formatIsoDateUtc(date) {
  var year = date.getUTCFullYear();
  var month = String(date.getUTCMonth() + 1).padStart(2, '0');
  var day = String(date.getUTCDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

function compactDate(isoString) {
  return isoString.replace(/-/g, '');
}

function addDaysUtc(date, numberOfDays) {
  return new Date(date.getTime() + numberOfDays * 24 * 60 * 60 * 1000);
}

function addMonthsUtc(date, numberOfMonths) {
  var year = date.getUTCFullYear();
  var month = date.getUTCMonth();
  var day = date.getUTCDate();

  var targetFirst = new Date(Date.UTC(year, month + numberOfMonths, 1));
  var targetYear = targetFirst.getUTCFullYear();
  var targetMonth = targetFirst.getUTCMonth();
  var lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)));
}

function buildTimeWindows() {
  var seriesStart = parseIsoDateUtc(SERIES_START_DATE);
  var seriesEnd = parseIsoDateUtc(SERIES_END_DATE);

  if (!(seriesStart < seriesEnd)) {
    throw new Error('SERIES_START_DATE must be earlier than SERIES_END_DATE.');
  }

  var windows = [];
  var currentStart = new Date(seriesStart.getTime());
  var guard = 0;

  while (currentStart < seriesEnd) {
    guard += 1;
    if (guard > MAX_WINDOWS_TO_BUILD) {
      throw new Error(
        'The requested configuration exceeds MAX_WINDOWS_TO_BUILD=' +
        MAX_WINDOWS_TO_BUILD + '. Increase the limit only if intentional.'
      );
    }

    var requestedEnd;
    var nextStart;

    if (TIME_STEP_MODE === 'MONTHS') {
      requestedEnd = addMonthsUtc(currentStart, WINDOW_SIZE_MONTHS);
      nextStart = addMonthsUtc(currentStart, WINDOW_STEP_MONTHS);
    } else {
      requestedEnd = addDaysUtc(currentStart, WINDOW_SIZE_DAYS);
      nextStart = addDaysUtc(currentStart, WINDOW_STEP_DAYS);
    }

    if (!(nextStart > currentStart)) {
      throw new Error('Window step does not advance the time series.');
    }

    var actualEnd = requestedEnd;
    var isPartial = false;

    if (requestedEnd > seriesEnd) {
      if (!INCLUDE_PARTIAL_FINAL_WINDOW) {
        break;
      }
      actualEnd = new Date(seriesEnd.getTime());
      isPartial = true;
    }

    var startIso = formatIsoDateUtc(currentStart);
    var endIso = formatIsoDateUtc(actualEnd);

    windows.push({
      index: windows.length,
      start: startIso,
      end: endIso,
      tag: compactDate(startIso) + '_' + compactDate(endIso),
      durationDays: Math.round(
        (actualEnd.getTime() - currentStart.getTime()) /
        (24 * 60 * 60 * 1000)
      ),
      partial: isPartial
    });

    nextStart = new Date(nextStart.getTime());
    if (nextStart >= seriesEnd) {
      break;
    }
    currentStart = nextStart;
  }

  return windows;
}

var timeWindows = buildTimeWindows();

if (timeWindows.length === 0) {
  throw new Error('No temporal windows were generated.');
}

// Ensure all client-side window metadata required by exports and CSV rows exists.
timeWindows.forEach(function(windowDef, windowIndex) {
  if (
    windowDef.index === undefined ||
    windowDef.start === undefined ||
    windowDef.end === undefined ||
    windowDef.durationDays === undefined ||
    windowDef.partial === undefined
  ) {
    throw new Error(
      'Temporal window ' + windowIndex +
      ' is missing required metadata and cannot be exported.'
    );
  }
});

if (
  RUN_MODE === 'WATER_MASKS' &&
  (PREVIEW_WINDOW_INDEX < 0 || PREVIEW_WINDOW_INDEX >= timeWindows.length)
) {
  throw new Error(
    'PREVIEW_WINDOW_INDEX is outside the available range 0-' +
    (timeWindows.length - 1) + '.'
  );
}

print('Number of generated temporal windows:', timeWindows.length);
print('Temporal windows:', timeWindows);

// ============================================================================
// 4) OUTPUT CODING AND EXPORTABLE BANDS
// ============================================================================

// water_class:
//   0   = valid non-water / other
//   1   = open water
//   2   = inundated vegetation or partial surface water
//   3   = both open water and inundated vegetation (DW; present only when
//         USE_DW_COMBINED_CLASS_3 is true)
//   255 = unresolved NoData
//
// water_source:
//   1   = Dynamic World
//   2   = OPERA DSWx-HLS Landsat
//   4   = OPERA DSWx-HLS Sentinel-2
//   8   = OPERA DSWx-S1
//   255 = unresolved NoData
// Values are exclusive single-bit provenance codes, not bit combinations.

var ALL_EXPORTABLE_BANDS = [
  'water_class',
  'water_class_pre_hand',
  'water_source',
  'remaining_nodata',
  'hand_postprocessing_applied',
  'water_binary',
  'open_water_reclassified',
  'inundated_partial_reclassified',
  'dw_class',
  'hls_landsat_class',
  'hls_sentinel2_class',
  'class_after_hls_landsat',
  'class_after_hls',
  's1_class',
  'nodata_after_dw',
  'nodata_after_hls_landsat',
  'nodata_after_hls',
  'dw_observation_count',
  'dw_water_observation_count',
  'dw_flooded_veg_observation_count',
  'dw_flooded_veg_probability_count',
  'dw_flooded_veg_label_count',
  'dw_high_confidence_nonwater_count',
  'dw_uncertain_water_count',
  'dw_water_hit_frequency_x10000',
  'dw_flooded_veg_hit_frequency_x10000',
  'dw_window_mode_class',
  'dw_window_mean_argmax_class',
  'hls_landsat_native_mode',
  'hls_sentinel2_native_mode',
  's1_native_mode',
  'dw_mean_water_probability_x10000',
  'dw_mean_flooded_veg_probability_x10000'
];

function validateBandList(list, listName) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(listName + ' must contain at least one band.');
  }

  var seen = {};
  list.forEach(function(bandName) {
    if (ALL_EXPORTABLE_BANDS.indexOf(bandName) === -1) {
      throw new Error(
        'Unknown band in ' + listName + ': ' + bandName +
        '. See ALL_EXPORTABLE_BANDS.'
      );
    }
    if (seen[bandName]) {
      throw new Error('Duplicate band in ' + listName + ': ' + bandName);
    }
    seen[bandName] = true;
  });
}

validateBandList(EXPORT_BANDS, 'EXPORT_BANDS');
validateBandList(CORE_EXPORT_BANDS, 'CORE_EXPORT_BANDS');
validateBandList(DIAGNOSTIC_EXPORT_BANDS, 'DIAGNOSTIC_EXPORT_BANDS');

// ============================================================================
// 5) GENERAL EARTH ENGINE HELPERS
// ============================================================================

var probabilityBands = [
  'water',
  'trees',
  'grass',
  'flooded_vegetation',
  'crops',
  'shrub_and_scrub',
  'built',
  'bare',
  'snow_and_ice'
];

var dwClassPalette = [
  '419bdf', // 0 water
  '397d49', // 1 trees
  '88b053', // 2 grass
  '7a87c6', // 3 flooded vegetation
  'e49635', // 4 crops
  'dfc35a', // 5 shrub and scrub
  'c4281b', // 6 built
  'a59b8f', // 7 bare
  'b39fe1'  // 8 snow and ice
];

var dwClassVis = {
  min: 0,
  max: 8,
  palette: dwClassPalette
};

function emptyMaskedByte(name) {
  return ee.Image.constant(0)
    .rename(name)
    .clip(aoi)
    .updateMask(ee.Image.constant(0))
    .toByte();
}

function emptyMaskedProbabilityImage() {
  return ee.Image.constant([0, 0, 0, 0, 0, 0, 0, 0, 0])
    .rename(probabilityBands)
    .clip(aoi)
    .updateMask(ee.Image.constant(0));
}

function safeCollectionSum(collection, outputName) {
  var result = ee.Image(ee.Algorithms.If(
    collection.size().gt(0),
    collection.sum().rename(outputName),
    ee.Image.constant(0).rename(outputName).clip(aoi)
  ));

  return result
    .unmask(0)
    .rename(outputName)
    .clip(aoi)
    .toUint16();
}

// Reduce a WTR collection to the most frequent valid class per pixel.
function safeModeFromCollection(collection, validMaskFunction, outputName) {
  var validCollection = collection.map(function(image) {
    var wtr = image.select('WTR_Water_classification');
    var valid = validMaskFunction(wtr);

    return wtr
      .updateMask(valid)
      .rename(outputName)
      .copyProperties(image, image.propertyNames());
  });

  return ee.Image(ee.Algorithms.If(
    validCollection.size().gt(0),
    validCollection.reduce(ee.Reducer.mode()).rename(outputName),
    emptyMaskedByte(outputName)
  )).clip(aoi);
}

function validHlsWtr(wtr) {
  return wtr.eq(0).or(wtr.eq(1)).or(wtr.eq(2));
}

function validS1Wtr(wtr) {
  // Only thematic surface classes participate in the temporal mode. Official
  // HAND, layover/shadow, ocean and fill values 250/251/254/255 are excluded.
  return wtr.eq(0).or(wtr.eq(1)).or(wtr.eq(3));
}

// All enabled sources are reduced to one observation per UTC calendar date
// before window counts or temporal modes. This prevents duplicate assets and
// overlapping tiles from inflating temporal evidence.
function addUtcDateKey(image) {
  return image.set(
    'utc_date_key',
    ee.Date(image.get('system:time_start')).format('YYYY-MM-dd')
  );
}

function collapseTypedCollectionPerUtcDate(collection, bandOrder, bandTypes) {
  var keyed = ee.ImageCollection(collection.map(addUtcDateKey));
  var distinctDates = ee.ImageCollection(
    keyed.distinct(['utc_date_key'])
  ).sort('system:time_start');

  var join = ee.Join.saveAll({
    matchesKey: 'same_source_utc_date',
    ordering: 'system:time_start',
    ascending: true
  });

  var joined = join.apply({
    primary: distinctDates,
    secondary: keyed,
    condition: ee.Filter.equals({
      leftField: 'utc_date_key',
      rightField: 'utc_date_key'
    })
  });

  return ee.ImageCollection(joined.map(function(dateElement) {
    var representative = ee.Image(dateElement);
    var candidates = ee.ImageCollection.fromImages(
      ee.List(representative.get('same_source_utc_date'))
    );

    // Inputs are normalized and invalid thematic values are masked before this
    // mosaic. Same-day adjacent tiles therefore form one typed observation;
    // duplicate coverage cannot contribute more than once to a window.
    return candidates.mosaic()
      .select(bandOrder)
      .cast(bandTypes, bandOrder)
      .set({
        utc_date_key: representative.get('utc_date_key'),
        'system:time_start': representative.get('system:time_start')
      });
  })).sort('system:time_start');
}

function collapseDwPerUtcDate(rawCollection) {
  var bandOrder = ['label'].concat(probabilityBands);
  var bandTypes = {
    label: 'uint8',
    water: 'float',
    trees: 'float',
    grass: 'float',
    flooded_vegetation: 'float',
    crops: 'float',
    shrub_and_scrub: 'float',
    built: 'float',
    bare: 'float',
    snow_and_ice: 'float'
  };

  var normalized = rawCollection.map(function(image) {
    return image.select('label').toByte()
      .addBands(image.select(probabilityBands).toFloat())
      .copyProperties(image, ['system:time_start', 'system:index']);
  });

  return collapseTypedCollectionPerUtcDate(normalized, bandOrder, bandTypes);
}

function collapseValidWtrPerUtcDate(rawCollection, validMaskFunction) {
  var normalized = rawCollection.map(function(image) {
    var wtr = image.select('WTR_Water_classification');
    return wtr.updateMask(validMaskFunction(wtr))
      .rename('WTR_Water_classification')
      .toByte()
      .copyProperties(image, ['system:time_start', 'system:index']);
  });

  return collapseTypedCollectionPerUtcDate(
    normalized,
    ['WTR_Water_classification'],
    {WTR_Water_classification: 'uint8'}
  );
}

function collapseWtrFlagPerUtcDate(rawCollection, flagFunction, outputName) {
  var normalized = rawCollection.map(function(image) {
    var wtr = image.select('WTR_Water_classification');
    // Mask zeros so any same-day hit survives the mosaic in overlap areas.
    var flag = flagFunction(wtr).rename(outputName).toByte();
    return flag.updateMask(flag)
      .copyProperties(image, ['system:time_start', 'system:index']);
  });

  return collapseTypedCollectionPerUtcDate(
    normalized,
    [outputName],
    (function() {
      var types = {};
      types[outputName] = 'uint8';
      return types;
    }())
  );
}

// Restrict daily HLS-Sentinel-2 native pixels to same-day official DW gaps.
// The final window hierarchy already gives DW strict priority, but this rule
// keeps native HLS-S2 modes and contribution diagnostics aligned with v6.9.
function applySameDayDwGapOnly(hlsSentinel2Daily, dwDaily) {
  if (!HLS_SENTINEL2_SAME_DAY_DW_GAP_ONLY) {
    return hlsSentinel2Daily;
  }

  var join = ee.Join.saveAll({matchesKey: 'same_day_dw'});
  var joined = join.apply({
    primary: hlsSentinel2Daily,
    secondary: dwDaily,
    condition: ee.Filter.equals({
      leftField: 'utc_date_key',
      rightField: 'utc_date_key'
    })
  });

  return ee.ImageCollection(joined.map(function(element) {
    var hlsImage = ee.Image(element);
    var dwMatches = ee.ImageCollection.fromImages(
      ee.List(hlsImage.get('same_day_dw'))
    );
    var noDw = ee.Image.constant(0).rename('dw_valid').clip(aoi).toByte();
    var dwValid = ee.Image(ee.Algorithms.If(
      dwMatches.size().gt(0),
      dwMatches.select('label').mosaic().mask()
        .reduce(ee.Reducer.min()).gt(0).rename('dw_valid'),
      noDw
    )).unmask(0, false);

    return hlsImage.updateMask(dwValid.not())
      .copyProperties(hlsImage, ['system:time_start', 'utc_date_key']);
  }));
}

// Water-related classes used for contribution diagnostics.
// HLS class 0 is also a valid classification and resolves a DW gap, but is
// counted separately as a non-water resolution.
function hlsWaterRelatedWtr(wtr) {
  return wtr.eq(1).or(wtr.eq(2));
}

function s1WaterRelatedWtr(wtr) {
  return wtr.eq(1).or(wtr.eq(3));
}

// ============================================================================
// 6) BUILD ONE FUSION IMAGE FOR ONE TEMPORAL WINDOW
// ============================================================================

function buildFusionForWindow(windowStartIso, windowEndIso, windowIndex, isPartial) {
  var startDate = ee.Date(windowStartIso);
  var endDate = ee.Date(windowEndIso);

  var noDataByte = ee.Image.constant(255)
    .rename('constant')
    .clip(aoi)
    .toByte();

  // --------------------------------------------------------------------------
  // Dynamic World input
  // --------------------------------------------------------------------------
  var dwRaw = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
    .filterBounds(aoi)
    .filterDate(startDate, endDate);

  var dw = collapseDwPerUtcDate(dwRaw);
  var dwRawAssetCount = dwRaw.size();
  var dwCollectionSize = dw.size();

  var meanProbabilities = ee.Image(ee.Algorithms.If(
    dwCollectionSize.gt(0),
    dw.select(probabilityBands).mean(),
    emptyMaskedProbabilityImage()
  )).select(probabilityBands).clip(aoi);

  // Genuine DW NoData is based on the mask of the official label band.
  var dwObservationCount = ee.Image(ee.Algorithms.If(
    dwCollectionSize.gt(0),
    dw.select('label').count().rename('dw_observation_count'),
    ee.Image.constant(0).rename('dw_observation_count').clip(aoi)
  ))
    .unmask(0)
    .clip(aoi)
    .toUint16();

  var validDw = dwObservationCount.gt(0).rename('valid_dw');
  var noDataAfterDw = dwObservationCount.eq(0)
    .rename('nodata_after_dw')
    .toByte();

  // --------------------------------------------------------------------------
  // Dynamic World open water
  // --------------------------------------------------------------------------
  var waterObservationCount = safeCollectionSum(
    dw.map(function(image) {
      return image.select('water')
        .gt(WATER_THRESHOLD)
        .unmask(0)
        .rename('water_hit');
    }),
    'dw_water_observation_count'
  );

  var highConfidenceNonWaterCount = safeCollectionSum(
    dw.map(function(image) {
      return image.select('water')
        .lte(WATER_LOW_THRESHOLD)
        .unmask(0)
        .rename('high_confidence_nonwater');
    }),
    'dw_high_confidence_nonwater_count'
  );

  var uncertainWaterCount = safeCollectionSum(
    dw.map(function(image) {
      var waterProbability = image.select('water');
      return waterProbability
        .gt(WATER_LOW_THRESHOLD)
        .and(waterProbability.lte(WATER_THRESHOLD))
        .unmask(0)
        .rename('uncertain_water');
    }),
    'dw_uncertain_water_count'
  );

  var safeDwDenominator = dwObservationCount.max(1).toFloat();

  var waterHitFrequency = waterObservationCount
    .toFloat()
    .divide(safeDwDenominator)
    .where(validDw.not(), 0)
    .rename('dw_water_hit_frequency');

  var dwOpenWater;
  if (WATER_TEMPORAL_AGGREGATION_MODE === 'FREQUENCY') {
    dwOpenWater = waterHitFrequency
      .gte(WATER_FREQUENCY_THRESHOLD)
      .and(validDw)
      .rename('dw_open_water');
  } else {
    dwOpenWater = waterObservationCount
      .gte(MIN_WATER_OBSERVATIONS)
      .and(validDw)
      .rename('dw_open_water');
  }

  // --------------------------------------------------------------------------
  // Dynamic World flooded/inundated vegetation
  // --------------------------------------------------------------------------
  var floodedVegProbabilityCount = safeCollectionSum(
    dw.map(function(image) {
      return image.select('flooded_vegetation')
        .gt(FLOODED_VEG_THRESHOLD)
        .unmask(0)
        .rename('flooded_veg_probability_hit');
    }),
    'dw_flooded_veg_probability_count'
  );

  var floodedVegLabelCount = safeCollectionSum(
    dw.map(function(image) {
      return image.select('label')
        .eq(3)
        .unmask(0)
        .rename('flooded_veg_label_hit');
    }),
    'dw_flooded_veg_label_count'
  );

  var floodedVegObservationCount = safeCollectionSum(
    dw.map(function(image) {
      var probabilityHit = image.select('flooded_vegetation')
        .gt(FLOODED_VEG_THRESHOLD);
      var labelHit = image.select('label').eq(3);
      var selectedHit;

      if (FLOODED_VEG_DETECTION_MODE === 'LABEL') {
        selectedHit = labelHit;
      } else if (FLOODED_VEG_DETECTION_MODE === 'LABEL_AND_PROBABILITY') {
        selectedHit = labelHit.and(probabilityHit);
      } else {
        selectedHit = probabilityHit;
      }

      return selectedHit
        .unmask(0)
        .rename('flooded_veg_hit');
    }),
    'dw_flooded_veg_observation_count'
  );

  var floodedVegHitFrequency = floodedVegObservationCount
    .toFloat()
    .divide(safeDwDenominator)
    .where(validDw.not(), 0)
    .rename('dw_flooded_veg_hit_frequency');

  var dwInundatedVegetation;
  if (FLOODED_VEG_TEMPORAL_AGGREGATION_MODE === 'FREQUENCY') {
    dwInundatedVegetation = floodedVegHitFrequency
      .gte(FLOODED_VEG_FREQUENCY_THRESHOLD)
      .and(validDw)
      .rename('dw_inundated_vegetation');
  } else {
    dwInundatedVegetation = floodedVegObservationCount
      .gte(MIN_FLOODED_VEG_OBSERVATIONS)
      .and(validDw)
      .rename('dw_inundated_vegetation');
  }

  // --------------------------------------------------------------------------
  // Dynamic World harmonized class and class diagnostics
  // --------------------------------------------------------------------------
  var dwBothComponents = dwOpenWater.and(dwInundatedVegetation);

  var dwClass = ee.Image.constant(0)
    .where(dwOpenWater.and(dwInundatedVegetation.not()), 1)
    .where(dwInundatedVegetation.and(dwOpenWater.not()), 2);

  if (USE_DW_COMBINED_CLASS_3) {
    // Preserve both qualifying DW components explicitly.
    dwClass = dwClass.where(dwBothComponents, 3);
  } else {
    // Produce mutually exclusive classes 1 and 2. Compare the qualifying
    // observation counts; an equal count is resolved as open water.
    var dwBothAssignedOpenWater = dwBothComponents.and(
      waterObservationCount.gte(floodedVegObservationCount)
    );
    var dwBothAssignedInundatedVegetation = dwBothComponents.and(
      floodedVegObservationCount.gt(waterObservationCount)
    );

    dwClass = dwClass
      .where(dwBothAssignedOpenWater, 1)
      .where(dwBothAssignedInundatedVegetation, 2);
  }

  dwClass = dwClass
    .where(noDataAfterDw.eq(1), 255)
    .rename('dw_class')
    .clip(aoi)
    .toByte();

  var dwWindowModeClass = ee.Image(ee.Algorithms.If(
    dwCollectionSize.gt(0),
    dw.select('label').reduce(ee.Reducer.mode()).rename('dw_window_mode_class'),
    emptyMaskedByte('dw_window_mode_class')
  )).clip(aoi).toByte();

  var dwWindowMeanArgmaxClass = meanProbabilities
    .toArray()
    .arrayArgmax()
    .arrayGet([0])
    .rename('dw_window_mean_argmax_class')
    .clip(aoi)
    .toByte();

  // --------------------------------------------------------------------------
  // OPERA DSWx-HLS — Landsat branch
  // --------------------------------------------------------------------------
  var hlsAllRaw = ee.ImageCollection('OPERA/DSWX/L3_V1/HLS')
    .filterBounds(aoi)
    .filterDate(startDate, endDate);

  // SPACECRAFT_NAME is the operational platform discriminator. SENSOR is not
  // used because HLS Sentinel-2 assets may carry inconsistent SENSOR metadata.
  var hlsLandsatRaw = hlsAllRaw.filter(
    ee.Filter.stringStartsWith('SPACECRAFT_NAME', 'Landsat-')
  );
  var hlsSentinel2Raw = hlsAllRaw.filter(
    ee.Filter.stringStartsWith('SPACECRAFT_NAME', 'Sentinel-2')
  );

  var hlsLandsat = collapseValidWtrPerUtcDate(
    hlsLandsatRaw,
    validHlsWtr
  );

  var hlsLandsatNativeMode = safeModeFromCollection(
    hlsLandsat,
    validHlsWtr,
    'hls_landsat_native_mode'
  ).toByte();

  var hlsLandsatNativeValid = hlsLandsatNativeMode.mask().gt(0)
    .and(validHlsWtr(hlsLandsatNativeMode));

  var hlsLandsatClass = noDataByte
    .where(hlsLandsatNativeValid.and(hlsLandsatNativeMode.eq(0)), 0)
    .where(hlsLandsatNativeValid.and(hlsLandsatNativeMode.eq(1)), 1)
    .where(hlsLandsatNativeValid.and(hlsLandsatNativeMode.eq(2)), 2)
    .rename('hls_landsat_class')
    .clip(aoi)
    .toByte();

  // Any valid HLS-Landsat class resolves a DW gap:
  //   0=not water, 1=open water, 2=partial surface water.
  var hlsLandsatCanFill = noDataAfterDw.eq(1)
    .and(hlsLandsatClass.neq(255))
    .and(ee.Image.constant(USE_HLS_LANDSAT_FILL ? 1 : 0));

  var classAfterHlsLandsat = dwClass
    .where(hlsLandsatCanFill, hlsLandsatClass)
    .rename('class_after_hls_landsat')
    .clip(aoi)
    .toByte();

  var noDataAfterHlsLandsat = classAfterHlsLandsat.eq(255)
    .rename('nodata_after_hls_landsat')
    .toByte();

  // --------------------------------------------------------------------------
  // OPERA DSWx-HLS — Sentinel-2 branch
  // --------------------------------------------------------------------------
  var hlsSentinel2DailyAll = collapseValidWtrPerUtcDate(
    hlsSentinel2Raw,
    validHlsWtr
  );
  var hlsSentinel2 = applySameDayDwGapOnly(
    hlsSentinel2DailyAll,
    dw
  );

  var hlsSentinel2NativeMode = safeModeFromCollection(
    hlsSentinel2,
    validHlsWtr,
    'hls_sentinel2_native_mode'
  ).toByte();

  var hlsSentinel2NativeValid = hlsSentinel2NativeMode.mask().gt(0)
    .and(validHlsWtr(hlsSentinel2NativeMode));

  var hlsSentinel2Class = noDataByte
    .where(hlsSentinel2NativeValid.and(hlsSentinel2NativeMode.eq(0)), 0)
    .where(hlsSentinel2NativeValid.and(hlsSentinel2NativeMode.eq(1)), 1)
    .where(hlsSentinel2NativeValid.and(hlsSentinel2NativeMode.eq(2)), 2)
    .rename('hls_sentinel2_class')
    .clip(aoi)
    .toByte();

  // HLS-Sentinel-2 0/1/2 resolve only gaps remaining after HLS-Landsat.
  // A valid class 0 is a real non-water decision and blocks S1.
  var hlsSentinel2CanFill = noDataAfterHlsLandsat.eq(1)
    .and(hlsSentinel2Class.neq(255))
    .and(ee.Image.constant(USE_HLS_SENTINEL2_FILL ? 1 : 0));

  var classAfterHls = classAfterHlsLandsat
    .where(hlsSentinel2CanFill, hlsSentinel2Class)
    .rename('class_after_hls')
    .clip(aoi)
    .toByte();

  var noDataAfterHls = classAfterHls.eq(255)
    .rename('nodata_after_hls')
    .toByte();

  // --------------------------------------------------------------------------
  // OPERA DSWx-S1
  // --------------------------------------------------------------------------
  var operaS1Raw = ee.ImageCollection('OPERA/DSWX/L3_V1/S1')
    .filterBounds(aoi)
    .filterDate(startDate, endDate);

  var operaS1 = collapseValidWtrPerUtcDate(operaS1Raw, validS1Wtr);

  var s1NativeMode = safeModeFromCollection(
    operaS1,
    validS1Wtr,
    's1_native_mode'
  ).toByte();

  var s1NativeValid = s1NativeMode.mask().gt(0)
    .and(validS1Wtr(s1NativeMode));

  var s1Class = noDataByte
    .where(s1NativeValid.and(s1NativeMode.eq(0)), 0)
    .where(s1NativeValid.and(s1NativeMode.eq(1)), 1)
    .where(s1NativeValid.and(s1NativeMode.eq(3)), 2)
    .rename('s1_class')
    .clip(aoi)
    .toByte();

  // Every valid thematic S1 modal class resolves only the remaining gap:
  // harmonized 0=not water, 1=open water, 2=inundated vegetation. Official
  // mask/fill values 250/251/254/255 are excluded by validS1Wtr and therefore
  // cannot resolve a gap.
  var s1CanFill = noDataAfterHls.eq(1)
    .and(s1Class.neq(255))
    .and(ee.Image.constant(USE_OPERA_S1_FILL ? 1 : 0));

  var waterClassPreHand = classAfterHls
    .where(s1CanFill, s1Class)
    .rename('water_class_pre_hand')
    .clip(aoi)
    .toByte();

  // --------------------------------------------------------------------------
  // Optional post-fusion S1 HAND commission correction
  // --------------------------------------------------------------------------
  // Count at most one S1 HAND or valid-thematic hit per UTC date. HAND class
  // 250 can correct a pre-HAND water-related result only when at least one daily
  // HAND hit is present and no daily valid S1 thematic observation 0/1/3 exists
  // in the window. Other mask/fill values never trigger this correction.
  var s1HandDaily = collapseWtrFlagPerUtcDate(
    operaS1Raw,
    function(wtr) { return wtr.eq(250); },
    's1_hand_masked_observation_count'
  );
  var s1HandMaskedObservationCount = safeCollectionSum(
    s1HandDaily,
    's1_hand_masked_observation_count'
  );

  var s1ValidDaily = collapseWtrFlagPerUtcDate(
    operaS1Raw,
    function(wtr) { return validS1Wtr(wtr); },
    's1_valid_thematic_observation_count'
  );
  var s1ValidThematicObservationCount = safeCollectionSum(
    s1ValidDaily,
    's1_valid_thematic_observation_count'
  );

  var handPostprocessingApplied = waterClassPreHand
    .gte(1)
    .and(waterClassPreHand.lte(3))
    .and(s1HandMaskedObservationCount.gt(0))
    .and(s1ValidThematicObservationCount.eq(0))
    .and(ee.Image.constant(APPLY_S1_HAND_POSTPROCESSING ? 1 : 0))
    .rename('hand_postprocessing_applied')
    .clip(aoi)
    .toByte();

  var waterClass = waterClassPreHand
    .where(handPostprocessingApplied.eq(1), 0)
    .rename('water_class')
    .clip(aoi)
    .toByte();

  // Final unresolved NoData is calculated after every enabled stage.
  var remainingNoData = waterClass.eq(255)
    .rename('remaining_nodata')
    .clip(aoi)
    .toByte();

  // --------------------------------------------------------------------------
  // Source / provenance
  // --------------------------------------------------------------------------
  var waterSource = noDataByte
    .where(dwClass.neq(255), 1)
    .where(hlsLandsatCanFill, 2)
    .where(hlsSentinel2CanFill, 4)
    .where(s1CanFill, 8)
    .where(remainingNoData.eq(1), 255)
    .rename('water_source')
    .clip(aoi)
    .toByte();

  // --------------------------------------------------------------------------
  // Reclassified products
  // --------------------------------------------------------------------------
  var waterBinary = ee.Image.constant(0)
    .where(waterClass.gte(1).and(waterClass.lte(3)), 1)
    .where(waterClass.eq(255), 255)
    .rename('water_binary')
    .clip(aoi)
    .toByte();

  var openWaterReclassified = ee.Image.constant(0)
    .where(waterClass.eq(1).or(waterClass.eq(3)), 1)
    .where(waterClass.eq(255), 255)
    .rename('open_water_reclassified')
    .clip(aoi)
    .toByte();

  var inundatedPartialReclassified = ee.Image.constant(0)
    .where(waterClass.eq(2).or(waterClass.eq(3)), 1)
    .where(waterClass.eq(255), 255)
    .rename('inundated_partial_reclassified')
    .clip(aoi)
    .toByte();

  // --------------------------------------------------------------------------
  // Assemble every selectable output band
  // Frequencies/probabilities are stored as integer values multiplied by 10,000.
  // --------------------------------------------------------------------------
  var output = waterClass
    .addBands(waterClassPreHand)
    .addBands(waterSource)
    .addBands(remainingNoData)
    .addBands(handPostprocessingApplied)
    .addBands(waterBinary)
    .addBands(openWaterReclassified)
    .addBands(inundatedPartialReclassified)
    .addBands(dwClass)
    .addBands(hlsLandsatClass)
    .addBands(hlsSentinel2Class)
    .addBands(classAfterHlsLandsat)
    .addBands(classAfterHls)
    .addBands(s1Class)
    .addBands(noDataAfterDw)
    .addBands(noDataAfterHlsLandsat)
    .addBands(noDataAfterHls)
    .addBands(dwObservationCount)
    .addBands(waterObservationCount)
    .addBands(floodedVegObservationCount)
    .addBands(floodedVegProbabilityCount)
    .addBands(floodedVegLabelCount)
    .addBands(highConfidenceNonWaterCount)
    .addBands(uncertainWaterCount)
    .addBands(
      waterHitFrequency
        .multiply(10000)
        .round()
        .toUint16()
        .rename('dw_water_hit_frequency_x10000')
    )
    .addBands(
      floodedVegHitFrequency
        .multiply(10000)
        .round()
        .toUint16()
        .rename('dw_flooded_veg_hit_frequency_x10000')
    )
    .addBands(dwWindowModeClass)
    .addBands(dwWindowMeanArgmaxClass)
    .addBands(hlsLandsatNativeMode.rename('hls_landsat_native_mode'))
    .addBands(hlsSentinel2NativeMode.rename('hls_sentinel2_native_mode'))
    .addBands(s1NativeMode.rename('s1_native_mode'))
    .addBands(
      meanProbabilities
        .select('water')
        .multiply(10000)
        .round()
        .toUint16()
        .rename('dw_mean_water_probability_x10000')
    )
    .addBands(
      meanProbabilities
        .select('flooded_vegetation')
        .multiply(10000)
        .round()
        .toUint16()
        .rename('dw_mean_flooded_veg_probability_x10000')
    );

  return output.set({
    'system:time_start': startDate.millis(),
    'system:time_end': endDate.millis(),
    window_index: windowIndex,
    window_start: windowStartIso,
    window_end_exclusive: windowEndIso,
    window_is_partial: isPartial ? 1 : 0,
    time_step_mode: TIME_STEP_MODE,
    window_size_months: WINDOW_SIZE_MONTHS,
    window_step_months: WINDOW_STEP_MONTHS,
    window_size_days: WINDOW_SIZE_DAYS,
    window_step_days: WINDOW_STEP_DAYS,
    workflow:
      'DW_then_OPERA_HLS_Landsat_then_OPERA_HLS_Sentinel2_then_OPERA_S1',
    script_version: SCRIPT_VERSION,
    product_version: PRODUCT_VERSION,
    aoi_mode: AOI_MODE,
    hydrobasins_level: AOI_MODE === 'HYDROBASINS' ? HYDROBASINS_LEVEL : -9999,
    hydrobasins_id: AOI_MODE === 'HYDROBASINS' ? HYDROBASINS_ID : -9999,
    use_hls_landsat_fill: USE_HLS_LANDSAT_FILL ? 1 : 0,
    use_hls_sentinel2_fill: USE_HLS_SENTINEL2_FILL ? 1 : 0,
    hls_sentinel2_same_day_dw_gap_only:
      HLS_SENTINEL2_SAME_DAY_DW_GAP_ONLY ? 1 : 0,
    use_opera_s1_fill: USE_OPERA_S1_FILL ? 1 : 0,
    apply_s1_hand_postprocessing:
      APPLY_S1_HAND_POSTPROCESSING ? 1 : 0,
    dw_raw_asset_count: dwRawAssetCount,
    dw_daily_date_count: dwCollectionSize,
    hls_landsat_raw_asset_count: hlsLandsatRaw.size(),
    hls_landsat_daily_date_count: hlsLandsat.size(),
    hls_sentinel2_raw_asset_count: hlsSentinel2Raw.size(),
    hls_sentinel2_daily_date_count: hlsSentinel2DailyAll.size(),
    s1_raw_asset_count: operaS1Raw.size(),
    s1_daily_date_count: operaS1.size(),
    daily_collapse_rule: 'one_typed_mosaic_per_source_per_UTC_date',
    hls_platform_rule:
      'SPACECRAFT_NAME_startsWith_Landsat-_or_Sentinel-2;SENSOR_QA_only',
    dw_water_threshold: WATER_THRESHOLD,
    dw_water_low_threshold: WATER_LOW_THRESHOLD,
    dw_flooded_veg_threshold: FLOODED_VEG_THRESHOLD,
    dw_water_temporal_aggregation_mode: WATER_TEMPORAL_AGGREGATION_MODE,
    dw_water_frequency_threshold: WATER_FREQUENCY_THRESHOLD,
    dw_flooded_veg_detection_mode: FLOODED_VEG_DETECTION_MODE,
    dw_flooded_veg_temporal_aggregation_mode:
      FLOODED_VEG_TEMPORAL_AGGREGATION_MODE,
    dw_flooded_veg_frequency_threshold: FLOODED_VEG_FREQUENCY_THRESHOLD,
    dw_min_water_observations: MIN_WATER_OBSERVATIONS,
    dw_min_flooded_veg_observations: MIN_FLOODED_VEG_OBSERVATIONS,
    use_dw_combined_class_3: USE_DW_COMBINED_CLASS_3 ? 1 : 0,
    dw_both_components_assignment:
      USE_DW_COMBINED_CLASS_3
        ? 'class_3_both_components'
        : 'larger_qualifying_count;ties_open_water_class_1',
    water_class_codes:
      USE_DW_COMBINED_CLASS_3
        ? '0=valid_nonwater_other;1=open_water;' +
          '2=inundated_or_partial;3=both_DW_components;' +
          '255=unresolved_nodata'
        : '0=valid_nonwater_other;1=open_water;' +
          '2=inundated_or_partial;255=unresolved_nodata',
    water_source_codes:
      'exclusive_single_bit:1=Dynamic_World;2=OPERA_HLS_Landsat;' +
      '4=OPERA_HLS_Sentinel2;' +
      '8=OPERA_S1_thematic_decision_including_nonwater;' +
      '255=unresolved_nodata',
    hls_valid_native_wtr_classes:
      'both_platforms:0=valid_nonwater;1=open_water;2=partial_surface_water',
    s1_valid_native_wtr_classes:
      '0=valid_nonwater;1=open_water;3=inundated_vegetation',
    s1_invalid_mask_fill_wtr_classes:
      '250=HAND_masked;251=layover_shadow_masked;' +
      '254=ocean_masked;255=fill_nodata',
    remaining_nodata_definition:
      '1=water_class_255_after_DW_HLS_Landsat_HLS_Sentinel2_S1_and_optional_HAND;0=resolved',
    hand_postprocessing_applied_definition:
      '1=pre_HAND_water_1_2_3_reclassified_to_0_using_S1_WTR_250_' +
      'and_zero_valid_S1_WTR_0_1_3;0=no_HAND_change',
    water_class_pre_hand_definition:
      'hierarchical_DW_HLS_Landsat_HLS_Sentinel2_S1_class_before_optional_HAND_postprocessing'
  });
}

// ============================================================================
// 7) PREVIEW ONE SELECTED WINDOW
// ============================================================================

if (RUN_MODE === 'WATER_MASKS') {
var previewWindow = timeWindows[PREVIEW_WINDOW_INDEX];
var previewImage = buildFusionForWindow(
  previewWindow.start,
  previewWindow.end,
  previewWindow.index,
  previewWindow.partial
);

var previewStartDate = ee.Date(previewWindow.start);
var previewEndDate = ee.Date(previewWindow.end);

var previewDwRaw = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
  .filterBounds(aoi)
  .filterDate(previewStartDate, previewEndDate);
var previewDw = collapseDwPerUtcDate(previewDwRaw);

var previewHlsAll = ee.ImageCollection('OPERA/DSWX/L3_V1/HLS')
  .filterBounds(aoi)
  .filterDate(previewStartDate, previewEndDate);
var previewHlsLandsatRaw = previewHlsAll.filter(
  ee.Filter.stringStartsWith('SPACECRAFT_NAME', 'Landsat-')
);
var previewHlsSentinel2Raw = previewHlsAll.filter(
  ee.Filter.stringStartsWith('SPACECRAFT_NAME', 'Sentinel-2')
);
var previewHlsLandsat = collapseValidWtrPerUtcDate(
  previewHlsLandsatRaw,
  validHlsWtr
);
var previewHlsSentinel2 = collapseValidWtrPerUtcDate(
  previewHlsSentinel2Raw,
  validHlsWtr
);

var previewS1Raw = ee.ImageCollection('OPERA/DSWX/L3_V1/S1')
  .filterBounds(aoi)
  .filterDate(previewStartDate, previewEndDate);
var previewS1 = collapseValidWtrPerUtcDate(previewS1Raw, validS1Wtr);

print('Preview window:', previewWindow);
print('Preview DW raw assets / daily UTC dates:', previewDwRaw.size(), previewDw.size());
print('Preview HLS Landsat raw assets / daily UTC dates:',
  previewHlsLandsatRaw.size(), previewHlsLandsat.size());
print('Preview HLS Sentinel-2 raw assets / daily UTC dates:',
  previewHlsSentinel2Raw.size(), previewHlsSentinel2.size());
print('Preview OPERA S1 raw assets / daily UTC dates:', previewS1Raw.size(), previewS1.size());
print('Preview full multiband image:', previewImage);

Map.centerObject(aoi, 7);
Map.setOptions('SATELLITE');

if (SHOW_AOI) {
  Map.addLayer(aoi, {color: 'ffff00'}, 'AOI', false);
}

if (SHOW_FINAL_HARMONIZED_CLASS) {
  Map.addLayer(
    previewImage.select('water_class').updateMask(
      previewImage.select('water_class').neq(255)
    ),
    {min: 0, max: 3, palette: ['d9d9d9', '0000ff', '66c2a5', '762a83']},
    'FINAL harmonized water class',
    true
  );
}

if (SHOW_PRE_HAND_HARMONIZED_CLASS) {
  Map.addLayer(
    previewImage.select('water_class_pre_hand').updateMask(
      previewImage.select('water_class_pre_hand').neq(255)
    ),
    {min: 0, max: 3, palette: ['d9d9d9', '0000ff', '66c2a5', '762a83']},
    'PRE-HAND hierarchical water class',
    false
  );
}

if (SHOW_HAND_POSTPROCESSING_APPLIED) {
  Map.addLayer(
    previewImage.select('hand_postprocessing_applied').selfMask(),
    {palette: ['ff00ff']},
    'S1 HAND post-processing applied',
    false
  );
}

if (SHOW_FINAL_SOURCE) {
  Map.addLayer(
    previewImage.select('water_source').updateMask(
      previewImage.select('water_source').neq(255)
    ),
    {min: 1, max: 8, palette: [
      '1b9e77', 'd95f02', 'ffffff', '7570b3',
      'ffffff', 'ffffff', 'ffffff', '1f78b4'
    ]},
    'FINAL source / provenance',
    false
  );
}

if (SHOW_FINAL_NODATA) {
  Map.addLayer(
    previewImage.select('remaining_nodata').selfMask(),
    {palette: ['ff0000']},
    'FINAL unresolved NoData',
    false
  );
}

if (SHOW_RECLASSIFIED_BINARY_WATER) {
  var binaryDisplay = previewImage.select('water_binary');
  Map.addLayer(
    binaryDisplay.updateMask(binaryDisplay.neq(255)),
    {min: 0, max: 1, palette: ['ffffff', '0000ff']},
    'Reclassified binary water',
    false
  );
}

if (SHOW_RECLASSIFIED_OPEN_WATER) {
  var openDisplay = previewImage.select('open_water_reclassified');
  Map.addLayer(
    openDisplay.updateMask(openDisplay.neq(255)),
    {min: 0, max: 1, palette: ['ffffff', '0000ff']},
    'Reclassified open water',
    false
  );
}

if (SHOW_RECLASSIFIED_INUNDATED_PARTIAL) {
  var inundatedDisplay = previewImage.select('inundated_partial_reclassified');
  Map.addLayer(
    inundatedDisplay.updateMask(inundatedDisplay.neq(255)),
    {min: 0, max: 1, palette: ['ffffff', '66c2a5']},
    'Reclassified inundated / partial water',
    false
  );
}

if (SHOW_DW_MONTHLY_MODE_CLASS) {
  Map.addLayer(
    previewImage.select('dw_window_mode_class'),
    dwClassVis,
    'DW official label - temporal mode',
    false
  );
}

if (SHOW_DW_MONTHLY_MEAN_ARGMAX_CLASS) {
  Map.addLayer(
    previewImage.select('dw_window_mean_argmax_class'),
    dwClassVis,
    'DW class from argmax of mean probabilities',
    false
  );
}

if (SHOW_DW_MONTHLY_MEAN_PROBABILITIES) {
  Map.addLayer(
    previewImage.select('dw_mean_water_probability_x10000').divide(10000),
    {min: 0, max: 1},
    'DW mean probability - water',
    false
  );

  Map.addLayer(
    previewImage.select('dw_mean_flooded_veg_probability_x10000').divide(10000),
    {min: 0, max: 1},
    'DW mean probability - flooded vegetation',
    false
  );
}

if (SHOW_DW_COMPONENT_MASKS) {
  var previewDwClass = previewImage.select('dw_class');
  var previewDwOpen = previewDwClass.eq(1).or(previewDwClass.eq(3));
  var previewDwInundated = previewDwClass.eq(2).or(previewDwClass.eq(3));

  Map.addLayer(
    previewDwOpen.selfMask(),
    {palette: ['0000ff']},
    'DW open-water component',
    false
  );

  Map.addLayer(
    previewDwInundated.selfMask(),
    {palette: ['66c2a5']},
    'DW inundated-vegetation component',
    false
  );
}

if (SHOW_DW_TOTAL_OBSERVATION_COUNT) {
  var previewDwCount = previewImage.select('dw_observation_count');

  Map.addLayer(
    previewDwCount.updateMask(previewDwCount.gt(0)),
    {
      min: 1,
      max: 10,
      palette: ['f7f7f7', 'd9d9d9', 'bdbdbd', '969696', '737373', '525252', '252525']
    },
    'DW valid observation count (>0)',
    false
  );

  Map.addLayer(
    previewDwCount.eq(0).selfMask(),
    {palette: ['ff0000']},
    'DW valid observation count = 0',
    false
  );
}

if (SHOW_DW_HIT_COUNTS) {
  Map.addLayer(
    previewImage.select('dw_water_observation_count'),
    {min: 0, max: 5},
    'DW water-threshold hit count',
    false
  );

  Map.addLayer(
    previewImage.select('dw_flooded_veg_observation_count'),
    {min: 0, max: 5},
    'DW flooded-vegetation selected-rule hit count',
    false
  );

  Map.addLayer(
    previewImage.select('dw_flooded_veg_probability_count'),
    {min: 0, max: 5},
    'DW flooded-vegetation probability hit count',
    false
  );

  Map.addLayer(
    previewImage.select('dw_flooded_veg_label_count'),
    {min: 0, max: 5},
    'DW official flooded-vegetation label count',
    false
  );
}

if (SHOW_DW_HIT_FREQUENCIES) {
  Map.addLayer(
    previewImage.select('dw_water_hit_frequency_x10000').divide(10000),
    {min: 0, max: 1, palette: ['ffffff', 'd9d9d9', '969696', '525252', '000000']},
    'DW water-hit frequency',
    false
  );

  Map.addLayer(
    previewImage.select('dw_flooded_veg_hit_frequency_x10000').divide(10000),
    {min: 0, max: 1, palette: ['ffffff', 'c7e9c0', '74c476', '238b45', '00441b']},
    'DW flooded-vegetation hit frequency',
    false
  );
}

if (SHOW_HLS_LANDSAT_NATIVE_MODE_CLASS) {
  Map.addLayer(
    previewImage.select('hls_landsat_native_mode'),
    {min: 0, max: 2, palette: ['ffffff', '0000ff', '66c2a5']},
    'OPERA HLS Landsat native WTR mode',
    false
  );
}

if (SHOW_HLS_LANDSAT_HARMONIZED_CLASS) {
  var hlsLandsatDisplay = previewImage.select('hls_landsat_class');
  Map.addLayer(
    hlsLandsatDisplay.updateMask(hlsLandsatDisplay.neq(255)),
    {min: 0, max: 2, palette: ['ffffff', '0000ff', '66c2a5']},
    'OPERA HLS Landsat harmonized class',
    false
  );
}

if (SHOW_HLS_SENTINEL2_NATIVE_MODE_CLASS) {
  Map.addLayer(
    previewImage.select('hls_sentinel2_native_mode'),
    {min: 0, max: 2, palette: ['ffffff', '0000ff', '66c2a5']},
    'OPERA HLS Sentinel-2 native WTR mode (after same-day DW rule)',
    false
  );
}

if (SHOW_HLS_SENTINEL2_HARMONIZED_CLASS) {
  var hlsSentinel2Display = previewImage.select('hls_sentinel2_class');
  Map.addLayer(
    hlsSentinel2Display.updateMask(hlsSentinel2Display.neq(255)),
    {min: 0, max: 2, palette: ['ffffff', '0000ff', '66c2a5']},
    'OPERA HLS Sentinel-2 harmonized class',
    false
  );
}

if (SHOW_S1_NATIVE_MODE_CLASS) {
  var s1Native = previewImage.select('s1_native_mode');
  var s1NativeForDisplay = s1Native
    .remap([0, 1, 3], [0, 1, 2])
    .updateMask(s1Native.mask());

  Map.addLayer(
    s1NativeForDisplay,
    {min: 0, max: 2, palette: ['ffffff', '0000ff', '66c2a5']},
    'OPERA S1 native WTR mode',
    false
  );
}

if (SHOW_S1_HARMONIZED_CLASS) {
  var s1Display = previewImage.select('s1_class');
  Map.addLayer(
    s1Display.updateMask(s1Display.neq(255)),
    {min: 0, max: 2, palette: ['ffffff', '0000ff', '66c2a5']},
    'OPERA S1 harmonized class',
    false
  );
}

if (SHOW_NODATA_AFTER_DW) {
  Map.addLayer(
    previewImage.select('nodata_after_dw').selfMask(),
    {palette: ['ff0000']},
    'NoData after Dynamic World',
    false
  );
}

if (SHOW_NODATA_AFTER_HLS_LANDSAT) {
  Map.addLayer(
    previewImage.select('nodata_after_hls_landsat').selfMask(),
    {palette: ['ffb347']},
    'NoData after DW + HLS Landsat',
    false
  );
}

if (SHOW_NODATA_AFTER_HLS) {
  Map.addLayer(
    previewImage.select('nodata_after_hls').selfMask(),
    {palette: ['ff9900']},
    'NoData after DW + both HLS branches',
    false
  );
}

if (SHOW_INDIVIDUAL_DW_LABEL_IMAGES) {
  previewDw.size().evaluate(function(numberOfImages) {
    var numberToAdd = Math.min(numberOfImages || 0, MAX_INDIVIDUAL_DW_LAYERS);
    if (numberToAdd === 0) return;

    var imageList = previewDw.toList(numberToAdd);
    for (var i = 0; i < numberToAdd; i++) {
      var image = ee.Image(imageList.get(i));
      var dateLabel = ee.Date(image.get('system:time_start')).format('YYYY-MM-dd');
      Map.addLayer(
        image.select('label').clip(aoi),
        dwClassVis,
        'DW individual label ' + i + ' — ' + dateLabel.getInfo(),
        false
      );
    }
  });
}

}

// ============================================================================
// 8) EXPORT HELPERS AND BATCH TASK CREATION
// ============================================================================

// Full-resolution values are not changed by pyramiding policy. The policy only
// controls lower-resolution overview levels. Categorical bands use mode;
// counts, frequencies and mean probabilities use mean.
var MEAN_PYRAMID_BANDS = [
  'dw_observation_count',
  'dw_water_observation_count',
  'dw_flooded_veg_observation_count',
  'dw_flooded_veg_probability_count',
  'dw_flooded_veg_label_count',
  'dw_high_confidence_nonwater_count',
  'dw_uncertain_water_count',
  'dw_water_hit_frequency_x10000',
  'dw_flooded_veg_hit_frequency_x10000',
  'dw_mean_water_probability_x10000',
  'dw_mean_flooded_veg_probability_x10000'
];

function buildPyramidingPolicy(bandList) {
  var policy = {'.default': 'mode'};
  bandList.forEach(function(bandName) {
    if (MEAN_PYRAMID_BANDS.indexOf(bandName) !== -1) {
      policy[bandName] = 'mean';
    }
  });
  return policy;
}

function padNumber(value, width) {
  return String(value).padStart(width, '0');
}

function cleanCollectionPath(path) {
  return path.replace(/\/+$/, '');
}

function queueWindowExport(windowDef, outputCollection, bandList, suffix) {
  var image = buildFusionForWindow(
    windowDef.start,
    windowDef.end,
    windowDef.index,
    windowDef.partial
  ).select(bandList);

  var indexTag = padNumber(windowDef.index, 4);
  var suffixText = suffix ? '__' + suffix : '';
  var assetName =
    ASSET_NAME_PREFIX + '__' + indexTag + '__' + windowDef.tag + suffixText;
  var assetId = cleanCollectionPath(outputCollection) + '/' + assetName;

  Export.image.toAsset({
    image: image,
    description: assetName,
    assetId: assetId,
    region: aoi,
    scale: EXPORT_SCALE,
    crs: EXPORT_CRS,
    pyramidingPolicy: buildPyramidingPolicy(bandList),
    maxPixels: EXPORT_MAX_PIXELS,
    priority: EXPORT_TASK_PRIORITY,
    overwrite: EXPORT_OVERWRITE
  });
}

if (RUN_MODE === 'WATER_MASKS' && DO_EXPORTS) {
  var requestedEndIndex = EXPORT_WINDOW_END_INDEX < 0
    ? timeWindows.length - 1
    : Math.min(EXPORT_WINDOW_END_INDEX, timeWindows.length - 1);

  var requestedStartIndex = Math.max(0, EXPORT_WINDOW_START_INDEX);

  if (requestedStartIndex > requestedEndIndex) {
    throw new Error('Export start index is greater than export end index.');
  }

  var windowsQueued = 0;

  for (var w = requestedStartIndex; w <= requestedEndIndex; w++) {
    if (windowsQueued >= MAX_WINDOWS_PER_RUN) {
      print(
        'Stopped after MAX_WINDOWS_PER_RUN=' + MAX_WINDOWS_PER_RUN +
        '. Increase the limit or run another index batch.'
      );
      break;
    }

    var windowDef = timeWindows[w];

    if (EXPORT_LAYOUT === 'SPLIT_CORE_DIAGNOSTICS') {
      queueWindowExport(
        windowDef,
        OUTPUT_IMAGE_COLLECTION,
        CORE_EXPORT_BANDS,
        'CORE'
      );

      queueWindowExport(
        windowDef,
        OUTPUT_DIAGNOSTICS_IMAGE_COLLECTION,
        DIAGNOSTIC_EXPORT_BANDS,
        'DIAG'
      );
    } else {
      queueWindowExport(
        windowDef,
        OUTPUT_IMAGE_COLLECTION,
        EXPORT_BANDS,
        ''
      );
    }

    windowsQueued += 1;
  }

  print('Number of temporal windows queued for export:', windowsQueued);
  print('Export layout:', EXPORT_LAYOUT);
  print('Main output ImageCollection:', OUTPUT_IMAGE_COLLECTION);

  if (EXPORT_LAYOUT === 'SPLIT_CORE_DIAGNOSTICS') {
    print('Diagnostics ImageCollection:', OUTPUT_DIAGNOSTICS_IMAGE_COLLECTION);
  }
}

// ============================================================================
// 9) NODATA COVERAGE EVALUATION AND CSV TASK CREATION
// ============================================================================
// This mode is intentionally lightweight. It does not build the complete
// multiband fusion product. It calculates unresolved gaps after each stage
// using the same temporal-mode and class rules as WATER_MASKS:
//
//   valid Dynamic World label
//       OR HLS-Landsat temporal-mode class 0/1/2, when enabled
//       OR HLS-Sentinel-2 temporal-mode class 0/1/2, when enabled
//       OR OPERA S1 temporal-mode class 0/1/3, when enabled
//       -> resolved pixel
//
//   none of those source-specific classes available
//       -> remaining NoData
//
// For coverage assessment we keep the intermediate NoData stages:
//   nodata_after_dw
//   nodata_after_hls_landsat
//   nodata_after_hls (after both HLS branches)
//   final_nodata (after S1, or final stage if S1 disabled)
//
// Within each CSV task, all temporal-window NoData masks are stacked into one
// multiband image and reduced in ONE reduceRegion operation. YEAR_BATCHES
// limits the number of windows included in each task while retaining the same
// columns and calculation method in every output CSV.
//
// Each HLS class 0 resolves its preceding gap as valid non-water and blocks
// lower-priority sources. On gaps remaining after both HLS branches, S1
// classes 0/1/3 all resolve the gap. S1 class 0 is
// counted separately as non-water; official mask/fill classes 250/251/254/255
// remain invalid and leave the previous-stage gap unresolved.
// The optional HAND post-processing changes a resolved water-related class to
// resolved class 0 and therefore does not change NoData counts; its enabled
// state is nevertheless recorded in every CSV row.

function safeDictionaryNumber(dictionary, key) {
  dictionary = ee.Dictionary(dictionary);

  return ee.Number(ee.Algorithms.If(
    dictionary.contains(key),
    dictionary.get(key),
    0
  ));
}

function percentageOfTotal(pixelCount, totalPixelCount) {
  return ee.Number(ee.Algorithms.If(
    totalPixelCount.gt(0),
    pixelCount.divide(totalPixelCount).multiply(100),
    0
  ));
}

function paddedWindowIndex(index) {
  return String(index).padStart(4, '0');
}

// AOI mask is created once and reused for every window. The final reduction is
// performed over the AOI bounding box; pixels outside the AOI remain masked.
// This avoids repeatedly using the potentially complex basin polygon as the
// reducer geometry.
var noDataQaAoiMask = ee.Image.constant(1)
  .rename('total_aoi_pixel_count')
  .clip(aoi)
  .toByte();

var noDataQaReductionGeometry = aoi.bounds(1);

// Filter the source collections to the complete requested series only once.
// Each temporal window then applies only a filterDate to these collections.
var noDataQaDwRawSeries = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
  .filterBounds(aoi)
  .filterDate(ee.Date(SERIES_START_DATE), ee.Date(SERIES_END_DATE));
var noDataQaDwDailySeries = collapseDwPerUtcDate(noDataQaDwRawSeries);

var noDataQaHlsAllRawSeries = ee.ImageCollection('OPERA/DSWX/L3_V1/HLS')
  .filterBounds(aoi)
  .filterDate(ee.Date(SERIES_START_DATE), ee.Date(SERIES_END_DATE));

var noDataQaHlsLandsatRawSeries = noDataQaHlsAllRawSeries.filter(
  ee.Filter.stringStartsWith('SPACECRAFT_NAME', 'Landsat-')
);
var noDataQaHlsSentinel2RawSeries = noDataQaHlsAllRawSeries.filter(
  ee.Filter.stringStartsWith('SPACECRAFT_NAME', 'Sentinel-2')
);
var noDataQaHlsLandsatDailySeries = collapseValidWtrPerUtcDate(
  noDataQaHlsLandsatRawSeries,
  validHlsWtr
);
var noDataQaHlsSentinel2DailySeries = applySameDayDwGapOnly(
  collapseValidWtrPerUtcDate(noDataQaHlsSentinel2RawSeries, validHlsWtr),
  noDataQaDwDailySeries
);

var noDataQaS1RawSeries = ee.ImageCollection('OPERA/DSWX/L3_V1/S1')
  .filterBounds(aoi)
  .filterDate(ee.Date(SERIES_START_DATE), ee.Date(SERIES_END_DATE));
var noDataQaS1DailySeries = collapseValidWtrPerUtcDate(
  noDataQaS1RawSeries,
  validS1Wtr
);

function constantInvalidImage(outputName) {
  return ee.Image.constant(0)
    .rename(outputName)
    .toByte();
}

// Valid DW coverage: at least one valid pixel in the official label band.
function buildValidDwForQa(collection) {
  return ee.Image(ee.Algorithms.If(
    collection.size().gt(0),
    collection.select('label').count().gt(0),
    constantInvalidImage('valid_dw')
  ))
    .rename('valid_dw')
    .unmask(0, false)
    .clip(aoi)
    .toByte();
}

// Build resolved and water-related masks from the temporal mode of valid OPERA
// WTR observations. Both sources use the resolved mask for source validity;
// the separate water mask excludes valid class 0 from water-gapfill metrics.
function buildModeFillMasksForQa(
  collection,
  validMaskFunction,
  waterClassFunction,
  outputName,
  unresolvedMask
) {
  var nativeMode = safeModeFromCollection(
    collection,
    validMaskFunction,
    outputName + '_native_mode'
  );

  var eligiblePixel = nativeMode.mask().gt(0)
    .and(unresolvedMask.unmask(0, false));

  var resolved = validMaskFunction(nativeMode)
    .and(eligiblePixel)
    .rename(outputName + '_resolved')
    .unmask(0, false)
    .clip(aoi)
    .toByte();

  var water = waterClassFunction(nativeMode)
    .and(eligiblePixel)
    .rename(outputName + '_water')
    .unmask(0, false)
    .clip(aoi)
    .toByte();

  return {
    resolved: resolved,
    water: water
  };
}

// Return the intermediate and final NoData bands, plus source image counts,
// for one temporal window.
function buildNoDataQaBands(
  windowDef,
  dwRawSeries,
  dwDailySeries,
  hlsLandsatRawSeries,
  hlsLandsatDailySeries,
  hlsSentinel2RawSeries,
  hlsSentinel2DailySeries,
  s1RawSeries,
  s1DailySeries
) {
  var startDate = ee.Date(windowDef.start);
  var endDate = ee.Date(windowDef.end);
  var suffix = paddedWindowIndex(windowDef.index);

  var dwBandName = 'nodata_after_dw_' + suffix;
  var hlsLandsatBandName = 'nodata_after_hls_landsat_' + suffix;
  var hlsAllBandName = 'nodata_after_hls_all_' + suffix;
  var hlsLandsatWaterBandName = 'hls_landsat_water_gapfill_' + suffix;
  var hlsSentinel2WaterBandName = 'hls_sentinel2_water_gapfill_' + suffix;
  var s1WaterBandName = 's1_water_gapfill_' + suffix;
  var finalBandName = 'final_nodata_' + suffix;

  var dwRawWindow = dwRawSeries.filterDate(startDate, endDate);
  var dwDailyWindow = dwDailySeries.filterDate(startDate, endDate);
  var validAfterDw = buildValidDwForQa(dwDailyWindow);

  var noDataAfterDw = validAfterDw
    .not()
    .rename(dwBandName)
    .updateMask(noDataQaAoiMask)
    .toByte();

  var hlsLandsatRawWindow = hlsLandsatRawSeries.filterDate(startDate, endDate);
  var hlsLandsatDailyWindow = hlsLandsatDailySeries.filterDate(startDate, endDate);
  var validAfterHlsLandsat = validAfterDw;
  var hlsLandsatWaterGapfill = constantInvalidImage(hlsLandsatWaterBandName)
    .updateMask(noDataQaAoiMask);

  if (USE_HLS_LANDSAT_FILL) {
    var unresolvedAfterDw = validAfterDw.not().updateMask(noDataQaAoiMask);
    var hlsLandsatFillMasks = buildModeFillMasksForQa(
      hlsLandsatDailyWindow,
      validHlsWtr,
      hlsWaterRelatedWtr,
      'hls_landsat_gapfill',
      unresolvedAfterDw
    );

    validAfterHlsLandsat = validAfterDw.or(hlsLandsatFillMasks.resolved);

    hlsLandsatWaterGapfill = hlsLandsatFillMasks.water
      .rename(hlsLandsatWaterBandName)
      .updateMask(noDataQaAoiMask)
      .toByte();
  }

  var noDataAfterHlsLandsat = validAfterHlsLandsat
    .not()
    .rename(hlsLandsatBandName)
    .updateMask(noDataQaAoiMask)
    .toByte();

  var hlsSentinel2RawWindow = hlsSentinel2RawSeries.filterDate(startDate, endDate);
  var hlsSentinel2DailyWindow = hlsSentinel2DailySeries.filterDate(startDate, endDate);
  var validAfterHlsAll = validAfterHlsLandsat;
  var hlsSentinel2WaterGapfill = constantInvalidImage(
    hlsSentinel2WaterBandName
  ).updateMask(noDataQaAoiMask);

  if (USE_HLS_SENTINEL2_FILL) {
    var unresolvedAfterHlsLandsat = validAfterHlsLandsat.not()
      .updateMask(noDataQaAoiMask);
    var hlsSentinel2FillMasks = buildModeFillMasksForQa(
      hlsSentinel2DailyWindow,
      validHlsWtr,
      hlsWaterRelatedWtr,
      'hls_sentinel2_gapfill',
      unresolvedAfterHlsLandsat
    );

    validAfterHlsAll = validAfterHlsLandsat.or(
      hlsSentinel2FillMasks.resolved
    );
    hlsSentinel2WaterGapfill = hlsSentinel2FillMasks.water
      .rename(hlsSentinel2WaterBandName)
      .updateMask(noDataQaAoiMask)
      .toByte();
  }

  var noDataAfterHlsAll = validAfterHlsAll
    .not()
    .rename(hlsAllBandName)
    .updateMask(noDataQaAoiMask)
    .toByte();

  var s1RawWindow = s1RawSeries.filterDate(startDate, endDate);
  var s1DailyWindow = s1DailySeries.filterDate(startDate, endDate);
  var validFinal = validAfterHlsAll;
  var s1WaterGapfill = constantInvalidImage(s1WaterBandName)
    .updateMask(noDataQaAoiMask);

  if (USE_OPERA_S1_FILL) {
    var unresolvedAfterHls = validAfterHlsAll.not()
      .updateMask(noDataQaAoiMask);
    var s1FillMasks = buildModeFillMasksForQa(
      s1DailyWindow,
      validS1Wtr,
      s1WaterRelatedWtr,
      's1_gapfill',
      unresolvedAfterHls
    );

    // All valid S1 thematic modal classes 0/1/3 resolve a remaining gap.
    // Preserve water classes 1/3 separately from non-water class 0.
    s1WaterGapfill = s1FillMasks.water
      .rename(s1WaterBandName)
      .updateMask(noDataQaAoiMask)
      .toByte();

    validFinal = validAfterHlsAll.or(s1FillMasks.resolved);
  }

  var finalNoData = validFinal
    .not()
    .rename(finalBandName)
    .updateMask(noDataQaAoiMask)
    .toByte();

  return {
    noDataAfterDw: noDataAfterDw,
    noDataAfterHlsLandsat: noDataAfterHlsLandsat,
    noDataAfterHlsAll: noDataAfterHlsAll,
    hlsLandsatWaterGapfill: hlsLandsatWaterGapfill,
    hlsSentinel2WaterGapfill: hlsSentinel2WaterGapfill,
    s1WaterGapfill: s1WaterGapfill,
    finalNoData: finalNoData,
    dwBandName: dwBandName,
    hlsLandsatBandName: hlsLandsatBandName,
    hlsAllBandName: hlsAllBandName,
    hlsLandsatWaterBandName: hlsLandsatWaterBandName,
    hlsSentinel2WaterBandName: hlsSentinel2WaterBandName,
    s1WaterBandName: s1WaterBandName,
    finalBandName: finalBandName,
    dwRawCount: dwRawWindow.size(),
    dwDailyCount: dwDailyWindow.size(),
    hlsLandsatRawCount: hlsLandsatRawWindow.size(),
    hlsLandsatDailyCount: hlsLandsatDailyWindow.size(),
    hlsSentinel2RawCount: hlsSentinel2RawWindow.size(),
    hlsSentinel2DailyCount: hlsSentinel2DailyWindow.size(),
    s1RawCount: s1RawWindow.size(),
    s1DailyCount: s1DailyWindow.size(),
    window: windowDef
  };
}

function buildNoDataCsvSelectors() {
  return [
    'window_index',
    'window_start',
    'window_end_exclusive',
    'window_duration_days',
    'window_is_partial',
    'time_step_mode',
    'window_size_months',
    'window_step_months',
    'window_size_days',
    'window_step_days',
    'batch_index',
    'batch_start',
    'batch_end_exclusive',
    'total_aoi_pixel_count',
    'nodata_after_dw_pixel_count',
    'nodata_after_dw_percentage',
    'nodata_after_hls_landsat_pixel_count',
    'nodata_after_hls_landsat_percentage',
    'nodata_after_hls_pixel_count',
    'nodata_after_hls_percentage',
    'hls_landsat_total_resolved_pixel_count',
    'hls_landsat_total_resolved_percentage_of_aoi',
    'hls_landsat_total_resolved_percentage_of_prior_nodata',
    'hls_landsat_water_gapfill_pixel_count',
    'hls_landsat_water_gapfill_percentage_of_aoi',
    'hls_landsat_water_gapfill_percentage_of_prior_nodata',
    'hls_landsat_nonwater_resolution_pixel_count',
    'hls_landsat_nonwater_resolution_percentage_of_aoi',
    'hls_landsat_nonwater_resolution_percentage_of_prior_nodata',
    'hls_sentinel2_total_resolved_pixel_count',
    'hls_sentinel2_total_resolved_percentage_of_aoi',
    'hls_sentinel2_total_resolved_percentage_of_prior_nodata',
    'hls_sentinel2_water_gapfill_pixel_count',
    'hls_sentinel2_water_gapfill_percentage_of_aoi',
    'hls_sentinel2_water_gapfill_percentage_of_prior_nodata',
    'hls_sentinel2_nonwater_resolution_pixel_count',
    'hls_sentinel2_nonwater_resolution_percentage_of_aoi',
    'hls_sentinel2_nonwater_resolution_percentage_of_prior_nodata',
    'hls_total_resolved_pixel_count',
    'hls_total_resolved_percentage_of_aoi',
    'hls_total_resolved_percentage_of_dw_nodata',
    'hls_water_gapfill_pixel_count',
    'hls_water_gapfill_percentage_of_aoi',
    'hls_water_gapfill_percentage_of_dw_nodata',
    'hls_nonwater_resolution_pixel_count',
    'hls_nonwater_resolution_percentage_of_aoi',
    'hls_nonwater_resolution_percentage_of_dw_nodata',
    's1_total_resolved_pixel_count',
    's1_total_resolved_percentage_of_aoi',
    's1_total_resolved_percentage_of_prior_nodata',
    's1_water_gapfill_pixel_count',
    's1_water_gapfill_percentage_of_aoi',
    's1_water_gapfill_percentage_of_prior_nodata',
    's1_nonwater_resolution_pixel_count',
    's1_nonwater_resolution_percentage_of_aoi',
    's1_nonwater_resolution_percentage_of_prior_nodata',
    'total_opera_water_gapfill_pixel_count',
    'total_opera_water_gapfill_percentage_of_aoi',
    'total_hierarchical_gap_resolved_pixel_count',
    'total_hierarchical_gap_resolved_percentage_of_aoi',
    'final_valid_pixel_count',
    'final_nodata_pixel_count',
    'final_nodata_percentage',
    'dw_raw_asset_count',
    'dw_daily_date_count',
    'hls_landsat_raw_asset_count',
    'hls_landsat_daily_date_count',
    'hls_sentinel2_raw_asset_count',
    'hls_sentinel2_daily_date_count',
    's1_raw_asset_count',
    's1_daily_date_count',
    'pixel_count_scale',
    'pixel_count_crs',
    'aoi_mode',
    'hydrobasins_level',
    'hydrobasins_id',
    'use_dw_combined_class_3',
    'dw_both_components_assignment',
    'use_hls_landsat_fill',
    'use_hls_sentinel2_fill',
    'hls_sentinel2_same_day_dw_gap_only',
    'hls_platform_rule',
    'use_opera_s1_fill',
    'apply_s1_hand_postprocessing',
    'nodata_definition',
    'script_version',
    'product_version'
  ];
}

function buildNoDataTaskBatches() {
  if (NODATA_EXPORT_TASK_MODE === 'SINGLE_TASK') {
    return [{
      index: 0,
      start: SERIES_START_DATE,
      end: SERIES_END_DATE,
      windows: timeWindows.slice()
    }];
  }

  var seriesStart = parseIsoDateUtc(SERIES_START_DATE);
  var seriesEnd = parseIsoDateUtc(SERIES_END_DATE);
  var batches = [];
  var currentBatchStart = new Date(seriesStart.getTime());
  var guard = 0;

  while (currentBatchStart < seriesEnd) {
    guard += 1;
    if (guard > 1000) {
      throw new Error('NoData batch construction exceeded the safety limit.');
    }

    var requestedBatchEnd = addMonthsUtc(
      currentBatchStart,
      NODATA_BATCH_MONTHS
    );

    var actualBatchEnd = requestedBatchEnd < seriesEnd
      ? requestedBatchEnd
      : new Date(seriesEnd.getTime());

    var batchStartIso = formatIsoDateUtc(currentBatchStart);
    var batchEndIso = formatIsoDateUtc(actualBatchEnd);

    // Windows are assigned according to their start date. This preserves each
    // complete processing window, including windows that cross a batch boundary.
    var batchWindows = timeWindows.filter(function(windowDef) {
      var windowStart = parseIsoDateUtc(windowDef.start);
      return windowStart >= currentBatchStart && windowStart < actualBatchEnd;
    });

    if (batchWindows.length > 0) {
      batches.push({
        index: batches.length,
        start: batchStartIso,
        end: batchEndIso,
        windows: batchWindows
      });
    }

    currentBatchStart = new Date(actualBatchEnd.getTime());
  }

  return batches;
}

function queueNoDataCsvBatch(batchDef) {
  var batchWindows = batchDef.windows;
  var firstWindow = batchWindows[0];
  var lastWindow = batchWindows[batchWindows.length - 1];

  // Include the complete final processing window when it extends beyond the
  // nominal batch boundary, as can happen with moving/overlapping windows.
  var sourceStart = firstWindow.start;
  var sourceEnd = lastWindow.end;

  var batchDwRawSeries = noDataQaDwRawSeries.filterDate(
    ee.Date(sourceStart),
    ee.Date(sourceEnd)
  );
  var batchDwDailySeries = noDataQaDwDailySeries.filterDate(
    ee.Date(sourceStart), ee.Date(sourceEnd)
  );
  var batchHlsLandsatRawSeries = noDataQaHlsLandsatRawSeries.filterDate(
    ee.Date(sourceStart),
    ee.Date(sourceEnd)
  );
  var batchHlsLandsatDailySeries = noDataQaHlsLandsatDailySeries.filterDate(
    ee.Date(sourceStart), ee.Date(sourceEnd)
  );
  var batchHlsSentinel2RawSeries = noDataQaHlsSentinel2RawSeries.filterDate(
    ee.Date(sourceStart), ee.Date(sourceEnd)
  );
  var batchHlsSentinel2DailySeries = noDataQaHlsSentinel2DailySeries.filterDate(
    ee.Date(sourceStart), ee.Date(sourceEnd)
  );
  var batchS1RawSeries = noDataQaS1RawSeries.filterDate(
    ee.Date(sourceStart),
    ee.Date(sourceEnd)
  );
  var batchS1DailySeries = noDataQaS1DailySeries.filterDate(
    ee.Date(sourceStart), ee.Date(sourceEnd)
  );

  var batchRecords = [];
  var batchCountImage = noDataQaAoiMask;

  for (var q = 0; q < batchWindows.length; q++) {
    var qaRecord = buildNoDataQaBands(
      batchWindows[q],
      batchDwRawSeries,
      batchDwDailySeries,
      batchHlsLandsatRawSeries,
      batchHlsLandsatDailySeries,
      batchHlsSentinel2RawSeries,
      batchHlsSentinel2DailySeries,
      batchS1RawSeries,
      batchS1DailySeries
    );

    batchRecords.push(qaRecord);
    batchCountImage = batchCountImage
      .addBands(qaRecord.noDataAfterDw)
      .addBands(qaRecord.noDataAfterHlsLandsat)
      .addBands(qaRecord.noDataAfterHlsAll)
      .addBands(qaRecord.hlsLandsatWaterGapfill)
      .addBands(qaRecord.hlsSentinel2WaterGapfill)
      .addBands(qaRecord.s1WaterGapfill)
      .addBands(qaRecord.finalNoData);
  }

  // --------------------------------------------------------------------------
  // Lightweight diagnostic information for this batch.
  // These operations inspect collection metadata only; they do not calculate
  // the AOI-wide NoData reduction.
  // --------------------------------------------------------------------------
  var batchIndexTag = String(batchDef.index).padStart(3, '0');
  var stackedQaBandCount = 1 + (batchWindows.length * 7);

  var batchDiagnosticSummary = ee.Dictionary({
    batch_index: batchDef.index,
    batch_start: batchDef.start,
    batch_end_exclusive: batchDef.end,
    source_filter_start: sourceStart,
    source_filter_end_exclusive: sourceEnd,
    temporal_window_count: batchWindows.length,
    stacked_qa_band_count: stackedQaBandCount,
    dw_raw_assets_in_batch_period: batchDwRawSeries.size(),
    dw_daily_dates_in_batch_period: batchDwDailySeries.size(),
    hls_landsat_raw_assets_in_batch_period: batchHlsLandsatRawSeries.size(),
    hls_landsat_daily_dates_in_batch_period: batchHlsLandsatDailySeries.size(),
    hls_sentinel2_raw_assets_in_batch_period: batchHlsSentinel2RawSeries.size(),
    hls_sentinel2_daily_dates_in_batch_period: batchHlsSentinel2DailySeries.size(),
    s1_raw_assets_in_batch_period: batchS1RawSeries.size(),
    s1_daily_dates_in_batch_period: batchS1DailySeries.size(),
    nodata_qa_scale: NODATA_QA_SCALE,
    nodata_qa_crs: NODATA_QA_CRS,
    nodata_qa_tile_scale: NODATA_QA_TILE_SCALE
  });

  var windowDiagnosticFeatures = [];

  for (var d = 0; d < batchRecords.length; d++) {
    var diagnosticRecord = batchRecords[d];
    var diagnosticWindow = diagnosticRecord.window;

    windowDiagnosticFeatures.push(ee.Feature(null, {
      batch_index: batchDef.index,
      window_index: diagnosticWindow.index,
      window_start: diagnosticWindow.start,
      window_end_exclusive: diagnosticWindow.end,
      window_duration_days: diagnosticWindow.durationDays,
      dw_raw_asset_count: diagnosticRecord.dwRawCount,
      dw_daily_date_count: diagnosticRecord.dwDailyCount,
      hls_landsat_raw_asset_count: diagnosticRecord.hlsLandsatRawCount,
      hls_landsat_daily_date_count: diagnosticRecord.hlsLandsatDailyCount,
      hls_sentinel2_raw_asset_count: diagnosticRecord.hlsSentinel2RawCount,
      hls_sentinel2_daily_date_count: diagnosticRecord.hlsSentinel2DailyCount,
      s1_raw_asset_count: diagnosticRecord.s1RawCount,
      s1_daily_date_count: diagnosticRecord.s1DailyCount
    }));
  }

  var windowDiagnostics = ee.FeatureCollection(windowDiagnosticFeatures);

  // One AOI reduction per batch task, regardless of the number of windows
  // assigned to that batch.
  var batchStats = batchCountImage.reduceRegion({
    reducer: ee.Reducer.sum().unweighted(),
    geometry: noDataQaReductionGeometry,
    scale: NODATA_QA_SCALE,
    crs: NODATA_QA_CRS,
    maxPixels: NODATA_QA_MAX_PIXELS,
    tileScale: NODATA_QA_TILE_SCALE
  });

  var totalPixelCount = safeDictionaryNumber(
    batchStats,
    'total_aoi_pixel_count'
  );

  var batchFeatures = [];

  for (var i = 0; i < batchRecords.length; i++) {
    var record = batchRecords[i];
    var windowDef = record.window;

    var noDataAfterDwPixels = safeDictionaryNumber(
      batchStats,
      record.dwBandName
    );

    var noDataAfterHlsLandsatPixels = safeDictionaryNumber(
      batchStats,
      record.hlsLandsatBandName
    );

    var noDataAfterHlsPixels = safeDictionaryNumber(
      batchStats,
      record.hlsAllBandName
    );

    var finalNoDataPixels = safeDictionaryNumber(
      batchStats,
      record.finalBandName
    );

    var hlsLandsatTotalResolvedPixels = noDataAfterDwPixels
      .subtract(noDataAfterHlsLandsatPixels)
      .max(0);

    var hlsLandsatWaterGapfillPixels = safeDictionaryNumber(
      batchStats,
      record.hlsLandsatWaterBandName
    );

    var hlsLandsatNonWaterResolutionPixels = hlsLandsatTotalResolvedPixels
      .subtract(hlsLandsatWaterGapfillPixels)
      .max(0);

    var hlsSentinel2TotalResolvedPixels = noDataAfterHlsLandsatPixels
      .subtract(noDataAfterHlsPixels)
      .max(0);

    var hlsSentinel2WaterGapfillPixels = safeDictionaryNumber(
      batchStats,
      record.hlsSentinel2WaterBandName
    );

    var hlsSentinel2NonWaterResolutionPixels = hlsSentinel2TotalResolvedPixels
      .subtract(hlsSentinel2WaterGapfillPixels)
      .max(0);

    var hlsTotalResolvedPixels = hlsLandsatTotalResolvedPixels
      .add(hlsSentinel2TotalResolvedPixels);
    var hlsWaterGapfillPixels = hlsLandsatWaterGapfillPixels
      .add(hlsSentinel2WaterGapfillPixels);
    var hlsNonWaterResolutionPixels = hlsLandsatNonWaterResolutionPixels
      .add(hlsSentinel2NonWaterResolutionPixels);

    // Total S1 resolution is the exact reduction from NoData after HLS to
    // final NoData. The separate stacked S1-water band then partitions that
    // total into water classes 1/3 and non-water class 0 without adding a
    // redundant sixth QA band per window.
    var s1TotalResolvedPixels = noDataAfterHlsPixels
      .subtract(finalNoDataPixels)
      .max(0);

    var s1WaterGapfillPixels = safeDictionaryNumber(
      batchStats,
      record.s1WaterBandName
    );

    var s1NonWaterResolutionPixels = s1TotalResolvedPixels
      .subtract(s1WaterGapfillPixels)
      .max(0);

    var totalOperaWaterGapfillPixels = hlsWaterGapfillPixels
      .add(s1WaterGapfillPixels);

    var totalHierarchicalGapResolvedPixels = noDataAfterDwPixels
      .subtract(finalNoDataPixels)
      .max(0);

    var finalValidPixels = totalPixelCount.subtract(finalNoDataPixels);

    batchFeatures.push(ee.Feature(null, {
      window_index: windowDef.index,
      window_start: windowDef.start,
      window_end_exclusive: windowDef.end,
      window_duration_days: windowDef.durationDays,
      window_is_partial: windowDef.partial ? 1 : 0,
      time_step_mode: TIME_STEP_MODE,
      window_size_months: WINDOW_SIZE_MONTHS,
      window_step_months: WINDOW_STEP_MONTHS,
      window_size_days: WINDOW_SIZE_DAYS,
      window_step_days: WINDOW_STEP_DAYS,

      batch_index: batchDef.index,
      batch_start: batchDef.start,
      batch_end_exclusive: batchDef.end,

      total_aoi_pixel_count: totalPixelCount,
      nodata_after_dw_pixel_count: noDataAfterDwPixels,
      nodata_after_dw_percentage: percentageOfTotal(
        noDataAfterDwPixels,
        totalPixelCount
      ),
      nodata_after_hls_landsat_pixel_count: noDataAfterHlsLandsatPixels,
      nodata_after_hls_landsat_percentage: percentageOfTotal(
        noDataAfterHlsLandsatPixels,
        totalPixelCount
      ),
      nodata_after_hls_pixel_count: noDataAfterHlsPixels,
      nodata_after_hls_percentage: percentageOfTotal(
        noDataAfterHlsPixels,
        totalPixelCount
      ),
      hls_total_resolved_pixel_count: hlsTotalResolvedPixels,
      hls_total_resolved_percentage_of_aoi: percentageOfTotal(
        hlsTotalResolvedPixels,
        totalPixelCount
      ),
      hls_total_resolved_percentage_of_dw_nodata: percentageOfTotal(
        hlsTotalResolvedPixels,
        noDataAfterDwPixels
      ),
      hls_water_gapfill_pixel_count: hlsWaterGapfillPixels,
      hls_water_gapfill_percentage_of_aoi: percentageOfTotal(
        hlsWaterGapfillPixels,
        totalPixelCount
      ),
      hls_water_gapfill_percentage_of_dw_nodata: percentageOfTotal(
        hlsWaterGapfillPixels,
        noDataAfterDwPixels
      ),
      hls_nonwater_resolution_pixel_count: hlsNonWaterResolutionPixels,
      hls_nonwater_resolution_percentage_of_aoi: percentageOfTotal(
        hlsNonWaterResolutionPixels,
        totalPixelCount
      ),
      hls_nonwater_resolution_percentage_of_dw_nodata: percentageOfTotal(
        hlsNonWaterResolutionPixels,
        noDataAfterDwPixels
      ),
      hls_landsat_total_resolved_pixel_count: hlsLandsatTotalResolvedPixels,
      hls_landsat_total_resolved_percentage_of_aoi: percentageOfTotal(
        hlsLandsatTotalResolvedPixels, totalPixelCount
      ),
      hls_landsat_total_resolved_percentage_of_prior_nodata: percentageOfTotal(
        hlsLandsatTotalResolvedPixels, noDataAfterDwPixels
      ),
      hls_landsat_water_gapfill_pixel_count: hlsLandsatWaterGapfillPixels,
      hls_landsat_water_gapfill_percentage_of_aoi: percentageOfTotal(
        hlsLandsatWaterGapfillPixels, totalPixelCount
      ),
      hls_landsat_water_gapfill_percentage_of_prior_nodata: percentageOfTotal(
        hlsLandsatWaterGapfillPixels, noDataAfterDwPixels
      ),
      hls_landsat_nonwater_resolution_pixel_count:
        hlsLandsatNonWaterResolutionPixels,
      hls_landsat_nonwater_resolution_percentage_of_aoi: percentageOfTotal(
        hlsLandsatNonWaterResolutionPixels, totalPixelCount
      ),
      hls_landsat_nonwater_resolution_percentage_of_prior_nodata:
        percentageOfTotal(hlsLandsatNonWaterResolutionPixels, noDataAfterDwPixels),
      hls_sentinel2_total_resolved_pixel_count: hlsSentinel2TotalResolvedPixels,
      hls_sentinel2_total_resolved_percentage_of_aoi: percentageOfTotal(
        hlsSentinel2TotalResolvedPixels, totalPixelCount
      ),
      hls_sentinel2_total_resolved_percentage_of_prior_nodata: percentageOfTotal(
        hlsSentinel2TotalResolvedPixels, noDataAfterHlsLandsatPixels
      ),
      hls_sentinel2_water_gapfill_pixel_count: hlsSentinel2WaterGapfillPixels,
      hls_sentinel2_water_gapfill_percentage_of_aoi: percentageOfTotal(
        hlsSentinel2WaterGapfillPixels, totalPixelCount
      ),
      hls_sentinel2_water_gapfill_percentage_of_prior_nodata: percentageOfTotal(
        hlsSentinel2WaterGapfillPixels, noDataAfterHlsLandsatPixels
      ),
      hls_sentinel2_nonwater_resolution_pixel_count:
        hlsSentinel2NonWaterResolutionPixels,
      hls_sentinel2_nonwater_resolution_percentage_of_aoi: percentageOfTotal(
        hlsSentinel2NonWaterResolutionPixels, totalPixelCount
      ),
      hls_sentinel2_nonwater_resolution_percentage_of_prior_nodata:
        percentageOfTotal(
          hlsSentinel2NonWaterResolutionPixels,
          noDataAfterHlsLandsatPixels
        ),
      s1_total_resolved_pixel_count: s1TotalResolvedPixels,
      s1_total_resolved_percentage_of_aoi: percentageOfTotal(
        s1TotalResolvedPixels,
        totalPixelCount
      ),
      s1_total_resolved_percentage_of_prior_nodata: percentageOfTotal(
        s1TotalResolvedPixels,
        noDataAfterHlsPixels
      ),
      s1_water_gapfill_pixel_count: s1WaterGapfillPixels,
      s1_water_gapfill_percentage_of_aoi: percentageOfTotal(
        s1WaterGapfillPixels,
        totalPixelCount
      ),
      s1_water_gapfill_percentage_of_prior_nodata: percentageOfTotal(
        s1WaterGapfillPixels,
        noDataAfterHlsPixels
      ),
      s1_nonwater_resolution_pixel_count: s1NonWaterResolutionPixels,
      s1_nonwater_resolution_percentage_of_aoi: percentageOfTotal(
        s1NonWaterResolutionPixels,
        totalPixelCount
      ),
      s1_nonwater_resolution_percentage_of_prior_nodata: percentageOfTotal(
        s1NonWaterResolutionPixels,
        noDataAfterHlsPixels
      ),
      total_opera_water_gapfill_pixel_count: totalOperaWaterGapfillPixels,
      total_opera_water_gapfill_percentage_of_aoi: percentageOfTotal(
        totalOperaWaterGapfillPixels,
        totalPixelCount
      ),
      total_hierarchical_gap_resolved_pixel_count:
        totalHierarchicalGapResolvedPixels,
      total_hierarchical_gap_resolved_percentage_of_aoi: percentageOfTotal(
        totalHierarchicalGapResolvedPixels,
        totalPixelCount
      ),
      final_valid_pixel_count: finalValidPixels,
      final_nodata_pixel_count: finalNoDataPixels,
      final_nodata_percentage: percentageOfTotal(
        finalNoDataPixels,
        totalPixelCount
      ),

      // These counts remain present for every period. Before OPERA data are
      // available they are zero, while the HLS/final NoData values naturally
      // remain equal to the previous available processing stage.
      dw_raw_asset_count: record.dwRawCount,
      dw_daily_date_count: record.dwDailyCount,
      hls_landsat_raw_asset_count: record.hlsLandsatRawCount,
      hls_landsat_daily_date_count: record.hlsLandsatDailyCount,
      hls_sentinel2_raw_asset_count: record.hlsSentinel2RawCount,
      hls_sentinel2_daily_date_count: record.hlsSentinel2DailyCount,
      s1_raw_asset_count: record.s1RawCount,
      s1_daily_date_count: record.s1DailyCount,

      pixel_count_scale: NODATA_QA_SCALE,
      pixel_count_crs: NODATA_QA_CRS,
      aoi_mode: AOI_MODE,
      hydrobasins_level:
        AOI_MODE === 'HYDROBASINS' ? HYDROBASINS_LEVEL : -9999,
      hydrobasins_id:
        AOI_MODE === 'HYDROBASINS' ? HYDROBASINS_ID : -9999,
      use_dw_combined_class_3: USE_DW_COMBINED_CLASS_3 ? 1 : 0,
      dw_both_components_assignment:
        USE_DW_COMBINED_CLASS_3
          ? 'class_3_both_components'
          : 'larger_qualifying_count;ties_open_water_class_1',
      use_hls_landsat_fill: USE_HLS_LANDSAT_FILL ? 1 : 0,
      use_hls_sentinel2_fill: USE_HLS_SENTINEL2_FILL ? 1 : 0,
      hls_sentinel2_same_day_dw_gap_only:
        HLS_SENTINEL2_SAME_DAY_DW_GAP_ONLY ? 1 : 0,
      hls_platform_rule:
        'SPACECRAFT_NAME_startsWith_Landsat-_or_Sentinel-2;SENSOR_QA_only',
      use_opera_s1_fill: USE_OPERA_S1_FILL ? 1 : 0,
      apply_s1_hand_postprocessing:
        APPLY_S1_HAND_POSTPROCESSING ? 1 : 0,
      nodata_definition:
        'DW_gap_then_HLS_Landsat_0_1_2_then_HLS_Sentinel2_0_1_2_then_S1_0_1_3;' +
        'each_class_0_resolves_nonwater_and_blocks_lower_sources;' +
        'S1_250_251_254_255_do_not_resolve',
      script_version: SCRIPT_VERSION,
      product_version: PRODUCT_VERSION
    }));
  }

  var batchTable = ee.FeatureCollection(batchFeatures);
  var batchStartTag = batchDef.start.replace(/-/g, '');
  var batchEndTag = batchDef.end.replace(/-/g, '');
  var taskName = NODATA_CSV_BASE_NAME +
    '__batch_' + batchIndexTag +
    '__' + batchStartTag + '_' + batchEndTag;

  Export.table.toDrive({
    collection: batchTable,
    description: taskName,
    folder: NODATA_CSV_FOLDER,
    fileNamePrefix: taskName,
    fileFormat: 'CSV',
    selectors: buildNoDataCsvSelectors()
  });

  return {
    batchIndexTag: batchIndexTag,
    batchStart: batchDef.start,
    batchEnd: batchDef.end,
    windowCount: batchWindows.length,
    summary: batchDiagnosticSummary,
    windowDiagnostics: windowDiagnostics,
    taskName: taskName
  };
}

if (RUN_MODE === 'NODATA_EVALUATION') {
  var noDataTaskBatches = buildNoDataTaskBatches();
  var noDataConsoleDiagnostics = [];

  for (var b = 0; b < noDataTaskBatches.length; b++) {
    noDataConsoleDiagnostics.push(
      queueNoDataCsvBatch(noDataTaskBatches[b])
    );
  }

  // --------------------------------------------------------------------------
  // FINAL CONSOLE SECTION — diagnostic prints are intentionally placed here so
  // they appear together at the end of the console output.
  // --------------------------------------------------------------------------
  print('================================================================');
  print('NODATA QA — FINAL DIAGNOSTIC SUMMARY');
  print('================================================================');

  print('RUN CONFIGURATION', ee.Dictionary({
    run_mode: RUN_MODE,
    series_start_date: SERIES_START_DATE,
    series_end_date_exclusive: SERIES_END_DATE,
    selected_window_count: timeWindows.length,
    task_mode: NODATA_EXPORT_TASK_MODE,
    requested_batch_years: NODATA_BATCH_YEARS,
    effective_batch_months: NODATA_BATCH_MONTHS,
    csv_task_count: noDataTaskBatches.length,
    exported_nodata_stages:
      'after_DW;after_HLS_Landsat_valid_0_1_2;' +
      'after_both_HLS_branches;' +
      'final_after_S1_valid_classes_0_1_3',
    opera_gapfill_rule:
      'DW_then_HLS_Landsat_then_HLS_Sentinel2_then_S1;' +
      'S1_only_remaining_gaps_valid_0_1_3;' +
      'S1_water_1_3_reported_separately_from_S1_nonwater_0',
    qa_consistency_equations:
      'LS_total=ND_DW-ND_HLS_Landsat;' +
      'S2_total=ND_HLS_Landsat-ND_HLS_all;' +
      'S1_total=ND_HLS_all-final_ND;' +
      'each_total=water+nonwater',
    script_version: SCRIPT_VERSION,
    product_version: PRODUCT_VERSION,
    use_dw_combined_class_3: USE_DW_COMBINED_CLASS_3 ? 1 : 0,
    dw_both_components_assignment:
      USE_DW_COMBINED_CLASS_3
        ? 'class_3_both_components'
        : 'larger_qualifying_count;ties_open_water_class_1',
    apply_s1_hand_postprocessing:
      APPLY_S1_HAND_POSTPROCESSING ? 1 : 0,
    use_hls_landsat_fill: USE_HLS_LANDSAT_FILL ? 1 : 0,
    use_hls_sentinel2_fill: USE_HLS_SENTINEL2_FILL ? 1 : 0,
    hls_sentinel2_same_day_dw_gap_only:
      HLS_SENTINEL2_SAME_DAY_DW_GAP_ONLY ? 1 : 0,
    hls_platform_rule:
      'SPACECRAFT_NAME startsWith Landsat- or Sentinel-2; SENSOR diagnostic only',
    nodata_qa_scale: NODATA_QA_SCALE,
    nodata_qa_crs: NODATA_QA_CRS,
    nodata_qa_tile_scale: NODATA_QA_TILE_SCALE
  }));

  print(
    'NoData definition: HLS-Landsat then HLS-Sentinel-2 temporal-mode ' +
    'classes 0/1/2 resolve only the preceding stage gaps. HLS class 0 ' +
    'resolves the pixel as non-water and blocks lower-priority sources. ' +
    'S1 is used only on remaining gaps, where valid temporal-mode classes ' +
    '0/1/3 resolve the pixel. S1 class 0 is reported as non-water, while ' +
    'classes 1/3 are reported as water gapfill. S1 mask/fill classes ' +
    '250/251/254/255 leave the gap unresolved.'
  );

  // Keep the previously requested batch-level input image chart together with
  // the final diagnostics. This chart is metadata-only and does not trigger an
  // additional AOI-wide pixel reduction.
  var batchImageCountFeatures = [];

  for (var c = 0; c < noDataConsoleDiagnostics.length; c++) {
    var chartDiagnostic = noDataConsoleDiagnostics[c];
    var chartLabel =
      chartDiagnostic.batchStart + ' to ' + chartDiagnostic.batchEnd;

    batchImageCountFeatures.push(
      ee.Feature(null, chartDiagnostic.summary)
        .set('batch_time_frame', chartLabel)
    );
  }

  var batchImageCountChart = ui.Chart.feature.byFeature(
    ee.FeatureCollection(batchImageCountFeatures),
    'batch_time_frame',
    [
      'dw_raw_assets_in_batch_period',
      'hls_landsat_raw_assets_in_batch_period',
      'hls_sentinel2_raw_assets_in_batch_period',
      's1_raw_assets_in_batch_period'
    ]
  )
    .setChartType('ColumnChart')
    .setSeriesNames([
      'Dynamic World',
      'OPERA HLS Landsat',
      'OPERA HLS Sentinel-2',
      'OPERA DSWx-S1'
    ])
    .setOptions({
      title: 'Input images per NoData batch and dataset',
      hAxis: {
        title: 'Batch time frame',
        slantedText: true,
        slantedTextAngle: 45
      },
      vAxis: {
        title: 'Number of images',
        viewWindow: {min: 0}
      },
      colors: ['#9ecae1', '#31a354', '#756bb1', '#fdd0a2'],
      isStacked: false,
      legend: {position: 'top'},
      bar: {groupWidth: '72%'}
    });

  print('INPUT IMAGE COUNTS BY BATCH', batchImageCountChart);

  for (var d = 0; d < noDataConsoleDiagnostics.length; d++) {
    var diagnostic = noDataConsoleDiagnostics[d];

    print('----------------------------------------------------------------');
    print(
      'BATCH ' + diagnostic.batchIndexTag +
      ' | ' + diagnostic.batchStart +
      ' to ' + diagnostic.batchEnd
    );
    print('Batch summary', diagnostic.summary);
    print('Per-window source image counts', diagnostic.windowDiagnostics);
    print(
      'Queued CSV task: ' + diagnostic.taskName +
      ' | windows: ' + diagnostic.windowCount
    );
  }

  print('================================================================');
  print('END OF NODATA QA DIAGNOSTICS');
  print('================================================================');
}
