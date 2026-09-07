// SCRIPT VERSION: v1.5.0
// ============================================================================
// DYNAMIC WORLD + OPERA FUSION PROCESS INSPECTOR
// Dynamic World -> OPERA DSWx-HLS Landsat -> OPERA DSWx-HLS Sentinel-2
// -> OPERA DSWx-S1
// ============================================================================
//
// PURPOSE
// -------
// This is a visual inspection tool, not a time-series exporter and not a
// statistical diagnostic tool. It builds the fusion once for the AOI and the
// start/end dates entered in the panel, then exposes every relevant stage as a
// separate selectable map layer.
//
// IMPORTANT INTERPRETATION OF 255
// --------------------------------
// Dynamic World does not provide a native class 255. In this tool, 255 is an
// artificial harmonized code meaning that no valid classification is available
// at that stage:
//
//   - DW 255: zero valid DW label observations at that pixel in the period.
//   - HLS 255: no valid selected-period platform-branch mode among 0/1/2.
//   - S1 255: no valid selected-period S1 mode among native classes 0/1/3.
//   - Final 255: DW and both ordered HLS branches did not resolve the gap, and S1 provided
//     no valid selected-period mode among native classes 0/1/3.
//
// CURRENT FUSION HIERARCHY REPRODUCED HERE
// ----------------------------------------
//   1. DW valid pixels are always retained.
//   2. Only DW NoData is passed to Landsat OPERA DSWx-HLS.
//   3. Valid HLS-Landsat native classes 0/1/2 all resolve a DW gap.
//   4. Only remaining NoData is passed to HLS Sentinel-2; its daily pixels are
//      restricted by default to invalid same-day official DW labels.
//   5. Only NoData after both HLS branches is passed to OPERA DSWx-S1.
//   6. Valid S1 native classes 0/1/3 all resolve only the remaining 255 gaps:
//      0=not water, 1=open water, 3=inundated vegetation.
//   7. S1 values 250=HAND mask, 251=layover/shadow mask, 254=ocean mask and
//      255=fill/no data are not thematic classifications and never resolve a
//      gap.
//   8. Anything still unresolved is final class 255.
//
// TEMPORAL RULES
// --------------
// The entire date selection is processed as ONE temporal window. The end date
// is exclusive. For a monthly result, for example, use 2025-01-01 to
// 2025-02-01.
//
//   - DW open water: at least one observation with water probability > 0.50.
//   - DW inundated vegetation: at least one observation where official label
//     is 3 AND flooded_vegetation probability > 0.40.
//   - With USE_DW_COMBINED_CLASS_3=true, pixels meeting both DW rules become
//     class 3. When false, the larger qualifying-observation count determines
//     class 1 or 2; equal counts become open water (class 1).
//   - HLS: separate per-platform temporal modes of valid native classes 0/1/2.
//   - S1: per-pixel temporal mode of valid native classes 0/1/3; all three
//     modal results resolve only a remaining gap.
//   - Every source is collapsed to one typed observation per UTC date before
//     counts or modes; same-day duplicates/tiles cannot inflate evidence.
//
// The layer selector also exposes DW open-water support: qualifying hit count,
// hit frequency relative to valid DW observations, and pixels for which the DW
// open-water component is supported by exactly one qualifying observation.
//
// OPTIONAL HAND POST-PROCESSING
// -----------------------------
// The panel includes an optional final HAND correction, disabled by default.
// When enabled, it runs only AFTER DW -> HLS-Landsat -> HLS-Sentinel-2 -> S1. It
// reclassifies water-related final classes to class 0 only where the selected
// period has at least one S1 WTR 250 HAND-mask observation and zero valid S1
// observations among 0/1/3. A separate flag shows every affected pixel.
// The layer selector also includes the raw selected-period HAND footprint:
// every pixel where at least one OPERA S1 WTR observation equals 250. That
// visual layer is informational and never changes the fused classification.
//
// No exports are created by this script.
// ============================================================================


// ============================================================================
// 1) FIXED WORKFLOW SETTINGS — kept equal to the current production workflow
// ============================================================================

var INSPECTOR_VERSION = 'v1.5.0';

var WATER_THRESHOLD = 0.50;
var FLOODED_VEG_THRESHOLD = 0.40;
var MIN_WATER_OBSERVATIONS = 1;
var MIN_FLOODED_VEG_OBSERVATIONS = 1;

// true  -> retain harmonized DW class 3 when both components qualify.
// false -> use the component with more qualifying observations; ties become
//          open water (class 1). This value initializes the UI checkbox.
var USE_DW_COMBINED_CLASS_3 = true;

// Applied before the HLS-Sentinel-2 temporal mode. Strict window-level DW
// priority already subsumes it in the final class, but native diagnostics are
// aligned with the annual v6.9 application by retaining S2 only on same-day
// official-DW-label gaps.
var HLS_SENTINEL2_SAME_DAY_DW_GAP_ONLY = true;

var HYDROBASINS_ASSET_PREFIX = 'WWF/HydroSHEDS/v1/Basins/hybas_';


// ============================================================================
// 2) VISUALIZATION DEFINITIONS
// ============================================================================

var HARMONIZED_VIS = {
  min: 0,
  max: 4,
  palette: [
    'BDBDBD', // 0 valid non-water
    '1565C0', // 1 open water
    '7B1FA2', // 2 inundated vegetation / partial water
    '00897B', // 3 both (DW only)
    'FF00FF'  // 4 display code for original value 255
  ]
};

var HLS_NATIVE_VIS = {
  min: 0,
  max: 3,
  palette: [
    'BDBDBD', // 0 not water
    '1565C0', // 1 open water
    '7B1FA2', // 2 partial surface water
    'FF00FF'  // 3 display code for original value 255
  ]
};

var S1_NATIVE_VIS = {
  min: 0,
  max: 3,
  palette: [
    'BDBDBD', // 0 not water
    '1565C0', // 1 open water
    '7B1FA2', // 2 display code for native 3 inundated vegetation
    'FF00FF'  // 3 display code for original value 255
  ]
};

var S1_GAP_STATUS_VIS = {
  min: 0,
  max: 8,
  palette: [
    'FF00FF', // 0 no valid S1 mode and no identified special mask
    'BDBDBD', // 1 S1 mode 0: valid non-water fill
    '1565C0', // 2 S1 mode 1: open-water fill
    '7B1FA2', // 3 S1 mode 3: inundated-vegetation fill
    'F9A825', // 4 HAND mask encountered, with no valid S1 class
    'D84315', // 5 layover/shadow encountered, with no valid S1 class
    '6A1B9A', // 6 both special masks encountered, with no valid S1 class
    '212121', // 7 native fill/no data encountered, with no valid S1 class
    '0D47A1'  // 8 ocean mask encountered, with no valid S1 class
  ]
};

var S1_MASK_REASON_VIS = {
  min: 1,
  max: 3,
  palette: [
    'F9A825', // 1 HAND mask and no valid S1 class
    'D84315', // 2 layover/shadow and no valid S1 class
    '6A1B9A'  // 3 both mask types and no valid S1 class
  ]
};

var MASK_OVERLAP_VIS = {
  min: 1,
  max: 1,
  palette: ['FF0000']
};

var HAND_FOOTPRINT_VIS = {
  min: 1,
  max: 1,
  palette: ['F9A825']
};

var DW_WATER_COUNT_VIS = {
  min: 0,
  max: 6,
  palette: [
    'BDBDBD', // 0 qualifying water hits
    'FFF59D',
    'FFB74D',
    'F4511E',
    '8E24AA',
    '283593',
    '00ACC1'  // 6 or more qualifying water hits
  ]
};

var DW_WATER_FREQUENCY_VIS = {
  min: 0,
  max: 100,
  palette: [
    'BDBDBD', // 0%
    'FFF59D',
    'FFB74D',
    'F4511E',
    '8E24AA',
    '1565C0'  // 100%
  ]
};

var DW_SINGLE_HIT_VIS = {
  min: 1,
  max: 1,
  palette: ['FF0000']
};

var NODATA_VIS = {
  min: 1,
  max: 1,
  palette: ['FF00FF']
};

var CONTRIBUTION_VIS = {
  min: 0,
  max: 2,
  palette: [
    'BDBDBD', // 0 valid non-water (HLS only)
    '1565C0', // 1 open water
    '7B1FA2'  // 2 inundated vegetation / partial surface water
  ]
};

var LEGEND_HARMONIZED_WITH_CLASS_3 = [
  ['BDBDBD', '0  Valid non-water / other'],
  ['1565C0', '1  Open water'],
  ['7B1FA2', '2  Inundated vegetation / partial water'],
  ['00897B', '3  Both DW water components detected in the window'],
  ['FF00FF', '255  NoData at this stage']
];

var LEGEND_HARMONIZED_WITHOUT_CLASS_3 = [
  ['BDBDBD', '0  Valid non-water / other'],
  ['1565C0', '1  Open water'],
  ['7B1FA2', '2  Inundated vegetation / partial water'],
  ['FF00FF', '255  NoData at this stage']
];

var LEGEND_NODATA = [
  ['FF00FF', 'NoData (harmonized code 255)']
];

var LEGEND_HLS_NATIVE = [
  ['BDBDBD', '0  Not water'],
  ['1565C0', '1  Open water'],
  ['7B1FA2', '2  Partial surface water'],
  ['FF00FF', '255  No valid HLS mode']
];

var LEGEND_HLS_FILL = [
  ['BDBDBD', '0  Gap resolved as non-water'],
  ['1565C0', '1  Gap filled as open water'],
  ['7B1FA2', '2  Gap filled as partial surface water']
];

var LEGEND_S1_NATIVE = [
  ['BDBDBD', '0  Not water'],
  ['1565C0', '1  Open water'],
  ['7B1FA2', '3  Inundated vegetation'],
  ['FF00FF', '255  No valid S1 mode']
];

var LEGEND_S1_GAP_STATUS = [
  ['FF00FF', 'No valid S1 mode and no identified special mask'],
  ['BDBDBD', 'S1 mode 0: valid non-water fill'],
  ['1565C0', 'S1 mode 1: open-water fill'],
  ['7B1FA2', 'S1 mode 3: inundated-vegetation fill'],
  ['F9A825', 'HAND mask encountered; no valid S1 class'],
  ['D84315', 'Layover/shadow encountered; no valid S1 class'],
  ['6A1B9A', 'Both special masks encountered; no valid S1 class'],
  ['212121', 'Native WTR 255 fill/no data; no valid S1 class'],
  ['0D47A1', 'Ocean mask WTR 254 encountered; no valid S1 class']
];

var LEGEND_S1_FILL = [
  ['BDBDBD', '0  Gap resolved as valid non-water'],
  ['1565C0', '1  Gap filled as open water'],
  ['7B1FA2', '2  Gap filled as inundated vegetation']
];

var LEGEND_S1_MASK_REASON = [
  ['F9A825', 'WTR 250 HAND mask; no valid S1 class in period'],
  ['D84315', 'WTR 251 layover/shadow; no valid S1 class in period'],
  ['6A1B9A', 'Both WTR 250 and 251 occurred; no valid S1 class']
];

var LEGEND_MASK_OVERLAP = [
  ['FF0000', 'Higher-priority DW/both-HLS water that would be removed']
];

var LEGEND_HAND_FOOTPRINT = [
  ['F9A825', 'At least one native OPERA S1 WTR value 250 in the period']
];

var LEGEND_DW_WATER_COUNT = [
  ['BDBDBD', '0 qualifying open-water observations'],
  ['FFF59D', '1 qualifying open-water observation'],
  ['FFB74D', '2 qualifying open-water observations'],
  ['F4511E', '3 qualifying open-water observations'],
  ['8E24AA', '4 qualifying open-water observations'],
  ['283593', '5 qualifying open-water observations'],
  ['00ACC1', '6 or more qualifying open-water observations']
];

var LEGEND_DW_WATER_FREQUENCY = [
  ['BDBDBD', '0% qualifying open-water hits'],
  ['FFF59D', 'Low hit frequency'],
  ['FFB74D', 'Moderate hit frequency'],
  ['F4511E', 'High hit frequency'],
  ['1565C0', '100% qualifying open-water hits']
];

var LEGEND_DW_SINGLE_HIT = [
  ['FF0000', 'DW open-water component supported by exactly one hit']
];


// ============================================================================
// 3) EARTH ENGINE HELPERS
// ============================================================================

function emptyMaskedByte(name, aoi) {
  return ee.Image.constant(0)
    .rename(name)
    .clip(aoi)
    .updateMask(ee.Image.constant(0))
    .toByte();
}

function safeCollectionSum(collection, outputName, aoi) {
  return ee.Image(ee.Algorithms.If(
    collection.size().gt(0),
    collection.sum().rename(outputName),
    ee.Image.constant(0).rename(outputName).clip(aoi)
  ))
    .unmask(0)
    .clip(aoi)
    .toUint16();
}

function validHlsWtr(wtr) {
  return wtr.eq(0).or(wtr.eq(1)).or(wtr.eq(2));
}

function validS1Wtr(wtr) {
  return wtr.eq(0).or(wtr.eq(1)).or(wtr.eq(3));
}

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
  var joined = ee.Join.saveAll({
    matchesKey: 'same_source_utc_date',
    ordering: 'system:time_start',
    ascending: true
  }).apply({
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
  var probabilityBands = [
    'water', 'trees', 'grass', 'flooded_vegetation', 'crops',
    'shrub_and_scrub', 'built', 'bare', 'snow_and_ice'
  ];
  var bandOrder = ['label'].concat(probabilityBands);
  var bandTypes = {
    label: 'uint8', water: 'float', trees: 'float', grass: 'float',
    flooded_vegetation: 'float', crops: 'float', shrub_and_scrub: 'float',
    built: 'float', bare: 'float', snow_and_ice: 'float'
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
    var flag = flagFunction(image.select('WTR_Water_classification'))
      .rename(outputName).toByte();
    return flag.updateMask(flag)
      .copyProperties(image, ['system:time_start', 'system:index']);
  });
  var types = {};
  types[outputName] = 'uint8';
  return collapseTypedCollectionPerUtcDate(normalized, [outputName], types);
}

function applySameDayDwGapOnly(hlsSentinel2Daily, dwDaily, aoi) {
  if (!HLS_SENTINEL2_SAME_DAY_DW_GAP_ONLY) return hlsSentinel2Daily;

  var joined = ee.Join.saveAll({matchesKey: 'same_day_dw'}).apply({
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
    var zero = ee.Image.constant(0).rename('dw_valid').clip(aoi).toByte();
    var dwValid = ee.Image(ee.Algorithms.If(
      dwMatches.size().gt(0),
      dwMatches.select('label').mosaic().mask()
        .reduce(ee.Reducer.min()).gt(0).rename('dw_valid'),
      zero
    )).unmask(0, false);
    return hlsImage.updateMask(dwValid.not())
      .copyProperties(hlsImage, ['system:time_start', 'utc_date_key']);
  }));
}

function safeModeFromCollection(
  collection,
  validMaskFunction,
  outputName,
  aoi
) {
  var validCollection = collection.map(function(image) {
    var wtr = image.select('WTR_Water_classification');
    return wtr
      .updateMask(validMaskFunction(wtr))
      .rename(outputName)
      .copyProperties(image, image.propertyNames());
  });

  return ee.Image(ee.Algorithms.If(
    validCollection.size().gt(0),
    validCollection.reduce(ee.Reducer.mode()).rename(outputName),
    emptyMaskedByte(outputName, aoi)
  )).clip(aoi);
}

// Convert sparse class codes to consecutive display values so palettes are
// discrete and value 255 is not interpolated against the water classes.
function displayHarmonized(image) {
  return image.remap(
    [0, 1, 2, 3, 255],
    [0, 1, 2, 3, 4]
  );
}

function displayHlsNative(image) {
  return image.remap(
    [0, 1, 2, 255],
    [0, 1, 2, 3]
  );
}

function displayS1Native(image) {
  return image.remap(
    [0, 1, 3, 255],
    [0, 1, 2, 3]
  );
}


// ============================================================================
// 4) BUILD ALL INTERMEDIATE PRODUCTS FOR ONE SELECTED PERIOD
// ============================================================================

function buildInspectionProducts(
  aoi,
  startDateText,
  endDateText,
  applyHandPostprocessing,
  useDwCombinedClass3
) {
  var startDate = ee.Date(startDateText);
  var endDate = ee.Date(endDateText);

  var noDataByte = ee.Image.constant(255)
    .rename('constant')
    .clip(aoi)
    .toByte();

  // --------------------------------------------------------------------------
  // STEP 1 — DYNAMIC WORLD
  // --------------------------------------------------------------------------

  var dwRaw = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
    .filterBounds(aoi)
    .filterDate(startDate, endDate);
  var dw = collapseDwPerUtcDate(dwRaw);

  // DW is valid where at least one official label observation is unmasked.
  var dwObservationCount = ee.Image(ee.Algorithms.If(
    dw.size().gt(0),
    dw.select('label').count().rename('dw_observation_count'),
    ee.Image.constant(0).rename('dw_observation_count').clip(aoi)
  ))
    .unmask(0)
    .clip(aoi)
    .toUint16();

  var validDw = dwObservationCount.gt(0);

  var dwWaterObservationCount = safeCollectionSum(
    dw.map(function(image) {
      return image.select('water')
        .gt(WATER_THRESHOLD)
        .unmask(0)
        .rename('dw_water_hit');
    }),
    'dw_water_observation_count',
    aoi
  );

  var dwFloodedVegObservationCount = safeCollectionSum(
    dw.map(function(image) {
      var probabilityHit = image.select('flooded_vegetation')
        .gt(FLOODED_VEG_THRESHOLD);
      var labelHit = image.select('label').eq(3);

      return labelHit.and(probabilityHit)
        .unmask(0)
        .rename('dw_flooded_veg_hit');
    }),
    'dw_flooded_veg_observation_count',
    aoi
  );

  var dwOpenWater = dwWaterObservationCount
    .gte(MIN_WATER_OBSERVATIONS)
    .and(validDw);

  // Percentage of valid DW observations whose water probability exceeds the
  // configured WATER_THRESHOLD. Pixels with zero valid DW observations remain
  // masked because the frequency is undefined there.
  var dwWaterHitFrequencyPct = dwWaterObservationCount
    .divide(dwObservationCount.max(1))
    .multiply(100)
    .updateMask(validDw)
    .rename('dw_water_hit_frequency_pct')
    .toFloat();

  // This is specifically an open-water support flag. It includes final DW
  // classes 1 and 3 because both contain the open-water component, but it does
  // not describe support for flooded vegetation alone.
  var dwWaterSupportedByOneObservation = dwOpenWater
    .and(dwWaterObservationCount.eq(1))
    .rename('dw_water_supported_by_one_observation')
    .toByte();

  var dwInundatedVegetation = dwFloodedVegObservationCount
    .gte(MIN_FLOODED_VEG_OBSERVATIONS)
    .and(validDw);

  var dwBothComponents = dwOpenWater.and(dwInundatedVegetation);

  var dwClass = ee.Image.constant(0)
    .where(dwOpenWater.and(dwInundatedVegetation.not()), 1)
    .where(dwInundatedVegetation.and(dwOpenWater.not()), 2);

  if (useDwCombinedClass3) {
    dwClass = dwClass.where(dwBothComponents, 3);
  } else {
    var dwBothAssignedOpenWater = dwBothComponents.and(
      dwWaterObservationCount.gte(dwFloodedVegObservationCount)
    );
    var dwBothAssignedInundatedVegetation = dwBothComponents.and(
      dwFloodedVegObservationCount.gt(dwWaterObservationCount)
    );

    dwClass = dwClass
      .where(dwBothAssignedOpenWater, 1)
      .where(dwBothAssignedInundatedVegetation, 2);
  }

  dwClass = dwClass
    .where(validDw.not(), 255)
    .rename('dw_class')
    .clip(aoi)
    .toByte();

  var noDataAfterDw = dwClass.eq(255)
    .rename('nodata_after_dw')
    .toByte();

  // --------------------------------------------------------------------------
  // STEP 2 — OPERA DSWx-HLS LANDSAT
  // --------------------------------------------------------------------------

  var hlsAllRaw = ee.ImageCollection('OPERA/DSWX/L3_V1/HLS')
    .filterBounds(aoi)
    .filterDate(startDate, endDate);
  var hlsLandsatRaw = hlsAllRaw.filter(
    ee.Filter.stringStartsWith('SPACECRAFT_NAME', 'Landsat-')
  );
  var hlsSentinel2Raw = hlsAllRaw.filter(
    ee.Filter.stringStartsWith('SPACECRAFT_NAME', 'Sentinel-2')
  );
  var hlsLandsat = collapseValidWtrPerUtcDate(hlsLandsatRaw, validHlsWtr);

  var hlsLandsatNativeMode = safeModeFromCollection(
    hlsLandsat,
    validHlsWtr,
    'hls_landsat_native_mode',
    aoi
  ).toByte();

  var hlsLandsatNativeValid = hlsLandsatNativeMode.mask().gt(0)
    .and(validHlsWtr(hlsLandsatNativeMode));

  // Complete visualization: 255 explicitly marks pixels with no valid HLS mode.
  var hlsLandsatNativeComplete = noDataByte
    .where(hlsLandsatNativeValid, hlsLandsatNativeMode)
    .rename('hls_landsat_native_complete')
    .toByte();

  var hlsLandsatClass = noDataByte
    .where(hlsLandsatNativeValid.and(hlsLandsatNativeMode.eq(0)), 0)
    .where(hlsLandsatNativeValid.and(hlsLandsatNativeMode.eq(1)), 1)
    .where(hlsLandsatNativeValid.and(hlsLandsatNativeMode.eq(2)), 2)
    .rename('hls_landsat_class')
    .toByte();

  var hlsLandsatCanFill = noDataAfterDw.eq(1)
    .and(hlsLandsatClass.neq(255));

  var hlsLandsatContribution = hlsLandsatClass
    .updateMask(hlsLandsatCanFill)
    .rename('hls_landsat_contribution');

  var classAfterHlsLandsat = dwClass
    .where(hlsLandsatCanFill, hlsLandsatClass)
    .rename('class_after_hls_landsat')
    .toByte();

  var noDataAfterHlsLandsat = classAfterHlsLandsat.eq(255)
    .rename('nodata_after_hls_landsat')
    .toByte();

  // --------------------------------------------------------------------------
  // STEP 3 — OPERA DSWx-HLS SENTINEL-2
  // --------------------------------------------------------------------------
  var hlsSentinel2DailyAll = collapseValidWtrPerUtcDate(
    hlsSentinel2Raw,
    validHlsWtr
  );
  var hlsSentinel2 = applySameDayDwGapOnly(
    hlsSentinel2DailyAll,
    dw,
    aoi
  );
  var hlsSentinel2NativeMode = safeModeFromCollection(
    hlsSentinel2,
    validHlsWtr,
    'hls_sentinel2_native_mode',
    aoi
  ).toByte();
  var hlsSentinel2NativeValid = hlsSentinel2NativeMode.mask().gt(0)
    .and(validHlsWtr(hlsSentinel2NativeMode));
  var hlsSentinel2NativeComplete = noDataByte
    .where(hlsSentinel2NativeValid, hlsSentinel2NativeMode)
    .rename('hls_sentinel2_native_complete')
    .toByte();
  var hlsSentinel2Class = noDataByte
    .where(hlsSentinel2NativeValid.and(hlsSentinel2NativeMode.eq(0)), 0)
    .where(hlsSentinel2NativeValid.and(hlsSentinel2NativeMode.eq(1)), 1)
    .where(hlsSentinel2NativeValid.and(hlsSentinel2NativeMode.eq(2)), 2)
    .rename('hls_sentinel2_class')
    .toByte();
  var hlsSentinel2CanFill = noDataAfterHlsLandsat.eq(1)
    .and(hlsSentinel2Class.neq(255));
  var hlsSentinel2Contribution = hlsSentinel2Class
    .updateMask(hlsSentinel2CanFill)
    .rename('hls_sentinel2_contribution');
  var classAfterHls = classAfterHlsLandsat
    .where(hlsSentinel2CanFill, hlsSentinel2Class)
    .rename('class_after_hls')
    .toByte();
  var noDataAfterHls = classAfterHls.eq(255)
    .rename('nodata_after_hls')
    .toByte();

  // --------------------------------------------------------------------------
  // STEP 4 — OPERA DSWx-S1
  // --------------------------------------------------------------------------

  var s1Raw = ee.ImageCollection('OPERA/DSWX/L3_V1/S1')
    .filterBounds(aoi)
    .filterDate(startDate, endDate);
  var s1 = collapseValidWtrPerUtcDate(s1Raw, validS1Wtr);

  // Count native WTR outcomes separately. Only 0/1/3 are valid thematic
  // classifications. Values 250/251/254/255 are mask/no-data outcomes.
  var s1ValidObservationCount = safeCollectionSum(
    s1.map(function(image) {
      var wtr = image.select('WTR_Water_classification');
      return validS1Wtr(wtr)
        .unmask(0)
        .rename('s1_valid_observation');
    }),
    's1_valid_observation_count',
    aoi
  );

  var s1HandMaskCount = safeCollectionSum(
    collapseWtrFlagPerUtcDate(
      s1Raw,
      function(wtr) { return wtr.eq(250); },
      's1_hand_mask_hit'
    ),
    's1_hand_mask_count',
    aoi
  );

  var s1LayoverShadowCount = safeCollectionSum(
    collapseWtrFlagPerUtcDate(
      s1Raw,
      function(wtr) { return wtr.eq(251); },
      's1_layover_shadow_hit'
    ),
    's1_layover_shadow_count',
    aoi
  );

  var s1NativeFillCount = safeCollectionSum(
    collapseWtrFlagPerUtcDate(
      s1Raw,
      function(wtr) { return wtr.eq(255); },
      's1_native_fill_hit'
    ),
    's1_native_fill_count',
    aoi
  );

  var s1OceanMaskCount = safeCollectionSum(
    collapseWtrFlagPerUtcDate(
      s1Raw,
      function(wtr) { return wtr.eq(254); },
      's1_ocean_mask_hit'
    ),
    's1_ocean_mask_count',
    aoi
  );

  // Raw selected-period HAND footprint. This is the union of all pixels where
  // at least one OPERA S1 observation has native WTR value 250. It is broader
  // than handWithoutValidS1 because another observation in the same period may
  // still provide a valid thematic S1 class 0/1/3 at that pixel.
  var s1HandMaskAny = s1HandMaskCount.gt(0)
    .rename('s1_hand_mask_any')
    .toByte();

  var s1NativeMode = safeModeFromCollection(
    s1,
    validS1Wtr,
    's1_native_mode',
    aoi
  ).toByte();

  var s1NativeValid = s1NativeMode.mask().gt(0)
    .and(validS1Wtr(s1NativeMode));

  // Complete visualization: 255 explicitly marks pixels with no valid S1 mode.
  var s1NativeComplete = noDataByte
    .where(s1NativeValid, s1NativeMode)
    .rename('s1_native_complete')
    .toByte();

  var s1Class = noDataByte
    .where(s1NativeValid.and(s1NativeMode.eq(0)), 0)
    .where(s1NativeValid.and(s1NativeMode.eq(1)), 1)
    .where(s1NativeValid.and(s1NativeMode.eq(3)), 2)
    .rename('s1_class')
    .toByte();

  var noValidS1Observation = s1ValidObservationCount.eq(0);
  var handWithoutValidS1 = noValidS1Observation
    .and(s1HandMaskCount.gt(0));
  var layoverWithoutValidS1 = noValidS1Observation
    .and(s1LayoverShadowCount.gt(0));
  var oceanWithoutValidS1 = noValidS1Observation
    .and(s1OceanMaskCount.gt(0));
  var fillOnlyWithoutValidS1 = noValidS1Observation
    .and(s1NativeFillCount.gt(0))
    .and(s1HandMaskCount.eq(0))
    .and(s1LayoverShadowCount.eq(0))
    .and(s1OceanMaskCount.eq(0));

  // Explain pixels where the period contains no valid S1 0/1/3 observation
  // but does contain official WTR mask values. The masks remain invalid; they
  // are not converted to non-water and do not erase DW/either-HLS classifications.
  var s1SpecialMaskReason = ee.Image.constant(0)
    .where(handWithoutValidS1.and(layoverWithoutValidS1.not()), 1)
    .where(layoverWithoutValidS1.and(handWithoutValidS1.not()), 2)
    .where(handWithoutValidS1.and(layoverWithoutValidS1), 3)
    .updateMask(handWithoutValidS1.or(layoverWithoutValidS1))
    .rename('s1_special_mask_reason')
    .toByte();

  // This layer explains what S1 sees specifically over gaps remaining after HLS:
  //   0 = no valid S1 mode and no identified special mask
  //   1 = S1 mode 0 (valid non-water fill)
  //   2 = S1 mode 1 (open-water fill)
  //   3 = S1 mode 3 (inundated-vegetation fill)
  //   4 = HAND mask encountered and no valid S1 class
  //   5 = layover/shadow encountered and no valid S1 class
  //   6 = both special masks encountered and no valid S1 class
  //   7 = native WTR 255 fill/no data and no valid S1 class
  //   8 = ocean mask WTR 254 encountered and no valid S1 class
  var s1GapStatus = ee.Image.constant(0)
    .where(fillOnlyWithoutValidS1, 7)
    .where(oceanWithoutValidS1, 8)
    .where(handWithoutValidS1, 4)
    .where(layoverWithoutValidS1, 5)
    .where(handWithoutValidS1.and(layoverWithoutValidS1), 6)
    .where(s1NativeValid.and(s1NativeMode.eq(0)), 1)
    .where(s1NativeValid.and(s1NativeMode.eq(1)), 2)
    .where(s1NativeValid.and(s1NativeMode.eq(3)), 3)
    .updateMask(noDataAfterHls.eq(1))
    .rename('s1_status_on_remaining_gaps')
    .toByte();

  // All valid S1 thematic classes 0/1/3 resolve ONLY gaps still equal to 255.
  // This preserves every valid DW and HLS pixel and the hierarchy remains:
  // DW -> HLS-Landsat -> HLS-Sentinel-2 -> S1.
  var s1CanFill = noDataAfterHls.eq(1)
    .and(s1Class.neq(255));

  var s1Contribution = s1Class
    .updateMask(s1CanFill)
    .rename('s1_contribution');

  var preHandFinalClass = classAfterHls
    .where(s1CanFill, s1Class)
    .rename('pre_hand_final_water_class')
    .toByte();

  // Optional final commission correction. It is deliberately separated from
  // source fusion, disabled by default in the UI, and can never change a pixel
  // during DW/HLS-Landsat/HLS-Sentinel-2/S1 gap filling.
  var handPostprocessingCandidate = preHandFinalClass.gte(1)
    .and(preHandFinalClass.lte(3))
    .and(handWithoutValidS1)
    .rename('hand_postprocessing_candidate')
    .toByte();

  var handPostprocessingApplied = handPostprocessingCandidate
    .and(ee.Image.constant(applyHandPostprocessing ? 1 : 0))
    .rename('hand_postprocessing_applied')
    .toByte();

  var finalClass = preHandFinalClass
    .where(handPostprocessingApplied.eq(1), 0)
    .rename('final_water_class')
    .toByte();

  var finalNoData = finalClass.eq(255)
    .rename('final_unresolved_nodata')
    .toByte();

  // Hypothetical diagnostic only: show higher-priority DW/either-HLS water that
  // would be removed if OPERA S1 special masks were applied backwards. These
  // layers DO NOT alter finalClass.
  var higherPriorityWater = classAfterHls.gte(1)
    .and(classAfterHls.lte(3));

  var handOverlapHigherPriorityWater = higherPriorityWater
    .and(handWithoutValidS1)
    .rename('hand_overlap_higher_priority_water')
    .toByte();

  var layoverOverlapHigherPriorityWater = higherPriorityWater
    .and(layoverWithoutValidS1)
    .rename('layover_overlap_higher_priority_water')
    .toByte();

  return {
    dwRawCollection: dwRaw,
    dwCollection: dw,
    hlsLandsatRawCollection: hlsLandsatRaw,
    hlsLandsatCollection: hlsLandsat,
    hlsSentinel2RawCollection: hlsSentinel2Raw,
    hlsSentinel2Collection: hlsSentinel2DailyAll,
    hlsSentinel2EligibleCollection: hlsSentinel2,
    s1RawCollection: s1Raw,
    s1Collection: s1,
    dwClass: dwClass,
    dwObservationCount: dwObservationCount,
    dwWaterObservationCount: dwWaterObservationCount,
    dwWaterHitFrequencyPct: dwWaterHitFrequencyPct,
    dwWaterSupportedByOneObservation: dwWaterSupportedByOneObservation,
    noDataAfterDw: noDataAfterDw,
    hlsLandsatNativeComplete: hlsLandsatNativeComplete,
    hlsLandsatContribution: hlsLandsatContribution,
    classAfterHlsLandsat: classAfterHlsLandsat,
    noDataAfterHlsLandsat: noDataAfterHlsLandsat,
    hlsSentinel2NativeComplete: hlsSentinel2NativeComplete,
    hlsSentinel2Contribution: hlsSentinel2Contribution,
    classAfterHls: classAfterHls,
    noDataAfterHls: noDataAfterHls,
    s1NativeComplete: s1NativeComplete,
    s1GapStatus: s1GapStatus,
    s1SpecialMaskReason: s1SpecialMaskReason,
    s1ValidObservationCount: s1ValidObservationCount,
    s1HandMaskCount: s1HandMaskCount,
    s1HandMaskAny: s1HandMaskAny,
    s1LayoverShadowCount: s1LayoverShadowCount,
    s1OceanMaskCount: s1OceanMaskCount,
    s1NativeFillCount: s1NativeFillCount,
    handWithoutValidS1: handWithoutValidS1,
    layoverWithoutValidS1: layoverWithoutValidS1,
    handOverlapHigherPriorityWater: handOverlapHigherPriorityWater,
    layoverOverlapHigherPriorityWater: layoverOverlapHigherPriorityWater,
    higherPriorityWater: higherPriorityWater,
    s1Contribution: s1Contribution,
    preHandFinalClass: preHandFinalClass,
    handPostprocessingCandidate: handPostprocessingCandidate,
    handPostprocessingApplied: handPostprocessingApplied,
    applyHandPostprocessing: applyHandPostprocessing,
    finalClass: finalClass,
    finalNoData: finalNoData
  };
}


// ============================================================================
// 5) SIMPLE USER INTERFACE
// ============================================================================

var drawingTools = Map.drawingTools();
drawingTools.setLinked(false);
drawingTools.setShown(false);

var analysisLayers = {};
var stageDefinitions = [];
var lastInspectionProducts = null;
var lastInspectionAoi = null;

var titleLabel = ui.Label({
  value: 'Fusion process inspector ' + INSPECTOR_VERSION,
  style: {
    fontSize: '20px',
    fontWeight: 'bold',
    margin: '0 0 8px 0'
  }
});

var explanationLabel = ui.Label({
  value:
    'One AOI + one date window. Select a stage after running to see how ' +
    'class 255 is passed through DW, HLS-Landsat, HLS-Sentinel-2 and S1. ' +
    'Each source contributes at most one observation per UTC date. HLS ' +
    'platforms use SPACECRAFT_NAME; the SENSOR property is diagnostic only.',
  style: {
    whiteSpace: 'pre-wrap',
    margin: '0 0 10px 0'
  }
});

var aoiModeSelect = ui.Select({
  items: ['HydroBASINS', 'Drawn polygon'],
  value: 'HydroBASINS',
  style: {stretch: 'horizontal'}
});

var basinLevelSelect = ui.Select({
  items: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
  value: '4',
  style: {stretch: 'horizontal'}
});

var basinIdBox = ui.Textbox({
  value: '1041259950',
  placeholder: 'HYBAS_ID',
  style: {stretch: 'horizontal'}
});

var basinControls = ui.Panel({
  widgets: [
    ui.Label('HydroBASINS level'),
    basinLevelSelect,
    ui.Label('HYBAS_ID'),
    basinIdBox
  ],
  style: {stretch: 'horizontal'}
});

function removeAllDrawings() {
  while (drawingTools.layers().length() > 0) {
    drawingTools.layers().remove(drawingTools.layers().get(0));
  }
}

var drawButton = ui.Button({
  label: 'Draw / replace polygon',
  style: {stretch: 'horizontal'},
  onClick: function() {
    aoiModeSelect.setValue('Drawn polygon', true);
    removeAllDrawings();

    var drawingLayer = ui.Map.GeometryLayer({
      geometries: null,
      name: 'Inspection AOI',
      color: 'FFFF00'
    });

    drawingTools.layers().add(drawingLayer);
    drawingTools.setShown(true);
    drawingTools.setShape('polygon');
    drawingTools.draw();
  }
});

var clearDrawingButton = ui.Button({
  label: 'Clear polygon',
  style: {stretch: 'horizontal'},
  onClick: function() {
    removeAllDrawings();
    drawingTools.setShown(false);
  }
});

var drawingControls = ui.Panel({
  widgets: [
    ui.Label('Draw one polygon on the map, then press Run inspection.'),
    ui.Panel(
      [drawButton, clearDrawingButton],
      ui.Panel.Layout.flow('horizontal')
    )
  ],
  style: {shown: false, stretch: 'horizontal'}
});

aoiModeSelect.onChange(function(value) {
  var useBasins = value === 'HydroBASINS';
  basinControls.style().set('shown', useBasins);
  drawingControls.style().set('shown', !useBasins);
  drawingTools.setShown(!useBasins);
});

var startDateBox = ui.Textbox({
  value: '2025-01-01',
  placeholder: 'YYYY-MM-DD',
  style: {stretch: 'horizontal'}
});

var endDateBox = ui.Textbox({
  value: '2025-02-01',
  placeholder: 'YYYY-MM-DD (exclusive)',
  style: {stretch: 'horizontal'}
});

var applyHandPostprocessingCheckbox = ui.Checkbox({
  label: 'Apply optional final S1 HAND correction',
  value: false,
  style: {stretch: 'horizontal'}
});

var useDwCombinedClass3Checkbox = ui.Checkbox({
  label: 'Use combined Dynamic World class 3',
  value: USE_DW_COMBINED_CLASS_3,
  style: {stretch: 'horizontal'}
});

var statusLabel = ui.Label({
  value: 'Ready.',
  style: {
    color: '555555',
    whiteSpace: 'pre-wrap',
    margin: '8px 0'
  }
});

var stageSelect = ui.Select({
  items: ['Run the inspection first'],
  value: 'Run the inspection first',
  disabled: true,
  style: {stretch: 'horizontal'}
});

var stageDescription = ui.Label({
  value: '',
  style: {
    whiteSpace: 'pre-wrap',
    margin: '6px 0'
  }
});

var legendPanel = ui.Panel({
  style: {
    margin: '4px 0 0 0',
    padding: '0'
  }
});

function legendRow(color, text) {
  var colorBox = ui.Label({
    style: {
      backgroundColor: '#' + color,
      padding: '8px',
      margin: '0 6px 4px 0'
    }
  });

  var description = ui.Label({
    value: text,
    style: {margin: '0 0 4px 0'}
  });

  return ui.Panel(
    [colorBox, description],
    ui.Panel.Layout.flow('horizontal')
  );
}

function updateLegend(entries) {
  var widgets = [ui.Label({
    value: 'Legend',
    style: {fontWeight: 'bold', margin: '4px 0'}
  })];

  entries.forEach(function(entry) {
    widgets.push(legendRow(entry[0], entry[1]));
  });

  legendPanel.widgets().reset(widgets);
}

function setStatus(message, isError) {
  statusLabel.setValue(message);
  statusLabel.style().set('color', isError ? 'B71C1C' : '2E7D32');
}

function validIsoDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false;
  }

  var parsed = new Date(text + 'T00:00:00Z');
  return !isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === text;
}

function addAnalysisLayer(definition) {
  var layer = ui.Map.Layer(
    definition.image,
    definition.vis,
    definition.label,
    false,
    1
  );

  Map.layers().add(layer);
  analysisLayers[definition.label] = layer;
  stageDefinitions.push(definition);
}

function showSelectedStage(label) {
  stageDefinitions.forEach(function(definition) {
    analysisLayers[definition.label].setShown(definition.label === label);
  });

  for (var i = 0; i < stageDefinitions.length; i++) {
    if (stageDefinitions[i].label === label) {
      stageDescription.setValue(stageDefinitions[i].description);
      updateLegend(stageDefinitions[i].legend);
      break;
    }
  }
}

stageSelect.onChange(showSelectedStage);

function populateMap(
  products,
  aoi,
  aoiDescription,
  startText,
  endText,
  applyHandPostprocessing,
  useDwCombinedClass3
) {
  Map.layers().reset([]);
  analysisLayers = {};
  stageDefinitions = [];
  lastInspectionProducts = products;
  lastInspectionAoi = aoi;

  var harmonizedLegend = useDwCombinedClass3
    ? LEGEND_HARMONIZED_WITH_CLASS_3
    : LEGEND_HARMONIZED_WITHOUT_CLASS_3;

  var aoiOutline = ee.FeatureCollection([ee.Feature(aoi)]).style({
    color: 'FFFF00',
    fillColor: '00000000',
    width: 2
  });
  Map.addLayer(aoiOutline, {}, 'Selected AOI', true);

  addAnalysisLayer({
    label: '01 — Dynamic World result',
    image: displayHarmonized(products.dwClass),
    vis: HARMONIZED_VIS,
    legend: harmonizedLegend,
    description:
      'The first harmonized classification. DW value 255 is created by this ' +
      'workflow only where the pixel has zero valid DW label observations in ' +
      'the selected period; it is not a native DW class. Combined class 3 ' +
      (useDwCombinedClass3
        ? 'is enabled.'
        : 'is disabled; the larger component count wins and ties become class 1.')
  });

  addAnalysisLayer({
    label: '02 — DW qualifying open-water observation count',
    image: products.dwWaterObservationCount,
    vis: DW_WATER_COUNT_VIS,
    legend: LEGEND_DW_WATER_COUNT,
    description:
      'Number of valid Dynamic World observations whose water probability is ' +
      'greater than WATER_THRESHOLD (' + WATER_THRESHOLD + ') at each pixel. ' +
      'The colour scale saturates at six, but the pixel inspector retains the ' +
      'actual count.'
  });

  addAnalysisLayer({
    label: '03 — DW open-water hit frequency',
    image: products.dwWaterHitFrequencyPct,
    vis: DW_WATER_FREQUENCY_VIS,
    legend: LEGEND_DW_WATER_FREQUENCY,
    description:
      'Qualifying DW open-water observations divided by all valid DW label ' +
      'observations at each pixel, expressed from 0 to 100%. Pixels with zero ' +
      'valid DW observations are masked because their frequency is undefined.'
  });

  addAnalysisLayer({
    label: '04 — DW open water supported by exactly one observation',
    image: products.dwWaterSupportedByOneObservation.selfMask(),
    vis: DW_SINGLE_HIT_VIS,
    legend: LEGEND_DW_SINGLE_HIT,
    description:
      'Flags pixels whose DW result contains an open-water component and for ' +
      'which exactly one selected-period observation exceeds the water ' +
      'probability threshold. It includes DW classes 1 and 3; it does not flag ' +
      'flooded vegetation supported by one observation.'
  });

  addAnalysisLayer({
    label: '05 — NoData after Dynamic World',
    image: products.noDataAfterDw.selfMask(),
    vis: NODATA_VIS,
    legend: LEGEND_NODATA,
    description:
      'Only the DW pixels coded 255. These are the pixels offered to HLS.'
  });

  addAnalysisLayer({
    label: '06 — HLS-Landsat native temporal mode',
    image: displayHlsNative(products.hlsLandsatNativeComplete),
    vis: HLS_NATIVE_VIS,
    legend: LEGEND_HLS_NATIVE,
    description:
      'The Landsat OPERA HLS temporal mode over the full AOI. This lets ' +
      'you distinguish HLS class 0 from an actual absence of a valid HLS mode.'
  });

  addAnalysisLayer({
    label: '07 — HLS-Landsat contribution to DW gaps',
    image: products.hlsLandsatContribution,
    vis: CONTRIBUTION_VIS,
    legend: LEGEND_HLS_FILL,
    description:
      'Only pixels actually transferred from HLS-Landsat into DW NoData. Classes 0, 1 ' +
      'and 2 all resolve the gap. Areas where DW was already valid are masked.'
  });

  addAnalysisLayer({
    label: '08 — Result after DW + HLS-Landsat',
    image: displayHarmonized(products.classAfterHlsLandsat),
    vis: HARMONIZED_VIS,
    legend: harmonizedLegend,
    description:
      'DW plus valid HLS-Landsat 0/1/2 over DW gaps. Remaining 255 pixels are ' +
      'passed to the HLS-Sentinel-2 branch.'
  });

  addAnalysisLayer({
    label: '09 — NoData after DW + HLS-Landsat',
    image: products.noDataAfterHlsLandsat.selfMask(),
    vis: NODATA_VIS,
    legend: LEGEND_NODATA,
    description:
      'Only gaps unresolved after DW and HLS-Landsat. HLS-Sentinel-2 is ' +
      'evaluated only at these pixels.'
  });

  addAnalysisLayer({
    label: '10 — HLS-Sentinel-2 native temporal mode',
    image: displayHlsNative(products.hlsSentinel2NativeComplete),
    vis: HLS_NATIVE_VIS,
    legend: LEGEND_HLS_NATIVE,
    description:
      'The HLS-Sentinel-2 temporal mode after the same-day official-DW-label ' +
      'gap rule. The rule is ' +
      (HLS_SENTINEL2_SAME_DAY_DW_GAP_ONLY ? 'ENABLED.' : 'DISABLED.')
  });

  addAnalysisLayer({
    label: '11 — HLS-Sentinel-2 contribution to remaining gaps',
    image: products.hlsSentinel2Contribution,
    vis: CONTRIBUTION_VIS,
    legend: LEGEND_HLS_FILL,
    description:
      'Only HLS-Sentinel-2 classes 0/1/2 transferred into gaps remaining ' +
      'after the Landsat branch. Class 0 resolves as non-water and blocks S1.'
  });

  addAnalysisLayer({
    label: '12 — Result after DW + both HLS branches',
    image: displayHarmonized(products.classAfterHls),
    vis: HARMONIZED_VIS,
    legend: harmonizedLegend,
    description:
      'Ordered result after DW, HLS-Landsat, then HLS-Sentinel-2. Only ' +
      'remaining 255 pixels are offered to S1.'
  });

  addAnalysisLayer({
    label: '13 — NoData after DW + both HLS branches',
    image: products.noDataAfterHls.selfMask(),
    vis: NODATA_VIS,
    legend: LEGEND_NODATA,
    description:
      'Only gaps unresolved after both ordered HLS branches. S1 is evaluated ' +
      'only at these pixels.'
  });

  addAnalysisLayer({
    label: '14 — S1 native temporal mode',
    image: displayS1Native(products.s1NativeComplete),
    vis: S1_NATIVE_VIS,
    legend: LEGEND_S1_NATIVE,
    description:
      'The OPERA S1 temporal mode over the full AOI. Native 0 is valid ' +
      'non-water, while magenta means no valid S1 mode at that pixel.'
  });

  addAnalysisLayer({
    label: '15 — S1 status on remaining gaps',
    image: products.s1GapStatus,
    vis: S1_GAP_STATUS_VIS,
    legend: LEGEND_S1_GAP_STATUS,
    description:
      'The decisive layer for final 255 values. Over remaining gaps it shows ' +
      'whether S1 resolves the gap with mode 0, 1 or 3, or instead has no ' +
      'valid thematic mode because of HAND, layover/shadow, ocean masking, ' +
      'native fill or other NoData.'
  });

  addAnalysisLayer({
    label: '16 — S1 contribution to remaining gaps',
    image: products.s1Contribution,
    vis: CONTRIBUTION_VIS,
    legend: LEGEND_S1_FILL,
    description:
      'Only the S1 pixels actually transferred into the final product. The ' +
      'layer includes valid non-water class 0, open water and inundated ' +
      'vegetation. It remains masked everywhere DW or either HLS branch was valid.'
  });

  addAnalysisLayer({
    label: '17 — Fused product before optional HAND correction',
    image: displayHarmonized(products.preHandFinalClass),
    vis: HARMONIZED_VIS,
    legend: harmonizedLegend,
    description:
      'The complete result after DW, both HLS branches and S1, before the ' +
      'optional independent HAND post-processing stage.'
  });

  addAnalysisLayer({
    label: '18 — HAND correction actually applied',
    image: products.handPostprocessingApplied.selfMask(),
    vis: MASK_OVERLAP_VIS,
    legend: [['FF0000', 'Water reclassified to non-water by optional HAND correction']],
    description:
      'Pixels changed from a water-related class to valid non-water class 0. ' +
      'This layer is empty when the optional HAND checkbox is disabled.'
  });

  addAnalysisLayer({
    label: '19 — Final product after enabled stages',
    image: displayHarmonized(products.finalClass),
    vis: HARMONIZED_VIS,
    legend: harmonizedLegend,
    description:
      'The final class after hierarchical fusion and, only when selected, the ' +
      'optional HAND correction. HAND enabled for this run: ' +
      (applyHandPostprocessing ? 'YES.' : 'NO.')
  });

  addAnalysisLayer({
    label: '20 — Final unresolved NoData flag',
    image: products.finalNoData.selfMask(),
    vis: NODATA_VIS,
    legend: LEGEND_NODATA,
    description:
      'Binary flag for every pixel still unresolved after all enabled stages. ' +
      'Value 1 means final class 255. Compare with stage 15 to identify why.'
  });

  addAnalysisLayer({
    label: '21 — S1 HAND/layover reason (no valid S1 class)',
    image: products.s1SpecialMaskReason,
    vis: S1_MASK_REASON_VIS,
    legend: LEGEND_S1_MASK_REASON,
    description:
      'Pixels with zero valid S1 0/1/3 observations during the period but at ' +
      'least one WTR 250 HAND mask or WTR 251 layover/shadow mask. Ocean-mask ' +
      'WTR 254 is reported separately in the S1 gap-status layer. These are ' +
      'invalid S1 observations, not non-water classifications.'
  });

  addAnalysisLayer({
    label: '22 — Observed OPERA S1 WTR-250 footprint (any occurrence)',
    image: products.s1HandMaskAny.selfMask(),
    vis: HAND_FOOTPRINT_VIS,
    legend: LEGEND_HAND_FOOTPRINT,
    description:
      'Direct selected-period HAND-mask footprint. A pixel is shown when at ' +
      'least one OPERA S1 observation has native WTR value 250. This is an ' +
      'informational union: the same pixel may also have a valid S1 class in ' +
      'another observation. It does not alter the fusion result.'
  });

  addAnalysisLayer({
    label: '23 — Hypothetical HAND effect on DW/both-HLS water',
    image: products.handOverlapHigherPriorityWater.selfMask(),
    vis: MASK_OVERLAP_VIS,
    legend: LEGEND_MASK_OVERLAP,
    description:
      'Diagnostic only. Red pixels are water-related DW or either-HLS classifications ' +
      'that would be removed if the S1 HAND mask were applied backwards. The ' +
      'actual final product is not changed.'
  });

  addAnalysisLayer({
    label: '24 — Hypothetical layover/shadow effect on DW/both-HLS water',
    image: products.layoverOverlapHigherPriorityWater.selfMask(),
    vis: MASK_OVERLAP_VIS,
    legend: LEGEND_MASK_OVERLAP,
    description:
      'Diagnostic only. Red pixels are water-related DW or either-HLS classifications ' +
      'that would be removed if the S1 layover/shadow mask were applied ' +
      'backwards. The actual final product is not changed.'
  });

  var labels = stageDefinitions.map(function(definition) {
    return definition.label;
  });

  stageSelect.items().reset(labels);
  stageSelect.setDisabled(false);
  stageSelect.setValue(labels[0], true);
  maskOverlapButton.setDisabled(false);
  maskOverlapResultLabel.setValue('');

  Map.centerObject(aoi);
  setStatus(
    'Inspection ready.\nAOI: ' + aoiDescription +
    '\nWindow: ' + startText + ' to ' + endText + ' (end exclusive).' +
    '\nCombined DW class 3: ' +
    (useDwCombinedClass3 ? 'ENABLED' : 'DISABLED') +
    '\nHLS-Sentinel-2 same-day DW-gap rule: ' +
    (HLS_SENTINEL2_SAME_DAY_DW_GAP_ONLY ? 'ENABLED' : 'DISABLED') +
    '\nOptional HAND correction: ' +
    (applyHandPostprocessing ? 'ENABLED' : 'DISABLED'),
    false
  );

  // These are basic input-availability messages, not area diagnostics.
  print('Inspector version:', INSPECTOR_VERSION);
  print('Combined Dynamic World class 3 enabled:', useDwCombinedClass3);
  print('Selected period (end exclusive):', startText, endText);
  print('DW raw assets / daily UTC dates:',
    products.dwRawCollection.size(), products.dwCollection.size());
  print('HLS Landsat raw assets / daily UTC dates:',
    products.hlsLandsatRawCollection.size(), products.hlsLandsatCollection.size());
  print('HLS Sentinel-2 raw assets / daily UTC dates:',
    products.hlsSentinel2RawCollection.size(), products.hlsSentinel2Collection.size());
  print('OPERA S1 raw assets / daily UTC dates:',
    products.s1RawCollection.size(), products.s1Collection.size());
  print('HLS platform rule:',
    'SPACECRAFT_NAME startsWith Landsat- / Sentinel-2; SENSOR is diagnostic only.');
}

function runForAoi(
  aoi,
  aoiDescription,
  startText,
  endText,
  applyHandPostprocessing,
  useDwCombinedClass3
) {
  var products = buildInspectionProducts(
    aoi,
    startText,
    endText,
    applyHandPostprocessing,
    useDwCombinedClass3
  );
  populateMap(
    products,
    aoi,
    aoiDescription,
    startText,
    endText,
    applyHandPostprocessing,
    useDwCombinedClass3
  );
}

var runButton = ui.Button({
  label: 'Run inspection',
  style: {
    stretch: 'horizontal',
    fontWeight: 'bold'
  },
  onClick: function() {
    var startText = startDateBox.getValue();
    var endText = endDateBox.getValue();
    var applyHandPostprocessing = applyHandPostprocessingCheckbox.getValue();
    var useDwCombinedClass3 = useDwCombinedClass3Checkbox.getValue();

    if (!validIsoDate(startText) || !validIsoDate(endText)) {
      setStatus('Use valid dates in YYYY-MM-DD format.', true);
      return;
    }

    if (new Date(endText + 'T00:00:00Z').getTime() <=
        new Date(startText + 'T00:00:00Z').getTime()) {
      setStatus('The exclusive end date must be later than the start date.', true);
      return;
    }

    setStatus('Building the selected inspection window...', false);

    if (aoiModeSelect.getValue() === 'Drawn polygon') {
      if (drawingTools.layers().length() === 0) {
        setStatus('Draw one polygon before running the inspection.', true);
        return;
      }

      drawingTools.stop();
      var drawnAoi = drawingTools.layers().get(0).getEeObject();
      runForAoi(
        drawnAoi,
        'drawn polygon',
        startText,
        endText,
        applyHandPostprocessing,
        useDwCombinedClass3
      );
      return;
    }

    var levelText = basinLevelSelect.getValue();
    var basinIdText = basinIdBox.getValue();

    if (!/^\d+$/.test(basinIdText)) {
      setStatus('HYBAS_ID must contain digits only.', true);
      return;
    }

    var basinAsset = HYDROBASINS_ASSET_PREFIX + levelText;
    var basinId = parseInt(basinIdText, 10);
    var selectedBasin = ee.FeatureCollection(basinAsset)
      .filter(ee.Filter.eq('HYBAS_ID', basinId));

    selectedBasin.size().evaluate(function(count, error) {
      if (error) {
        setStatus('Could not read the selected HydroBASINS dataset: ' + error, true);
        return;
      }

      if (count === 0) {
        setStatus(
          'No basin was found. Check that the HYBAS_ID belongs to level ' +
          levelText + '.',
          true
        );
        return;
      }

      runForAoi(
        selectedBasin.geometry(),
        'HydroBASINS level ' + levelText + ', HYBAS_ID ' + basinIdText,
        startText,
        endText,
        applyHandPostprocessing,
        useDwCombinedClass3
      );
    });
  }
});

var maskOverlapResultLabel = ui.Label({
  value: '',
  style: {
    whiteSpace: 'pre-wrap',
    fontSize: '11px',
    margin: '4px 0 8px 0'
  }
});

function dictionaryValueOrZero(dictionary, key) {
  var value = dictionary[key];
  return value === null || value === undefined ? 0 : Number(value);
}

var maskOverlapButton = ui.Button({
  label: 'Calculate hypothetical S1-mask overlap',
  disabled: true,
  style: {stretch: 'horizontal'},
  onClick: function() {
    if (!lastInspectionProducts || !lastInspectionAoi) {
      maskOverlapResultLabel.setValue('Run the inspection first.');
      return;
    }

    maskOverlapResultLabel.setValue('Calculating optional overlap areas...');

    var products = lastInspectionProducts;
    var pixelAreaHa = ee.Image.pixelArea().divide(10000);
    var handOverlap = products.handOverlapHigherPriorityWater.eq(1);
    var layoverOverlap = products.layoverOverlapHigherPriorityWater.eq(1);
    var combinedOverlap = handOverlap.or(layoverOverlap);

    var areaBands = ee.Image.cat([
      pixelAreaHa.updateMask(products.higherPriorityWater)
        .rename('higher_priority_water_ha'),
      pixelAreaHa.updateMask(handOverlap)
        .rename('hand_overlap_ha'),
      pixelAreaHa.updateMask(layoverOverlap)
        .rename('layover_overlap_ha'),
      pixelAreaHa.updateMask(combinedOverlap)
        .rename('combined_overlap_ha'),
      pixelAreaHa.updateMask(products.finalNoData.eq(1))
        .rename('final_unresolved_nodata_ha')
    ]);

    areaBands.reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: lastInspectionAoi,
      scale: 30,
      bestEffort: true,
      maxPixels: 1e13,
      tileScale: 8
    }).evaluate(function(result, error) {
      if (error) {
        maskOverlapResultLabel.setValue(
          'Overlap calculation failed: ' + error
        );
        return;
      }

      var higherPriorityWaterHa = dictionaryValueOrZero(
        result || {},
        'higher_priority_water_ha'
      );
      var handHa = dictionaryValueOrZero(result || {}, 'hand_overlap_ha');
      var layoverHa = dictionaryValueOrZero(
        result || {},
        'layover_overlap_ha'
      );
      var combinedHa = dictionaryValueOrZero(
        result || {},
        'combined_overlap_ha'
      );
      var finalNoDataHa = dictionaryValueOrZero(
        result || {},
        'final_unresolved_nodata_ha'
      );

      var handPct = higherPriorityWaterHa > 0
        ? 100 * handHa / higherPriorityWaterHa
        : 0;
      var layoverPct = higherPriorityWaterHa > 0
        ? 100 * layoverHa / higherPriorityWaterHa
        : 0;
      var combinedPct = higherPriorityWaterHa > 0
        ? 100 * combinedHa / higherPriorityWaterHa
        : 0;

      maskOverlapResultLabel.setValue(
        'Reference DW + both-HLS water: ' + higherPriorityWaterHa.toFixed(2) + ' ha\n' +
        'HAND-mask overlap: ' + handHa.toFixed(2) + ' ha (' +
        handPct.toFixed(2) + '%)\n' +
        'Layover/shadow overlap: ' + layoverHa.toFixed(2) + ' ha (' +
        layoverPct.toFixed(2) + '%)\n' +
        'Combined unique overlap: ' + combinedHa.toFixed(2) + ' ha (' +
        combinedPct.toFixed(2) + '%)\n' +
        'Final unresolved NoData: ' + finalNoDataHa.toFixed(2) + ' ha\n' +
        'See stage 18 for the HAND correction actually applied in this run.'
      );
    });
  }
});

var controlPanel = ui.Panel({
  widgets: [
    titleLabel,
    explanationLabel,
    ui.Label({value: 'Area of interest', style: {fontWeight: 'bold'}}),
    aoiModeSelect,
    basinControls,
    drawingControls,
    ui.Label({
      value: 'Date window',
      style: {fontWeight: 'bold', margin: '10px 0 0 0'}
    }),
    ui.Label('Start date'),
    startDateBox,
    ui.Label('End date (exclusive)'),
    endDateBox,
    ui.Label({
      value:
        'The complete selection is one aggregation window; the script does ' +
        'not build or export a time series.',
      style: {fontSize: '11px', color: '666666', whiteSpace: 'pre-wrap'}
    }),
    ui.Label({
      value: 'Dynamic World class coding',
      style: {fontWeight: 'bold', margin: '10px 0 0 0'}
    }),
    useDwCombinedClass3Checkbox,
    ui.Label({
      value:
        'Enabled by default: qualifying open-water and inundated-vegetation ' +
        'components become class 3. When disabled, the component with more ' +
        'qualifying observations wins; a tie becomes open water (class 1).',
      style: {fontSize: '11px', color: '666666', whiteSpace: 'pre-wrap'}
    }),
    ui.Label({
      value: 'Optional post-processing',
      style: {fontWeight: 'bold', margin: '10px 0 0 0'}
    }),
    applyHandPostprocessingCheckbox,
    ui.Label({
      value:
        'Disabled by default. When enabled, it changes only water-related ' +
        'pixels after fusion where S1 has HAND masking and no valid 0/1/3 ' +
        'observation in the selected period.',
      style: {fontSize: '11px', color: '666666', whiteSpace: 'pre-wrap'}
    }),
    runButton,
    statusLabel,
    ui.Label({
      value: 'Layer to inspect',
      style: {fontWeight: 'bold', margin: '8px 0 0 0'}
    }),
    stageSelect,
    stageDescription,
    legendPanel,
    ui.Label({
      value: 'Optional mask-overlap check',
      style: {fontWeight: 'bold', margin: '10px 0 0 0'}
    }),
    ui.Label({
      value:
        'Calculates how much higher-priority DW/both-HLS water overlaps S1 pixels ' +
        'that have HAND or layover/shadow masks and no valid S1 class in the ' +
        'selected period. It does not modify the result.',
      style: {fontSize: '11px', color: '666666', whiteSpace: 'pre-wrap'}
    }),
    maskOverlapButton,
    maskOverlapResultLabel
  ],
  style: {
    position: 'top-left',
    width: '390px',
    padding: '10px',
    maxHeight: '95%'
  }
});

Map.add(controlPanel);
Map.setOptions('SATELLITE');

print(
  'Fusion Process Inspector ' + INSPECTOR_VERSION +
  ': choose an AOI and date window in the panel, then press Run inspection.'
);
