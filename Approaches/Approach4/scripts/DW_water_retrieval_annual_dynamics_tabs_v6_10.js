/**** Hydrological-period water-dynamics metric-specific lightweight application v6.10 ****/
/**** Standalone GEE app or hydrological-period dynamics tab appended to DW_water_retrieval.js. ****/
/**** Lean v4.2-derived metric core with platform-correct HLS separation, valid class-0 support, dynamic legends, on-demand pixel inspection, and separate raw diagnostics. ****/
/**** All checked metrics are added to the Layers panel; only the first is shown initially and the others remain hidden until enabled. ****/
/**** v6.10 applies the selectable timing colour scheme to every ordinal analysis-day layer; metric values and fusion logic are unchanged. ****/

/*
Purpose
-------
Calculate timing, duration, recurrence, support and provenance metrics for a
user-selected full-month analysis period (including cross-calendar hydrological
years) using temporally ordered observations
from Dynamic World, OPERA DSWx-HLS and OPERA DSWx-S1.

Recommended source configuration
--------------------------------
- Dynamic World: Sentinel-2 classification.
- OPERA DSWx-HLS Landsat/OLI: enabled by default because it adds independent
  optical acquisition dates that are not duplicates of Dynamic World.
- OPERA DSWx-HLS Sentinel-2/MSI: available and enabled by default, with its
  recommended role restricted to filling pixels where Dynamic World has no
  valid observation on the same UTC day. Untick the gap-fill restriction to
  use all platform-identified HLS Sentinel-2 observations.
- OPERA DSWx-S1: enabled by default as independent radar evidence.

Platform-first HLS separation
-----------------------------
OPERA DSWx-HLS assets are assigned primarily from SPACECRAFT_NAME:
- Landsat branch: SPACECRAFT_NAME starts with Landsat-
- Sentinel-2 branch: SPACECRAFT_NAME starts with Sentinel-2
The final platform token in system:index is used as an independent check and as
a fallback only when SPACECRAFT_NAME is missing or unrecognized. An asset is
excluded only when both fields identify different recognized platforms or when
neither field identifies a platform. SENSOR is retained as a QA property but
never overrides a clear platform identity because some Earth Engine assets have
been observed with inconsistent SENSOR values. The pixel inspector exposes the
assignment basis, index token, SENSOR conflict flag and platform conflict flag.

Same-day handling
-----------------
All products acquired on the same UTC date are reduced to ONE daily temporal
observation. They therefore cannot inflate the number of observations merely
because several products exist on the same date.

The recommended fusion rule is "Any selected water wins":
- a selected open-water or inundated/partial-water detection from any enabled
  independent source makes the daily pixel wet;
- an explicit dry classification is used only when no enabled source reports a
  water-related class on that day;
- simultaneous wet and dry evidence is recorded in a conflict band;
- open and inundated/partial detections are retained as separate bands, so both
  may be present on the same date.

Water-related classes offered
-----------------------------
Dynamic World:
  label 0 = water
  label 3 = flooded vegetation

OPERA DSWx-HLS:
  WTR class 1 = open water
  WTR class 2 = partial surface water

OPERA DSWx-S1:
  WTR class 1 = open water
  WTR class 3 = inundated vegetation

Only the water-related classes above can be selected as target water classes.
For data-support metrics, all unmasked Dynamic World labels are valid semantic
observations; label 8 (snow_and_ice) is therefore valid support but is not a
selectable liquid-water target.

Important interpretation
------------------------
- OPERA-HLS class 0 is a valid non-water observation; classes 1 and 2 are valid
  water-state observations. HLS mask/quality classes 252, 253 and 254 are not
  accepted as usable liquid-water-state observations.
- OPERA-S1 class 0 is always a valid non-water observation in v6.0; classes 1
  and 3 are valid water-state observations. S1 mask classes 250, 251 and 254
  are excluded from validity.
- OPERA-HLS class 2 is partial surface water and is not necessarily vegetated.
- Dates are observation dates, not exact unobserved physical transition dates.
- Source masks use bit values: 1=DW, 2=HLS-Landsat, 4=HLS-Sentinel-2, 8=S1.
  Sums indicate multiple sources confirming water on the same day.

Raw coverage and exclusion diagnostics
--------------------------------------
The optional diagnostic layers and inspector distinguish:
- asset footprint: a raw source asset spatially covers the pixel/date;
- product value: the classification band is unmasked, including numeric mask classes;
- usable state: the value supplies water/not-water evidence;
- excluded state: the asset covers the pixel but no usable state is available.
For each source/date/pixel, asset footprint = usable state + excluded state.
OPERA-S1 exclusions are split into HAND 250, layover/shadow 251, ocean 254,
masked/no-value and other numeric values. HLS exclusions are split into
snow/ice 252, cloud/shadow 253, ocean 254, masked/no-value and other values.

Memory strategy
---------------
- The annual metric collection is separate from the richer inspector and raw
  diagnostic collections. Map metrics never depend on raw coverage tables.
- Each source is collapsed to one typed, masked image per UTC date before the
  four sources are fused. The final fusion sees at most four source images per
  date rather than every overlapping raw tile.
- Invalid pixels remain masked in the metric core; numeric zero filling is used
  only inside point charts and raw diagnostic views where it is required.
- First and last dates are independent reductions. Displaying the first date
  does not also calculate the last date.
- Only the first checked metric is added to Map. Other checked metrics are
  assembled lazily for batch export and do not create interactive tile jobs.
- Raw coverage, mask-reason and HLS metadata checks are evaluated only when a
  corresponding diagnostic layer is the preview or the pixel inspector asks
  for them.
*/

// ------------------------------------------------------
// Collections, constants and application state
// ------------------------------------------------------

var DYNAMICS_DW = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1');
var DYNAMICS_HLS = ee.ImageCollection('OPERA/DSWX/L3_V1/HLS');
var DYNAMICS_S1 = ee.ImageCollection('OPERA/DSWX/L3_V1/S1');

var DYN_DW_WATER_ID = 0;
var DYN_DW_FLOODED_VEG_ID = 3;
var DYN_DW_SNOW_ICE_ID = 8;

var DYN_HLS_OPEN_ID = 1;
var DYN_HLS_PARTIAL_ID = 2;

var DYN_S1_OPEN_ID = 1;
var DYN_S1_INUNDATED_VEG_ID = 3;

var DYN_STATE_DRY = 0;
var DYN_STATE_OPEN = 1;
var DYN_STATE_PARTIAL = 2;
var DYN_STATE_UNSELECTED_WATER = 3;

var DYN_SOURCE_DW = 1;
var DYN_SOURCE_HLS_LANDSAT = 2;
var DYN_SOURCE_HLS_SENTINEL2 = 4;
var DYN_SOURCE_S1 = 8;

var DYN_HLS_GROUP_LANDSAT = 'LANDSAT_PLATFORM';
var DYN_HLS_GROUP_SENTINEL2 = 'SENTINEL2_PLATFORM';
var DYN_HLS_GROUP_UNRECOGNIZED = 'UNRECOGNIZED_OR_PLATFORM_CONFLICT';

// Explicit collection schemas prevent masked placeholders or conditionally
// generated bands from being inferred as MaskOnly in one image and integer in
// another. Earth Engine charts and reducers then receive homogeneous inputs.
var DYN_RAW_BAND_ORDER = [
  'state',
  'selected',
  'open_class',
  'partial_class',
  'open',
  'partial',
  'unselected_water',
  'dry',
  'valid',
  'source_bit'
];

var DYN_RAW_BAND_TYPES = {
  state: 'uint8',
  selected: 'uint8',
  open_class: 'uint8',
  partial_class: 'uint8',
  open: 'uint8',
  partial: 'uint8',
  unselected_water: 'uint8',
  dry: 'uint8',
  valid: 'uint8',
  source_bit: 'uint8'
};

var DYN_DAILY_BAND_ORDER = DYN_RAW_BAND_ORDER.concat([
  'selected_source_mask',
  'valid_source_mask',
  'valid_source_count',
  'conflict',
  'analysis_day'
]);

var DYN_DAILY_BAND_TYPES = {
  state: 'uint8',
  selected: 'uint8',
  open_class: 'uint8',
  partial_class: 'uint8',
  open: 'uint8',
  partial: 'uint8',
  unselected_water: 'uint8',
  dry: 'uint8',
  valid: 'uint8',
  source_bit: 'uint8',
  selected_source_mask: 'uint8',
  valid_source_mask: 'uint8',
  valid_source_count: 'uint8',
  conflict: 'uint8',
  analysis_day: 'int16'
};

// The map/export metric core carries only bands needed by annual metrics.
// The richer DYN_DAILY schema is retained separately for the pixel inspector.
var DYN_METRIC_BAND_ORDER = [
  'selected',
  'open',
  'partial',
  'dry',
  'valid',
  'selected_source_mask',
  'valid_source_mask',
  'conflict',
  'analysis_day'
];

var DYN_METRIC_BAND_TYPES = {
  selected: 'uint8',
  open: 'uint8',
  partial: 'uint8',
  dry: 'uint8',
  valid: 'uint8',
  selected_source_mask: 'uint8',
  valid_source_mask: 'uint8',
  conflict: 'uint8',
  analysis_day: 'int16'
};

// Raw-source diagnostics are deliberately separate from the fused daily
// classification. They distinguish an acquisition footprint, an unmasked
// product value, a usable water/not-water state, and explicit exclusion
// reasons. All bands are uint8 so chart collections remain homogeneous.
var DYN_DIAGNOSTIC_BAND_ORDER = [
  'asset_footprint',
  'product_value',
  'usable_state',
  'not_water',
  'open_water',
  'partial_inundated',
  'excluded_state',
  'masked_no_value',
  'mask_250_hand',
  'mask_251_layover_shadow',
  'mask_252_snow_ice',
  'mask_253_cloud_shadow',
  'mask_254_ocean',
  'other_numeric'
];

var DYN_DIAGNOSTIC_BAND_TYPES = {
  asset_footprint: 'uint8',
  product_value: 'uint8',
  usable_state: 'uint8',
  not_water: 'uint8',
  open_water: 'uint8',
  partial_inundated: 'uint8',
  excluded_state: 'uint8',
  masked_no_value: 'uint8',
  mask_250_hand: 'uint8',
  mask_251_layover_shadow: 'uint8',
  mask_252_snow_ice: 'uint8',
  mask_253_cloud_shadow: 'uint8',
  mask_254_ocean: 'uint8',
  other_numeric: 'uint8'
};

var DYN_DIAG_KIND_DW = 'DW';
var DYN_DIAG_KIND_HLS = 'HLS';
var DYN_DIAG_KIND_S1 = 'S1';

var DYN_DIAG_SOURCE_DW = 'Dynamic World';
var DYN_DIAG_SOURCE_HLS_LANDSAT = 'HLS Landsat';
var DYN_DIAG_SOURCE_HLS_SENTINEL2 = 'HLS Sentinel-2';
var DYN_DIAG_SOURCE_S1 = 'OPERA-S1';

var DYN_REDUCE_PARALLEL_SCALE = 4;
var DYN_SAME_DAY_PARALLEL_SCALE = 2;

// The temporal inspector is built for a small region around the clicked point,
// never for the complete analysis AOI. This radius supports the 10, 30 and
// 100 m chart scales while keeping the server graph spatially tiny.
var DYN_INSPECTOR_LOCAL_RADIUS_METERS = 200;

var DYN_FUSION_ANY_WATER = 'Any selected water wins (recommended)';
var DYN_FUSION_PRIORITY =
  'Priority: DW > HLS Landsat > HLS Sentinel-2 > S1';

var dynStandaloneStatusLabel = null;
var dynStandaloneDrawingTools = null;
var dynProgressLabel = null;
var lastDynamicsImage = null;
var lastDynamicsName = null;
var lastDynamicsBands = [];
var lastDynamicsAoi = null;
var lastDynamicsObservations = null;
var lastDynamicsYear = null; // Stores the selected period display label for backward-compatible UI naming.
var lastDynamicsPeriodFileLabel = null;
var lastDynamicsRawHls = null;
var lastDynamicsRawDw = null;
var lastDynamicsSourceOptions = null;
var lastDynamicsDiagnosticCollections = null;
var lastDynamicsLazyRunConfig = null;
var dynLastHlsVerificationFeatures = null;
var dynInspectorRequestToken = 0;

// Floating metric-legend state.
var dynLegendPanel = null;
var dynLegendContentPanel = null;
var dynLegendMetricSpecs = {};
var dynLegendMetricOrder = [];
var dynamicsShowLegend = null;
var dynamicsLegendMetricSelect = null;

// Generated-product preview state. Every checked product is added to the
// Earth Engine Layers panel, following the proven v4.2 pattern. Only the first
// product is shown initially; the remaining layers are present but hidden and
// therefore do not request map tiles until the user enables them.
var dynPreviewProducts = {};
var dynPreviewProductOrder = [];
var dynPreviewLayers = {};
var dynCurrentPreviewLabel = null;
var dynSynchronizingProductSelectors = false;
var dynamicsPreviewMetricSelect = null;
var dynamicsLoadPreviewButton = null;

// Compact pixel time-series inspector state. The inspector and legend share
// the bottom-right map position and are never shown simultaneously.
var dynInspectorPanel = null;
var dynInspectorChartPanel = null;
var dynInspectorInfoLabel = null;
var dynInspectorHelpLabel = null;
var dynInspectorModeSelect = null;
var dynInspectorScaleSelect = null;
var dynInspectorDiagnosticSourceSelect = null;
var dynInspectorDiagnosticSourcePanel = null;
var dynInspectorPoint = null;
var dynInspectorCoordinates = null;
var dynInspectorPointLayer = null;
var dynInspectorVisible = false;
var dynamicsEnablePixelInspector = null;

function dynSetStatus(message) {
  if (dynProgressLabel !== null) {
    dynProgressLabel.setValue(message);
  }

  if (typeof statusLabel !== 'undefined' && statusLabel !== null) {
    statusLabel.setValue(message);
  }

  if (dynStandaloneStatusLabel !== null) {
    dynStandaloneStatusLabel.setValue(message);
  }
}

function dynSetBusy(isBusy, message) {
  if (typeof runDynamicsButton !== 'undefined') {
    runDynamicsButton.setDisabled(isBusy);
    runDynamicsButton.setLabel(
      isBusy ? 'Calculating hydrological-period dynamics…' : 'Run selected hydrological-period dynamics'
    );
  }

  if (typeof exportDynamicsButton !== 'undefined') {
    exportDynamicsButton.setDisabled(isBusy);
  }

  dynSetStatus(message);
}

function dynGetDrawingTools() {
  if (
    typeof drawingTools !== 'undefined' &&
    drawingTools !== null
  ) {
    return drawingTools;
  }

  if (dynStandaloneDrawingTools === null) {
    dynStandaloneDrawingTools = Map.drawingTools();
  }

  return dynStandaloneDrawingTools;
}

function dynEnsureAoiLayer() {
  var tools = dynGetDrawingTools();
  tools.setShown(true);
  tools.setDrawModes(['polygon', 'rectangle']);

  if (tools.layers().length() === 0) {
    tools.layers().add(ui.Map.GeometryLayer({
      geometries: null,
      name: 'AnnualDynamicsAOI',
      color: 'red'
    }));
  }

  return tools.layers().get(0);
}

function dynClearDrawnGeometries() {
  var layer = dynEnsureAoiLayer();
  var geometries = layer.geometries();

  while (geometries.length() > 0) {
    geometries.remove(geometries.get(0));
  }
}

function dynStartDrawing(shape) {
  var tools = dynGetDrawingTools();
  dynClearDrawnGeometries();

  if (typeof clickedAoi !== 'undefined') {
    clickedAoi = null;
  }

  tools.setShape(shape);
  tools.draw();

  dynSetStatus(
    'Draw the ' + shape + ' on the map, then run the selected-period analysis.'
  );
}

function dynClearAoi() {
  dynClearDrawnGeometries();

  if (typeof clickedAoi !== 'undefined') {
    clickedAoi = null;
  }

  dynSetStatus('AOI cleared. Select an AOI before running.');
}

function dynGetAoi() {
  var tools = dynGetDrawingTools();

  if (tools.layers().length() > 0) {
    var geometries = tools.layers().get(0).geometries();

    if (geometries.length() > 0) {
      return tools.layers().get(0).getEeObject();
    }
  }

  if (
    typeof clickedAoi !== 'undefined' &&
    clickedAoi !== null
  ) {
    return clickedAoi;
  }

  return null;
}

function dynRequireAoi() {
  var aoi = dynGetAoi();

  if (aoi === null) {
    dynSetStatus(
      'Select an AOI first using Draw rectangle or Draw polygon.'
    );
    return null;
  }

  return aoi;
}

function dynSanitizeName(name) {
  return String(name)
    .replace(/[^\w]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '');
}

function dynRemoveTrailingSlash(text) {
  text = String(text);

  while (text.slice(-1) === '/') {
    text = text.slice(0, -1);
  }

  return text;
}

var DYN_ANALYSIS_DAY_VIS = {
  min: 1,
  max: 366,
  palette: [
    '440154', '3B528B', '21918C', '5EC962', 'FDE725'
  ]
};

// Timing-preview options. Timing metrics are now expressed as analysis-day
// numbers: day 1 is the first day of the user-selected period. This avoids the
// calendar-DOY wrap that would otherwise make January appear earlier than the
// preceding November in a hydrological year.
var DYN_TIMING_VIS_SPLIT = 'Two half-period ramps (recommended)';
var DYN_TIMING_VIS_MULTIHUE = 'Enhanced multi-hue continuous ramp';
var DYN_TIMING_VIS_VIRIDIS = 'Original Viridis continuous ramp';

var DYN_TIMING_FIRST_HALF_PALETTE = [
  '3F007D', '54278F', '2C7FB8', '41B6C4', '2CA25F', '99D8C9'
];
var DYN_TIMING_SECOND_HALF_PALETTE = [
  '8E0152', 'C51B7D', 'E34A33', 'FC8D59', 'FDBB84', 'FDD49E'
];
var DYN_TIMING_MULTIHUE_PALETTE = [
  '30123B', '4145AB', '4675ED', '39A2FC', '1BCFD4',
  '24ECA6', '61FC6C', 'A4FC3C', 'D1E834', 'F3C63A',
  'FE9B2D', 'F36315', 'D93806', 'A91501', '7A0403'
];

function dynTimingContinuousVis(periodDays, palette) {
  return {
    min: 1,
    max: periodDays,
    palette: palette
  };
}

function dynAnalysisDayNumber(date, periodStart) {
  // system:time_start is UTC. Flooring the day difference removes acquisition
  // time-of-day while preserving the correct calendar order across New Year.
  return ee.Date(date)
    .difference(ee.Date(periodStart), 'day')
    .floor()
    .add(1)
    .toInt();
}

var DYN_DURATION_VIS = {
  min: 0,
  max: 366,
  palette: [
    'FFF7FB', 'ECE7F2', 'A6BDDB', '2B8CBE', '045A8D'
  ]
};

var DYN_FRACTION_VIS = {
  min: 0,
  max: 1,
  palette: [
    'FFFFFF', 'FFFFB2', 'FECC5C', 'FD8D3C', 'E31A1C'
  ]
};

var DYN_COUNT_VIS = {
  min: 0,
  max: 40,
  palette: [
    'FFFFFF', 'D0D1E6', 'A6BDDB', '3690C0', '034E7B'
  ]
};

var DYN_VALID_COUNT_VIS = {
  min: 0,
  max: 120,
  palette: [
    'FFFFFF', 'D0D1E6', 'A6BDDB', '3690C0', '034E7B'
  ]
};

var DYN_EPISODE_VIS = {
  min: 1,
  max: 6,
  palette: [
    'FFFFCC', 'C2E699', '78C679', '31A354', '006837', '004529'
  ]
};

var DYN_SOURCE_VIS = {
  min: 1,
  max: 15,
  palette: [
    '419BDF', // 1 DW
    'F39C12', // 2 HLS Landsat
    '8E44AD', // 3 DW + HLS Landsat
    '27AE60', // 4 HLS Sentinel-2
    '16A085', // 5 DW + HLS Sentinel-2
    'D4AC0D', // 6 HLS Landsat + HLS Sentinel-2
    '7D6608', // 7 three optical sources
    'C0392B', // 8 S1
    '922B21', // 9 DW + S1
    'E67E22', // 10 HLS Landsat + S1
    'A04000', // 11 DW + HLS Landsat + S1
    '1ABC9C', // 12 HLS Sentinel-2 + S1
    '117864', // 13 DW + HLS Sentinel-2 + S1
    '9A7D0A', // 14 HLS Landsat + HLS Sentinel-2 + S1
    '2C3E50'  // 15 all sources
  ]
};



// ------------------------------------------------------
// Compact pixel time-series inspector helpers
// ------------------------------------------------------

var DYN_INSPECTOR_STATE_MODE = 'Fused state and observation gaps';
var DYN_INSPECTOR_EVOLUTION_MODE = 'Water-state classification evolution';
var DYN_INSPECTOR_SOURCE_MODE = 'Source availability by date';
var DYN_INSPECTOR_DIAGNOSTIC_MODE = 'Product coverage and exclusion reasons';
var DYN_INSPECTOR_HLS_VERIFY_MODE = 'HLS platform verification (raw metadata)';

function dynRemoveInspectorPointLayer() {
  if (dynInspectorPointLayer !== null) {
    try {
      Map.layers().remove(dynInspectorPointLayer);
    } catch (error) {
      // The layer may already have been removed by Map.layers().reset().
    }
    dynInspectorPointLayer = null;
  }
}

function dynShowInspectorPoint(point) {
  dynRemoveInspectorPointLayer();

  dynInspectorPointLayer = ui.Map.Layer(
    point.buffer(20),
    {color: 'FFFF00'},
    'Pixel inspector point',
    true,
    1
  );

  Map.layers().add(dynInspectorPointLayer);
}

function dynRestoreLegendAfterInspector() {
  if (
    dynamicsShowLegend !== null &&
    dynamicsShowLegend.getValue() &&
    dynLegendPanel !== null
  ) {
    dynLegendPanel.style().set('shown', true);
    if (dynamicsLegendMetricSelect !== null) {
      dynRenderLegend(dynamicsLegendMetricSelect.getValue());
    }
  }
}

function dynSetInspectorVisibility(shown, restoreLegend) {
  dynBuildInspectorPanel();
  dynInspectorVisible = Boolean(shown);
  dynInspectorPanel.style().set('shown', dynInspectorVisible);

  if (dynInspectorVisible) {
    // Use the same map corner as the legend to avoid covering the map with
    // multiple floating panels.
    if (dynLegendPanel !== null) {
      dynLegendPanel.style().set('shown', false);
    }
  } else if (restoreLegend !== false) {
    dynRestoreLegendAfterInspector();
  }
}

function dynInspectorStateCollection(collection) {
  return ee.ImageCollection(collection.map(function(image) {
    var valid = image.select('valid').unmask(0, false).toByte();
    var dry = image.select('dry').unmask(0, false).toByte();
    var unselected = image.select('unselected_water').unmask(0, false).toByte();
    var open = image.select('open').unmask(0, false).toByte();
    var partial = image.select('partial').unmask(0, false).toByte();

    // One categorical code per actual source date:
    // 0=no valid observation, 1=valid dry, 2=valid unselected water class,
    // 3=selected open water, 4=selected inundated/partial water,
    // 5=open and inundated/partial both reported on the same day.
    var code = valid.multiply(0)
      .where(valid.and(dry), 1)
      .where(valid.and(unselected), 2)
      .where(valid.and(open).and(partial.not()), 3)
      .where(valid.and(partial).and(open.not()), 4)
      .where(valid.and(open).and(partial), 5)
      .rename('fused_state')
      .toByte();

    return code.copyProperties(image, [
      'system:time_start',
      'date_key'
    ]);
  })).cast(
    {fused_state: 'uint8'},
    ['fused_state']
  );
}

function dynInspectorEvolutionCollection(collection) {
  return ee.ImageCollection(collection.map(function(image) {
    var valid = image.select('valid').unmask(0, false).toByte();
    var openClass = image.select('open_class').unmask(0, false).toByte();
    var partialClass = image.select('partial_class').unmask(0, false).toByte();

    // This mode is independent of the target-class checkboxes. It shows the
    // actual water-related class group available in the fused daily record:
    // 0=no valid observation, 1=valid dry/non-water, 2=open water,
    // 3=inundated/partial water, 4=both water groups reported the same day.
    var code = valid.multiply(0)
      .where(valid.and(openClass.not()).and(partialClass.not()), 1)
      .where(valid.and(openClass).and(partialClass.not()), 2)
      .where(valid.and(partialClass).and(openClass.not()), 3)
      .where(valid.and(openClass).and(partialClass), 4)
      .rename('classification_evolution')
      .toByte();

    return code.copyProperties(image, [
      'system:time_start',
      'date_key'
    ]);
  })).cast(
    {classification_evolution: 'uint8'},
    ['classification_evolution']
  );
}

function dynInspectorSourceCollection(collection) {
  var result = ee.ImageCollection(collection.map(function(image) {
    var valid = image.select('valid').unmask(0, false).eq(1);
    var mask = image.select('valid_source_mask').unmask(0, false).toInt16();

    function sourceRow(sourceBit, rowValue, name) {
      return mask.bitwiseAnd(sourceBit)
        .neq(0)
        .selfMask()
        .multiply(rowValue)
        .rename(name)
        .toByte();
    }

    var noValid = valid.not()
      .selfMask()
      .multiply(0)
      .rename('No_valid_observation')
      .toByte();

    var fusedValid = valid
      .selfMask()
      .multiply(5)
      .rename('Fused_valid')
      .toByte();

    return noValid
      .addBands(sourceRow(DYN_SOURCE_S1, 1, 'OPERA_S1'))
      .addBands(sourceRow(
        DYN_SOURCE_HLS_SENTINEL2,
        2,
        'HLS_Sentinel2'
      ))
      .addBands(sourceRow(
        DYN_SOURCE_HLS_LANDSAT,
        3,
        'HLS_Landsat'
      ))
      .addBands(sourceRow(DYN_SOURCE_DW, 4, 'Dynamic_World'))
      .addBands(fusedValid)
      .copyProperties(image, [
        'system:time_start',
        'date_key'
      ]);
  }));

  return result.cast({
    No_valid_observation: 'uint8',
    OPERA_S1: 'uint8',
    HLS_Sentinel2: 'uint8',
    HLS_Landsat: 'uint8',
    Dynamic_World: 'uint8',
    Fused_valid: 'uint8'
  }, [
    'No_valid_observation',
    'OPERA_S1',
    'HLS_Sentinel2',
    'HLS_Landsat',
    'Dynamic_World',
    'Fused_valid'
  ]);
}



function dynDiagnosticCollectionForSelectedSource() {
  if (
    lastDynamicsDiagnosticCollections === null ||
    dynInspectorDiagnosticSourceSelect === null
  ) {
    return null;
  }

  var source = dynInspectorDiagnosticSourceSelect.getValue();

  if (source === DYN_DIAG_SOURCE_DW) {
    return lastDynamicsDiagnosticCollections.dw;
  }
  if (source === DYN_DIAG_SOURCE_HLS_LANDSAT) {
    return lastDynamicsDiagnosticCollections.hlsLandsat;
  }
  if (source === DYN_DIAG_SOURCE_HLS_SENTINEL2) {
    return lastDynamicsDiagnosticCollections.hlsSentinel2;
  }
  if (source === DYN_DIAG_SOURCE_S1) {
    return lastDynamicsDiagnosticCollections.s1;
  }

  return null;
}

function dynUpdateInspectorDiagnosticSources(sourceOptions) {
  if (dynInspectorDiagnosticSourceSelect === null) {
    return;
  }

  var items = [];
  if (sourceOptions && sourceOptions.useDw) {
    items.push(DYN_DIAG_SOURCE_DW);
  }
  if (sourceOptions && sourceOptions.useHlsLandsat) {
    items.push(DYN_DIAG_SOURCE_HLS_LANDSAT);
  }
  if (sourceOptions && sourceOptions.useHlsSentinel2) {
    items.push(DYN_DIAG_SOURCE_HLS_SENTINEL2);
  }
  if (sourceOptions && sourceOptions.useS1) {
    items.push(DYN_DIAG_SOURCE_S1);
  }

  dynInspectorDiagnosticSourceSelect.items().reset(items);
  dynInspectorDiagnosticSourceSelect.setDisabled(items.length === 0);
  if (items.length > 0) {
    dynInspectorDiagnosticSourceSelect.setValue(items[0], false);
  }
}

function dynDiagnosticRowCollection(collection, source) {
  var result = ee.ImageCollection(collection.map(function(image) {
    function row(bandName, rowValue, outputName) {
      var condition = image.select(bandName).eq(1);
      return condition.selfMask()
        .multiply(rowValue)
        .rename(outputName)
        .toByte();
    }

    var noFootprint = image.select('asset_footprint').eq(0)
      .selfMask()
      .multiply(0)
      .rename('No_asset_footprint')
      .toByte();

    var output = noFootprint
      .addBands(row('asset_footprint', 1, 'Asset_footprint'))
      .addBands(row('product_value', 2, 'Product_value'))
      .addBands(row('usable_state', 3, 'Usable_water_state'))
      .addBands(row('not_water', 4, 'Class_0_not_water'))
      .addBands(row('open_water', 5, 'Open_water'))
      .addBands(row('partial_inundated', 6, 'Partial_or_inundated'));

    if (source === DYN_DIAG_SOURCE_S1) {
      output = output
        .addBands(row('mask_250_hand', 7, 'HAND_mask_250'))
        .addBands(row(
          'mask_251_layover_shadow',
          8,
          'Layover_shadow_251'
        ))
        .addBands(row('mask_254_ocean', 9, 'Ocean_mask_254'))
        .addBands(row('masked_no_value', 10, 'Masked_no_value'))
        .addBands(row('other_numeric', 11, 'Other_numeric'));
    } else if (
      source === DYN_DIAG_SOURCE_HLS_LANDSAT ||
      source === DYN_DIAG_SOURCE_HLS_SENTINEL2
    ) {
      output = output
        .addBands(row('mask_252_snow_ice', 7, 'Snow_ice_252'))
        .addBands(row('mask_253_cloud_shadow', 8, 'Cloud_shadow_253'))
        .addBands(row('mask_254_ocean', 9, 'Ocean_mask_254'))
        .addBands(row('masked_no_value', 10, 'Masked_no_value'))
        .addBands(row('other_numeric', 11, 'Other_numeric'));
    } else {
      output = output
        .addBands(row('masked_no_value', 7, 'Masked_no_label'));
    }

    return output.copyProperties(image, [
      'system:time_start',
      'date_key'
    ]);
  }));

  if (source === DYN_DIAG_SOURCE_S1) {
    return result.cast({
      No_asset_footprint: 'uint8',
      Asset_footprint: 'uint8',
      Product_value: 'uint8',
      Usable_water_state: 'uint8',
      Class_0_not_water: 'uint8',
      Open_water: 'uint8',
      Partial_or_inundated: 'uint8',
      HAND_mask_250: 'uint8',
      Layover_shadow_251: 'uint8',
      Ocean_mask_254: 'uint8',
      Masked_no_value: 'uint8',
      Other_numeric: 'uint8'
    }, [
      'No_asset_footprint',
      'Asset_footprint',
      'Product_value',
      'Usable_water_state',
      'Class_0_not_water',
      'Open_water',
      'Partial_or_inundated',
      'HAND_mask_250',
      'Layover_shadow_251',
      'Ocean_mask_254',
      'Masked_no_value',
      'Other_numeric'
    ]);
  }

  if (
    source === DYN_DIAG_SOURCE_HLS_LANDSAT ||
    source === DYN_DIAG_SOURCE_HLS_SENTINEL2
  ) {
    return result.cast({
      No_asset_footprint: 'uint8',
      Asset_footprint: 'uint8',
      Product_value: 'uint8',
      Usable_water_state: 'uint8',
      Class_0_not_water: 'uint8',
      Open_water: 'uint8',
      Partial_or_inundated: 'uint8',
      Snow_ice_252: 'uint8',
      Cloud_shadow_253: 'uint8',
      Ocean_mask_254: 'uint8',
      Masked_no_value: 'uint8',
      Other_numeric: 'uint8'
    }, [
      'No_asset_footprint',
      'Asset_footprint',
      'Product_value',
      'Usable_water_state',
      'Class_0_not_water',
      'Open_water',
      'Partial_or_inundated',
      'Snow_ice_252',
      'Cloud_shadow_253',
      'Ocean_mask_254',
      'Masked_no_value',
      'Other_numeric'
    ]);
  }

  return result.cast({
    No_asset_footprint: 'uint8',
    Asset_footprint: 'uint8',
    Product_value: 'uint8',
    Usable_water_state: 'uint8',
    Class_0_not_water: 'uint8',
    Open_water: 'uint8',
    Partial_or_inundated: 'uint8',
    Masked_no_label: 'uint8'
  }, [
    'No_asset_footprint',
    'Asset_footprint',
    'Product_value',
    'Usable_water_state',
    'Class_0_not_water',
    'Open_water',
    'Partial_or_inundated',
    'Masked_no_label'
  ]);
}

function dynDiagnosticTicks(source) {
  var ticks = [
    {v: 0, f: 'No asset'},
    {v: 1, f: 'Asset footprint'},
    {v: 2, f: 'Product value'},
    {v: 3, f: 'Usable state'},
    {v: 4, f: 'Class 0 / dry'},
    {v: 5, f: 'Open water'},
    {v: 6, f: 'Partial/inundated'}
  ];

  if (source === DYN_DIAG_SOURCE_S1) {
    return ticks.concat([
      {v: 7, f: 'HAND 250'},
      {v: 8, f: 'Layover 251'},
      {v: 9, f: 'Ocean 254'},
      {v: 10, f: 'Masked/no value'},
      {v: 11, f: 'Other numeric'}
    ]);
  }

  if (
    source === DYN_DIAG_SOURCE_HLS_LANDSAT ||
    source === DYN_DIAG_SOURCE_HLS_SENTINEL2
  ) {
    return ticks.concat([
      {v: 7, f: 'Snow/ice 252'},
      {v: 8, f: 'Cloud/shadow 253'},
      {v: 9, f: 'Ocean 254'},
      {v: 10, f: 'Masked/no value'},
      {v: 11, f: 'Other numeric'}
    ]);
  }

  return ticks.concat([{v: 7, f: 'Masked/no label'}]);
}

function dynDiagnosticSummaryDictionary(collection, point, scale) {
  var annual = ee.ImageCollection(collection)
    .select(DYN_DIAGNOSTIC_BAND_ORDER)
    .sum()
    .toUint16();

  return annual.reduceRegion({
    reducer: ee.Reducer.first(),
    geometry: point,
    scale: scale,
    bestEffort: true,
    maxPixels: 10000
  });
}

function dynCreateDiagnosticChart(collection, source, scale) {
  var rows = dynDiagnosticRowCollection(collection, source);
  var maxRow = source === DYN_DIAG_SOURCE_DW ? 7 : 11;

  var chart = ui.Chart.image.series(
    rows,
    dynInspectorPoint,
    ee.Reducer.first(),
    scale,
    'system:time_start'
  )
  .setChartType('ScatterChart')
  .setOptions({
    title: source + ': product coverage and exclusion reasons',
    hAxis: {
      title: 'Acquisition date',
      format: 'MMM d',
      gridlines: {count: 8}
    },
    vAxis: {
      title: 'Raw product status',
      viewWindow: {min: -0.5, max: maxRow + 0.5},
      ticks: dynDiagnosticTicks(source)
    },
    pointSize: 5,
    lineWidth: 0,
    legend: {position: 'none'},
    interpolateNulls: false,
    height: 300,
    chartArea: {
      left: 128,
      right: 18,
      top: 42,
      bottom: 55
    }
  });

  chart.style().set('width', '445px');
  chart.style().set('height', '315px');
  chart.style().set('margin', '0');
  return chart;
}

function dynRenderCoverageDiagnostics() {
  dynInspectorChartPanel.clear();

  var collection = dynDiagnosticCollectionForSelectedSource();
  if (collection === null || dynInspectorPoint === null) {
    dynInspectorChartPanel.add(ui.Label(
      'Run the analysis and click a pixel before reading diagnostics.'
    ));
    return;
  }

  var source = dynInspectorDiagnosticSourceSelect.getValue();
  var scale = Number(dynInspectorScaleSelect.getValue());
  if (!scale || scale <= 0) {
    scale = 30;
  }

  var requestToken = ++dynInspectorRequestToken;
  dynInspectorChartPanel.add(ui.Label({
    value: 'Reading selected-period coverage and exclusion counts…',
    style: {color: '#555555', margin: '6px 0'}
  }));

  var summary = dynDiagnosticSummaryDictionary(
    collection,
    dynInspectorPoint,
    scale
  );

  summary.evaluate(function(result, error) {
    if (requestToken !== dynInspectorRequestToken) {
      return;
    }

    dynInspectorChartPanel.clear();
    if (error || !result) {
      dynInspectorChartPanel.add(ui.Label({
        value: 'Error generating coverage diagnostics: ' +
          (error ? String(error) : 'No result returned.'),
        style: {color: '#B00020', whiteSpace: 'normal'}
      }));
      return;
    }

    var footprint = Number(result.asset_footprint || 0);
    var product = Number(result.product_value || 0);
    var usable = Number(result.usable_state || 0);
    var excluded = Number(result.excluded_state || 0);

    dynInspectorChartPanel.add(ui.Label({
      value: source + ' selected-period dates at this pixel — asset footprint: ' +
        footprint + ' | product value: ' + product +
        ' | usable water state: ' + usable +
        ' | excluded/unusable: ' + excluded,
      style: {
        fontWeight: 'bold',
        whiteSpace: 'normal',
        margin: '4px 0'
      }
    }));

    var details;
    if (source === DYN_DIAG_SOURCE_S1) {
      details = 'Class 0 dry: ' + Number(result.not_water || 0) +
        ' | open water: ' + Number(result.open_water || 0) +
        ' | inundated vegetation: ' +
        Number(result.partial_inundated || 0) +
        ' | HAND 250: ' + Number(result.mask_250_hand || 0) +
        ' | layover/shadow 251: ' +
        Number(result.mask_251_layover_shadow || 0) +
        ' | ocean 254: ' + Number(result.mask_254_ocean || 0) +
        ' | masked/no value: ' + Number(result.masked_no_value || 0) +
        ' | other numeric: ' + Number(result.other_numeric || 0) + '.';
    } else if (
      source === DYN_DIAG_SOURCE_HLS_LANDSAT ||
      source === DYN_DIAG_SOURCE_HLS_SENTINEL2
    ) {
      details = 'Class 0 dry: ' + Number(result.not_water || 0) +
        ' | open water: ' + Number(result.open_water || 0) +
        ' | partial water: ' + Number(result.partial_inundated || 0) +
        ' | snow/ice 252: ' + Number(result.mask_252_snow_ice || 0) +
        ' | cloud/shadow 253: ' +
        Number(result.mask_253_cloud_shadow || 0) +
        ' | ocean 254: ' + Number(result.mask_254_ocean || 0) +
        ' | masked/no value: ' + Number(result.masked_no_value || 0) +
        ' | other numeric: ' + Number(result.other_numeric || 0) + '.';
    } else {
      details = 'Dry/other semantic label: ' +
        Number(result.not_water || 0) +
        ' | water: ' + Number(result.open_water || 0) +
        ' | flooded vegetation: ' +
        Number(result.partial_inundated || 0) +
        ' | asset present but label masked: ' +
        Number(result.masked_no_value || 0) + '.';
    }

    dynInspectorChartPanel.add(ui.Label({
      value: details,
      style: {fontSize: '10px', whiteSpace: 'normal', margin: '0 0 3px 0'}
    }));

    dynInspectorChartPanel.add(
      dynCreateDiagnosticChart(collection, source, scale)
    );
  });
}

function dynBuildHlsVerificationFeatures(point, scale) {
  if (lastDynamicsRawHls === null || lastDynamicsRawDw === null) {
    return null;
  }

  var rawDw = lastDynamicsRawDw.filterBounds(point);
  var dwList = rawDw.toList(rawDw.size());

  var dwRows = ee.FeatureCollection(dwList.map(function(item) {
    var image = ee.Image(item);
    var dateKey = ee.Date(image.get('system:time_start'))
      .format('yyyy-MM-dd');
    var rawValue = image.select('label').reduceRegion({
      reducer: ee.Reducer.first(),
      geometry: point,
      scale: Math.min(scale, 30),
      bestEffort: true,
      maxPixels: 10000
    }).get('label');

    var hasPixelValue = ee.Number(ee.Algorithms.If(
      ee.Algorithms.IsEqual(rawValue, null),
      0,
      1
    ));

    return ee.Feature(null, {
      date_key: dateKey,
      pixel_valid: hasPixelValue
    });
  }));

  var dwAssetDates = ee.List(dwRows.aggregate_array('date_key')).distinct();
  var dwValidDates = ee.List(
    dwRows.filter(ee.Filter.eq('pixel_valid', 1))
      .aggregate_array('date_key')
  ).distinct();

  var rawHls = lastDynamicsRawHls.filterBounds(point);
  var hlsList = rawHls.toList(rawHls.size());
  var sourceOptions = lastDynamicsSourceOptions || {};
  var landsatEnabled = sourceOptions.useHlsLandsat ? 1 : 0;
  var sentinel2Enabled = sourceOptions.useHlsSentinel2 ? 1 : 0;
  var msiGapFillOnly = sourceOptions.hlsMsiGapFill ? 1 : 0;

  return ee.FeatureCollection(hlsList.map(function(item) {
    var image = ee.Image(item);
    var date = ee.Date(image.get('system:time_start'));
    var dateKey = date.format('yyyy-MM-dd');
    var group = ee.String(image.get('dyn_hls_platform_group'));
    var rawValue = image.select('WTR_Water_classification').reduceRegion({
      reducer: ee.Reducer.first(),
      geometry: point,
      scale: Math.max(30, scale),
      bestEffort: true,
      maxPixels: 10000
    }).get('WTR_Water_classification');

    var hasPixelValue = ee.Number(ee.Algorithms.If(
      ee.Algorithms.IsEqual(rawValue, null),
      0,
      1
    ));
    var rawClass = ee.Number(ee.Algorithms.If(
      hasPixelValue.eq(1),
      rawValue,
      -999
    ));
    var pixelValid = ee.Number(ee.Algorithms.If(
      hasPixelValue.eq(1),
      ee.List([0, 1, 2]).contains(rawClass),
      0
    ));

    var isLandsat = group.compareTo(DYN_HLS_GROUP_LANDSAT).eq(0);
    var isSentinel2 = group.compareTo(DYN_HLS_GROUP_SENTINEL2).eq(0);
    var dwSameDate = ee.Number(dwAssetDates.contains(dateKey));
    var dwValidSameDate = ee.Number(dwValidDates.contains(dateKey));

    var branchEnabled = ee.Number(ee.Algorithms.If(
      isLandsat,
      landsatEnabled,
      ee.Algorithms.If(isSentinel2, sentinel2Enabled, 0)
    ));

    var passesMsiPolicy = ee.Number(ee.Algorithms.If(
      isSentinel2,
      ee.Algorithms.If(
        msiGapFillOnly === 1,
        dwValidSameDate.eq(0),
        1
      ),
      1
    ));

    var eligibleAfterPolicy = pixelValid
      .multiply(branchEnabled)
      .multiply(passesMsiPolicy);

    return ee.Feature(null, {
      sort_millis: date.millis(),
      date_time_utc: date.format('yyyy-MM-dd HH:mm'),
      date_key: dateKey,
      sensor: image.get('SENSOR'),
      spacecraft: image.get('SPACECRAFT_NAME'),
      platform_group: group,
      platform_assignment_basis: image.get('dyn_hls_platform_assignment_basis'),
      spacecraft_group: image.get('dyn_hls_spacecraft_group'),
      index_group: image.get('dyn_hls_index_group'),
      index_token: image.get('dyn_hls_index_token'),
      spacecraft_index_conflict: image.get('dyn_hls_spacecraft_index_conflict'),
      sensor_spacecraft_conflict: image.get('dyn_hls_sensor_spacecraft_conflict'),
      asset_id: image.id(),
      system_index: image.get('system:index'),
      raw_class: rawClass,
      pixel_has_value: hasPixelValue,
      pixel_valid_water_state: pixelValid,
      branch_enabled: branchEnabled,
      dw_asset_same_date: dwSameDate,
      dw_valid_same_date: dwValidSameDate,
      eligible_after_policy: eligibleAfterPolicy
    });
  })).sort('sort_millis');
}

function dynHlsVerificationPayload(features) {
  var landsat = features.filter(ee.Filter.eq(
    'platform_group',
    DYN_HLS_GROUP_LANDSAT
  ));
  var sentinel2 = features.filter(ee.Filter.eq(
    'platform_group',
    DYN_HLS_GROUP_SENTINEL2
  ));
  var unrecognized = features.filter(ee.Filter.eq(
    'platform_group',
    DYN_HLS_GROUP_UNRECOGNIZED
  ));

  function distinctDates(collection) {
    return collection.aggregate_count_distinct('date_key');
  }

  function validDates(collection) {
    return collection
      .filter(ee.Filter.eq('pixel_valid_water_state', 1))
      .aggregate_count_distinct('date_key');
  }

  function eligibleDates(collection) {
    return collection
      .filter(ee.Filter.eq('eligible_after_policy', 1))
      .aggregate_count_distinct('date_key');
  }

  var rowProperties = [
    'date_time_utc',
    'date_key',
    'sensor',
    'spacecraft',
    'platform_group',
    'platform_assignment_basis',
    'spacecraft_group',
    'index_group',
    'index_token',
    'spacecraft_index_conflict',
    'sensor_spacecraft_conflict',
    'asset_id',
    'system_index',
    'raw_class',
    'pixel_has_value',
    'pixel_valid_water_state',
    'branch_enabled',
    'dw_asset_same_date',
    'dw_valid_same_date',
    'eligible_after_policy'
  ];

  var rows = features.limit(120).toList(120).map(function(item) {
    return ee.Feature(item).toDictionary(rowProperties);
  });

  return ee.Dictionary({
    total_raw_assets: features.size(),
    landsat_raw_assets: landsat.size(),
    sentinel2_raw_assets: sentinel2.size(),
    unrecognized_raw_assets: unrecognized.size(),
    landsat_distinct_dates: distinctDates(landsat),
    sentinel2_distinct_dates: distinctDates(sentinel2),
    landsat_valid_dates_at_pixel: validDates(landsat),
    sentinel2_valid_dates_at_pixel: validDates(sentinel2),
    landsat_eligible_dates: eligibleDates(landsat),
    sentinel2_eligible_dates: eligibleDates(sentinel2),
    sentinel2_dates_with_dw_asset: distinctDates(
      sentinel2.filter(ee.Filter.eq('dw_asset_same_date', 1))
    ),
    sentinel2_dates_with_valid_dw_pixel: distinctDates(
      sentinel2.filter(ee.Filter.eq('dw_valid_same_date', 1))
    ),
    spacecraft_name_assignments: features.filter(ee.Filter.eq(
      'platform_assignment_basis',
      'SPACECRAFT_NAME'
    )).size(),
    system_index_fallback_assignments: features.filter(ee.Filter.eq(
      'platform_assignment_basis',
      'SYSTEM_INDEX_FALLBACK'
    )).size(),
    platform_conflict_assets: features.filter(ee.Filter.eq(
      'spacecraft_index_conflict',
      1
    )).size(),
    sensor_spacecraft_conflict_assets: features.filter(ee.Filter.eq(
      'sensor_spacecraft_conflict',
      1
    )).size(),
    returned_rows: rows,
    returned_row_limit: 120
  });
}

function dynRawHlsClassLabel(value) {
  if (value === -999) {
    return 'masked / no pixel value';
  }
  if (value === 0) {
    return '0 not water';
  }
  if (value === 1) {
    return '1 open water';
  }
  if (value === 2) {
    return '2 partial surface water';
  }
  if (value === 252) {
    return '252 snow/ice';
  }
  if (value === 253) {
    return '253 cloud/cloud shadow';
  }
  if (value === 254) {
    return '254 ocean mask';
  }
  return String(value);
}

function dynRenderHlsVerification() {
  dynInspectorChartPanel.clear();

  if (
    dynInspectorPoint === null ||
    lastDynamicsRawHls === null ||
    lastDynamicsRawDw === null
  ) {
    dynInspectorChartPanel.add(ui.Label(
      'Run the analysis and click a pixel before verifying HLS metadata.'
    ));
    return;
  }

  var scale = Number(dynInspectorScaleSelect.getValue());
  if (!scale || scale <= 0) {
    scale = 30;
  }

  var requestToken = ++dynInspectorRequestToken;
  dynInspectorChartPanel.add(ui.Label({
    value: 'Reading raw HLS metadata and the clicked-pixel class values…',
    style: {color: '#555555', margin: '6px 0'}
  }));

  var features = dynBuildHlsVerificationFeatures(dynInspectorPoint, scale);
  dynLastHlsVerificationFeatures = features;
  var payload = dynHlsVerificationPayload(features);

  payload.evaluate(function(result, error) {
    if (requestToken !== dynInspectorRequestToken) {
      return;
    }

    dynInspectorChartPanel.clear();

    if (error || !result) {
      dynInspectorChartPanel.add(ui.Label({
        value: 'Error generating HLS verification: ' +
          (error ? String(error) : 'No result returned.'),
        style: {color: '#B00020', whiteSpace: 'normal'}
      }));
      return;
    }

    var mismatch = Number(result.unrecognized_raw_assets || 0);
    dynInspectorChartPanel.add(ui.Label({
      value:
        'Platform assignment — raw assets: ' + result.total_raw_assets +
        ' | Landsat/OLI: ' + result.landsat_raw_assets +
        ' | Sentinel-2/MSI: ' + result.sentinel2_raw_assets +
        ' | excluded/unrecognized: ' + mismatch,
      style: {
        fontWeight: 'bold',
        color: mismatch === 0 ? '#1B5E20' : '#B00020',
        whiteSpace: 'normal',
        margin: '4px 0'
      }
    }));

    dynInspectorChartPanel.add(ui.Label({
      value:
        'Assignment basis — SPACECRAFT_NAME: ' +
        result.spacecraft_name_assignments + '; system:index fallback: ' +
        result.system_index_fallback_assignments + '; platform conflicts: ' +
        result.platform_conflict_assets + '; SENSOR/spacecraft conflicts ' +
        '(QA only): ' + result.sensor_spacecraft_conflict_assets + '.',
      style: {fontSize: '11px', whiteSpace: 'normal', margin: '2px 0'}
    }));

    dynInspectorChartPanel.add(ui.Label({
      value:
        'Distinct raw dates — Landsat: ' + result.landsat_distinct_dates +
        ' (' + result.landsat_valid_dates_at_pixel +
        ' valid at pixel; ' + result.landsat_eligible_dates +
        ' eligible after options) | Sentinel-2: ' +
        result.sentinel2_distinct_dates + ' (' +
        result.sentinel2_valid_dates_at_pixel +
        ' valid at pixel; ' + result.sentinel2_eligible_dates +
        ' eligible after options).',
      style: {fontSize: '11px', whiteSpace: 'normal', margin: '2px 0'}
    }));

    dynInspectorChartPanel.add(ui.Label({
      value:
        'HLS Sentinel-2 dates also having a DW asset: ' +
        result.sentinel2_dates_with_dw_asset +
        '; dates with a valid DW pixel: ' +
        result.sentinel2_dates_with_valid_dw_pixel + '.',
      style: {fontSize: '11px', whiteSpace: 'normal', margin: '2px 0 5px 0'}
    }));

    var buttonPanel = ui.Panel([], ui.Panel.Layout.flow('horizontal'));
    buttonPanel.add(ui.Button({
      label: 'Print full raw table',
      onClick: function() {
        print(
          'HLS platform-first verification at clicked pixel',
          dynLastHlsVerificationFeatures
        );
      }
    }));
    buttonPanel.add(ui.Button({
      label: 'Create verification CSV task',
      onClick: function() {
        if (dynLastHlsVerificationFeatures === null) {
          return;
        }
        Export.table.toDrive({
          collection: dynLastHlsVerificationFeatures,
          description: 'HLS_platform_verification_' + lastDynamicsPeriodFileLabel,
          folder: dynamicsDriveFolder.getValue(),
          fileNamePrefix: 'HLS_platform_verification_' + lastDynamicsPeriodFileLabel,
          fileFormat: 'CSV'
        });
        dynSetStatus(
          'Created an HLS platform-verification CSV task in the Tasks tab.'
        );
      }
    }));
    dynInspectorChartPanel.add(buttonPanel);

    dynInspectorChartPanel.add(ui.Label({
      value:
        'Date/time | assigned group [basis] | SPACECRAFT_NAME / SENSOR | ' +
        'index token | platform conflict / SENSOR conflict | raw class | ' +
        'DW valid same date | eligible after current options',
      style: {
        fontWeight: 'bold',
        fontSize: '10px',
        whiteSpace: 'normal',
        margin: '5px 0 2px 0'
      }
    }));

    var rowsPanel = ui.Panel({
      style: {
        maxHeight: '205px',
        padding: '0 2px 0 0'
      }
    });

    var rows = result.returned_rows || [];
    rows.forEach(function(row) {
      var eligible = Number(row.eligible_after_policy) === 1 ? 'yes' : 'no';
      var dwValid = Number(row.dw_valid_same_date) === 1 ? 'yes' : 'no';
      rowsPanel.add(ui.Label({
        value:
          row.date_time_utc + ' | ' + row.platform_group + ' [' +
          row.platform_assignment_basis + '] | ' + row.spacecraft + ' / ' +
          row.sensor + ' | ' + row.index_token + ' | platformConflict=' +
          row.spacecraft_index_conflict + ', sensorConflict=' +
          row.sensor_spacecraft_conflict + ' | ' +
          dynRawHlsClassLabel(Number(row.raw_class)) + ' | DW=' +
          dwValid + ' | eligible=' + eligible + '\n' + row.asset_id,
        style: {
          fontSize: '9px',
          fontFamily: 'monospace',
          whiteSpace: 'pre-wrap',
          margin: '0 0 3px 0',
          padding: '2px',
          backgroundColor: '#F7F7F7'
        }
      }));
    });
    dynInspectorChartPanel.add(rowsPanel);

    if (Number(result.total_raw_assets) > Number(result.returned_row_limit)) {
      dynInspectorChartPanel.add(ui.Label({
        value:
          'The panel shows the first ' + result.returned_row_limit +
          ' raw assets. Use Print or CSV for the complete table.',
        style: {fontSize: '10px', color: '#555555'}
      }));
    }
  });
}


function dynClearPointLocalInspectorData() {
  lastDynamicsObservations = null;
  lastDynamicsRawHls = null;
  lastDynamicsRawDw = null;
  lastDynamicsDiagnosticCollections = null;
  dynLastHlsVerificationFeatures = null;
  dynInspectorRequestToken++;
}

function dynEnsureLazyInspectorData(point) {
  if (lastDynamicsObservations !== null) {
    return true;
  }
  if (lastDynamicsLazyRunConfig === null || point === null) {
    return false;
  }

  dynSetStatus(
    'Building a point-local daily observation graph for the clicked pixel…'
  );

  var cfg = lastDynamicsLazyRunConfig;
  var scale = dynInspectorScaleSelect === null ? 30 :
    Number(dynInspectorScaleSelect.getValue());
  if (!scale || scale <= 0) {
    scale = 30;
  }

  // The previous lazy implementation rebuilt the richer collection over the
  // complete analysis AOI. Although the chart sampled one point, every daily
  // fusion image still carried the full AOI graph and could exceed memory.
  // Filter and clip every raw collection to a tiny point buffer instead.
  var localRadius = Math.max(
    DYN_INSPECTOR_LOCAL_RADIUS_METERS,
    scale * 2
  );
  var inspectorAoi = ee.Geometry(point).buffer(localRadius);

  var annual = buildAnnualDynamicsCollection(
    inspectorAoi,
    cfg.start,
    cfg.end,
    cfg.sourceOptions,
    cfg.classOptions
  );

  lastDynamicsObservations = annual.inspectorCollection
    .cast(DYN_DAILY_BAND_TYPES, DYN_DAILY_BAND_ORDER);
  lastDynamicsRawHls = annual.rawCollections.hlsAllTagged;
  lastDynamicsRawDw = annual.rawCollections.dwVerification;
  lastDynamicsDiagnosticCollections = {
    dw: annual.diagnosticCollections.dw.filter(
      ee.Filter.eq('has_real_observation', 1)
    ),
    hlsLandsat: annual.diagnosticCollections.hlsLandsat.filter(
      ee.Filter.eq('has_real_observation', 1)
    ),
    hlsSentinel2: annual.diagnosticCollections.hlsSentinel2.filter(
      ee.Filter.eq('has_real_observation', 1)
    ),
    s1: annual.diagnosticCollections.s1.filter(
      ee.Filter.eq('has_real_observation', 1)
    )
  };

  dynUpdateInspectorDiagnosticSources(cfg.sourceOptions);
  return true;
}

function dynCreateInspectorChart() {
  if (
    lastDynamicsObservations === null ||
    dynInspectorPoint === null
  ) {
    return null;
  }

  var scale = Number(dynInspectorScaleSelect.getValue());
  if (!scale || scale <= 0) {
    scale = 30;
  }

  var mode = dynInspectorModeSelect.getValue();
  var chartCollection;
  var chart;

  if (mode === DYN_INSPECTOR_SOURCE_MODE) {
    chartCollection = dynInspectorSourceCollection(
      lastDynamicsObservations
    );

    chart = ui.Chart.image.series(
      chartCollection,
      dynInspectorPoint,
      ee.Reducer.first(),
      scale,
      'system:time_start'
    )
    .setChartType('ScatterChart')
    .setOptions({
      title: 'Valid source support at the clicked pixel',
      hAxis: {
        title: 'Acquisition date',
        format: 'MMM d',
        gridlines: {count: 8}
      },
      vAxis: {
        title: 'Source support',
        viewWindow: {min: -0.5, max: 5.5},
        ticks: [
          {v: 0, f: 'No valid'},
          {v: 1, f: 'S1'},
          {v: 2, f: 'HLS S2'},
          {v: 3, f: 'HLS Landsat'},
          {v: 4, f: 'DW'},
          {v: 5, f: 'Fused valid'}
        ]
      },
      pointSize: 5,
      lineWidth: 0,
      legend: {position: 'none'},
      colors: [
        '#9E9E9E', '#C0392B', '#27AE60',
        '#F39C12', '#419BDF', '#212121'
      ],
      interpolateNulls: false,
      height: 265,
      chartArea: {
        left: 92,
        right: 18,
        top: 42,
        bottom: 55
      }
    });
  } else if (mode === DYN_INSPECTOR_EVOLUTION_MODE) {
    chartCollection = dynInspectorEvolutionCollection(
      lastDynamicsObservations
    );

    chart = ui.Chart.image.series(
      chartCollection,
      dynInspectorPoint,
      ee.Reducer.first(),
      scale,
      'system:time_start'
    )
    .setChartType('SteppedAreaChart')
    .setOptions({
      title: 'Water-state classification evolution at the clicked pixel',
      hAxis: {
        title: 'Acquisition date',
        format: 'MMM d',
        gridlines: {count: 8}
      },
      vAxis: {
        title: 'Observed water-state group',
        viewWindow: {min: -0.25, max: 4.25},
        ticks: [
          {v: 0, f: 'No valid'},
          {v: 1, f: 'Dry/non-water'},
          {v: 2, f: 'Open water'},
          {v: 3, f: 'Flooded veg/partial'},
          {v: 4, f: 'Open + flooded/partial'}
        ]
      },
      pointSize: 4,
      lineWidth: 2,
      areaOpacity: 0.18,
      legend: {position: 'none'},
      colors: ['#1F78B4'],
      interpolateNulls: false,
      height: 265,
      chartArea: {
        left: 132,
        right: 18,
        top: 42,
        bottom: 55
      }
    });
  } else {
    chartCollection = dynInspectorStateCollection(
      lastDynamicsObservations
    );

    chart = ui.Chart.image.series(
      chartCollection,
      dynInspectorPoint,
      ee.Reducer.first(),
      scale,
      'system:time_start'
    )
    .setChartType('ScatterChart')
    .setOptions({
      title: 'Fused state and observation gaps at the clicked pixel',
      hAxis: {
        title: 'Acquisition date',
        format: 'MMM d',
        gridlines: {count: 8}
      },
      vAxis: {
        title: 'Fused state',
        viewWindow: {min: -0.5, max: 5.5},
        ticks: [
          {v: 0, f: 'No valid'},
          {v: 1, f: 'Dry'},
          {v: 2, f: 'Unselected water'},
          {v: 3, f: 'Open water'},
          {v: 4, f: 'Inundated/partial'},
          {v: 5, f: 'Open + partial'}
        ]
      },
      pointSize: 5,
      lineWidth: 0,
      legend: {position: 'none'},
      colors: ['#2C3E50'],
      interpolateNulls: false,
      height: 265,
      chartArea: {
        left: 112,
        right: 18,
        top: 42,
        bottom: 55
      }
    });
  }

  chart.style().set('width', '445px');
  chart.style().set('height', '280px');
  chart.style().set('margin', '0');

  return chart;
}

function dynRenderInspectorChart() {
  dynBuildInspectorPanel();
  dynInspectorChartPanel.clear();

  if (
    lastDynamicsObservations === null ||
    dynInspectorPoint === null
  ) {
    dynInspectorChartPanel.add(ui.Label(
      'Run the selected-period analysis, enable the inspector and click a pixel.'
    ));
    return;
  }

  if (dynInspectorModeSelect.getValue() === DYN_INSPECTOR_HLS_VERIFY_MODE) {
    dynRenderHlsVerification();
    return;
  }

  if (dynInspectorModeSelect.getValue() === DYN_INSPECTOR_DIAGNOSTIC_MODE) {
    dynRenderCoverageDiagnostics();
    return;
  }

  // Cancel any pending asynchronous raw-metadata request when the user
  // switches back to a chart mode.
  dynInspectorRequestToken++;

  dynInspectorChartPanel.add(ui.Label({
    value: 'Loading the clicked-pixel time series…',
    style: {color: '#555555', margin: '6px 0'}
  }));

  var chart = dynCreateInspectorChart();
  dynInspectorChartPanel.clear();

  if (chart !== null) {
    dynInspectorChartPanel.add(chart);
  }
}

function dynInspectCoordinates(coords) {
  if (
    dynamicsEnablePixelInspector === null ||
    !dynamicsEnablePixelInspector.getValue()
  ) {
    return;
  }

  // Set the clicked point before constructing the lazy inspector graph. The
  // graph is point-specific, so each new click discards the previous local
  // collection rather than reusing a collection clipped around another point.
  dynInspectorCoordinates = coords;
  dynInspectorPoint = ee.Geometry.Point([coords.lon, coords.lat]);
  dynClearPointLocalInspectorData();

  if (!dynEnsureLazyInspectorData(dynInspectorPoint)) {
    dynSetStatus(
      'Run the hydrological-period dynamics before using the pixel time-series inspector.'
    );
    return;
  }

  dynShowInspectorPoint(dynInspectorPoint);

  dynBuildInspectorPanel();
  dynInspectorInfoLabel.setValue(
    'Period ' + lastDynamicsYear + ' | lon ' + coords.lon.toFixed(5) +
    ', lat ' + coords.lat.toFixed(5) +
    '. The chart is computed from a small local buffer around this point; ' +
    'each x-position is an actual enabled-source acquisition date.'
  );

  dynSetInspectorVisibility(true, false);
  dynRenderInspectorChart();
}

function dynUpdateInspectorHelp() {
  if (dynInspectorHelpLabel === null || dynInspectorModeSelect === null) {
    return;
  }

  var mode = dynInspectorModeSelect.getValue();
  var message;

  if (dynInspectorDiagnosticSourcePanel !== null) {
    dynInspectorDiagnosticSourcePanel.style().set(
      'shown',
      mode === DYN_INSPECTOR_DIAGNOSTIC_MODE
    );
  }

  if (mode === DYN_INSPECTOR_EVOLUTION_MODE) {
    message = 'The stepped profile shows the sequence of observed classes: ' +
      'dry/non-water, open water and flooded-vegetation/partial-water states. It uses all ' +
      'water-related classes from the enabled sources, even when one class ' +
      'was not selected as a target for this period. The connecting steps are a ' +
      'visual guide between observations, not proof that the state persisted ' +
      'through an unobserved interval.';
  } else if (mode === DYN_INSPECTOR_SOURCE_MODE) {
    message = 'Each row identifies which enabled source supplied a valid ' +
      'classification on that date. Several source rows can occur on the ' +
      'same day, but the fused series counts that calendar date once.';
  } else if (mode === DYN_INSPECTOR_DIAGNOSTIC_MODE) {
    message = 'This mode separates raw acquisition-footprint dates, unmasked ' +
      'product values, usable water/not-water states and explicit exclusion ' +
      'reasons. It is designed to explain spatial patterns such as a river ' +
      'having more usable OPERA-S1 dates because nearby terrain is repeatedly ' +
      'assigned HAND class 250.';
  } else if (mode === DYN_INSPECTOR_HLS_VERIFY_MODE) {
    message = 'This on-demand table reads the original HLS metadata and raw ' +
      'class at the clicked pixel. SPACECRAFT_NAME is the primary platform ' +
      'identifier; the final system:index token independently checks it and ' +
      'is used only as a fallback. SENSOR is QA-only. Assets enter neither ' +
      'branch only when recognized platform identifiers conflict or neither ' +
      'identifier is recognized.';
  } else {
    message = 'Grey/zero points are enabled-source acquisition dates with no ' +
      'usable fused observation at the clicked pixel. Horizontal spacing ' +
      'between non-zero points shows the interval between valid observations.';
  }

  dynInspectorHelpLabel.setValue(
    message + ' The inspector temporarily replaces the metric legend.'
  );
}

function dynBuildInspectorPanel() {
  if (dynInspectorPanel !== null) {
    return;
  }

  var hideButton = ui.Button({
    label: 'Hide',
    style: {margin: '0 0 0 8px'},
    onClick: function() {
      dynSetInspectorVisibility(false, true);
    }
  });

  dynInspectorModeSelect = ui.Select({
    items: [
      DYN_INSPECTOR_STATE_MODE,
      DYN_INSPECTOR_EVOLUTION_MODE,
      DYN_INSPECTOR_SOURCE_MODE,
      DYN_INSPECTOR_DIAGNOSTIC_MODE,
      DYN_INSPECTOR_HLS_VERIFY_MODE
    ],
    value: DYN_INSPECTOR_STATE_MODE,
    style: {stretch: 'horizontal'},
    onChange: function() {
      dynUpdateInspectorHelp();
      dynRenderInspectorChart();
    }
  });

  dynInspectorScaleSelect = ui.Select({
    items: ['10', '30', '100'],
    value: '30',
    style: {width: '82px'},
    onChange: function() {
      dynRenderInspectorChart();
    }
  });

  dynInspectorDiagnosticSourceSelect = ui.Select({
    items: [
      DYN_DIAG_SOURCE_DW,
      DYN_DIAG_SOURCE_HLS_LANDSAT,
      DYN_DIAG_SOURCE_HLS_SENTINEL2,
      DYN_DIAG_SOURCE_S1
    ],
    value: DYN_DIAG_SOURCE_DW,
    style: {stretch: 'horizontal'},
    onChange: function() {
      if (
        dynInspectorModeSelect !== null &&
        dynInspectorModeSelect.getValue() === DYN_INSPECTOR_DIAGNOSTIC_MODE
      ) {
        dynRenderInspectorChart();
      }
    }
  });

  dynInspectorDiagnosticSourcePanel = ui.Panel([
    ui.Label('Diagnostic source:'),
    dynInspectorDiagnosticSourceSelect
  ], ui.Panel.Layout.flow('horizontal'), {
    stretch: 'horizontal',
    shown: false,
    margin: '3px 0 0 0'
  });

  dynInspectorInfoLabel = ui.Label({
    value: 'Enable the inspector and click a pixel after running the analysis.',
    style: {
      fontSize: '11px',
      color: '#444444',
      whiteSpace: 'normal',
      margin: '0 0 5px 0'
    }
  });

  dynInspectorChartPanel = ui.Panel();

  dynInspectorPanel = ui.Panel({
    style: {
      position: 'bottom-right',
      width: '470px',
      maxHeight: '540px',
      padding: '8px',
      backgroundColor: '#FFFFFF',
      border: '1px solid #777777',
      shown: false
    }
  });

  dynInspectorPanel.add(ui.Panel({
    widgets: [
      ui.Label({
        value: 'Pixel temporal inspector',
        style: {
          fontWeight: 'bold',
          fontSize: '14px',
          stretch: 'horizontal'
        }
      }),
      hideButton
    ],
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {stretch: 'horizontal', margin: '0 0 5px 0'}
  }));

  dynInspectorPanel.add(dynInspectorInfoLabel);
  dynInspectorPanel.add(ui.Panel([
    dynInspectorModeSelect,
    ui.Label('Scale:'),
    dynInspectorScaleSelect,
    ui.Label('m')
  ], ui.Panel.Layout.flow('horizontal')));
  dynInspectorPanel.add(dynInspectorDiagnosticSourcePanel);
  dynInspectorPanel.add(dynInspectorChartPanel);
  dynInspectorHelpLabel = ui.Label({
    value: '',
    style: {
      fontSize: '10px',
      color: '#555555',
      whiteSpace: 'normal',
      margin: '3px 0 0 0'
    }
  });
  dynInspectorPanel.add(dynInspectorHelpLabel);
  dynUpdateInspectorHelp();
}

// ------------------------------------------------------
// Dynamic floating legend helpers
// ------------------------------------------------------

function dynMakeLegendRow(color, name) {
  var colorBox = ui.Label({
    value: ' ',
    style: {
      backgroundColor: '#' + color,
      width: '18px',
      height: '14px',
      padding: '0',
      margin: '1px 7px 3px 0',
      border: '1px solid #777777'
    }
  });

  var description = ui.Label({
    value: name,
    style: {
      margin: '0 0 3px 0',
      fontSize: '11px',
      whiteSpace: 'normal'
    }
  });

  return ui.Panel({
    widgets: [colorBox, description],
    layout: ui.Panel.Layout.flow('horizontal')
  });
}

function dynHexToRgb(hex) {
  hex = String(hex).replace('#', '');
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

function dynRgbToHex(rgb) {
  function component(value) {
    var text = Math.max(0, Math.min(255, Math.round(value))).toString(16);
    return text.length === 1 ? '0' + text : text;
  }

  return component(rgb.r) + component(rgb.g) + component(rgb.b);
}

function dynInterpolateColor(startHex, endHex, fraction) {
  var start = dynHexToRgb(startHex);
  var end = dynHexToRgb(endHex);

  return dynRgbToHex({
    r: start.r + (end.r - start.r) * fraction,
    g: start.g + (end.g - start.g) * fraction,
    b: start.b + (end.b - start.b) * fraction
  });
}

function dynExpandPalette(palette, steps) {
  var output = [];
  var segments = palette.length - 1;

  for (var i = 0; i < steps; i++) {
    var position = steps === 1 ? 0 : i / (steps - 1);
    var scaled = position * segments;
    var lower = Math.min(segments - 1, Math.floor(scaled));
    var localFraction = scaled - lower;

    if (position === 1) {
      lower = segments - 1;
      localFraction = 1;
    }

    output.push(dynInterpolateColor(
      palette[lower],
      palette[lower + 1],
      localFraction
    ));
  }

  return output;
}

// The floating panel is 350 px wide with 8 px padding on both sides.
// A 330 px legend body therefore fills the usable content width without
// wrapping. Sixty-six 5 px colour blocks cover exactly 330 px.
var DYN_LEGEND_BODY_WIDTH_PX = 330;
var DYN_LEGEND_COLOR_STEPS = 66;
var DYN_LEGEND_COLOR_BLOCK_WIDTH_PX = 5;

function dynMakeContinuousBar(palette) {
  var colors = dynExpandPalette(palette, DYN_LEGEND_COLOR_STEPS);
  var widgets = colors.map(function(color) {
    return ui.Label({
      value: ' ',
      style: {
        backgroundColor: '#' + color,
        width: DYN_LEGEND_COLOR_BLOCK_WIDTH_PX + 'px',
        height: '14px',
        padding: '0',
        margin: '0'
      }
    });
  });

  return ui.Panel({
    widgets: widgets,
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {
      width: DYN_LEGEND_BODY_WIDTH_PX + 'px',
      margin: '5px 0 2px 0',
      padding: '0',
      border: '1px solid #777777'
    }
  });
}

function dynMakeTickPanel(labels) {
  var tickWidth = DYN_LEGEND_BODY_WIDTH_PX / labels.length;

  var widgets = labels.map(function(label, index) {
    var alignment = 'center';

    if (index === 0) {
      alignment = 'left';
    }

    if (index === labels.length - 1) {
      alignment = 'right';
    }

    return ui.Label({
      value: label,
      style: {
        width: tickWidth + 'px',
        fontSize: '10px',
        textAlign: alignment,
        whiteSpace: 'pre',
        margin: '0'
      }
    });
  });

  return ui.Panel({
    widgets: widgets,
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {
      width: DYN_LEGEND_BODY_WIDTH_PX + 'px',
      margin: '0 0 4px 0'
    }
  });
}

function dynFormatUtcDate(millis) {
  var date = new Date(millis);
  var months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];

  return date.getUTCDate() + ' ' + months[date.getUTCMonth()] + ' ' +
    date.getUTCFullYear();
}

function dynPeriodDayDateMillis(entry, analysisDay) {
  return entry.periodStartMillis + (analysisDay - 1) * 86400000;
}

function dynAnalysisDayTick(entry, fraction) {
  var day = 1 + Math.round((entry.periodDays - 1) * fraction);
  return dynFormatUtcDate(dynPeriodDayDateMillis(entry, day)) +
    '\nday ' + day;
}

function dynContinuousLegendSpec(type, entry) {
  if (type === 'ANALYSIS_DAY') {
    var palette = entry.timingVisMode === DYN_TIMING_VIS_MULTIHUE ?
      DYN_TIMING_MULTIHUE_PALETTE : DYN_ANALYSIS_DAY_VIS.palette;

    return {
      palette: palette,
      ticks: [
        dynAnalysisDayTick(entry, 0),
        dynAnalysisDayTick(entry, 0.25),
        dynAnalysisDayTick(entry, 0.50),
        dynAnalysisDayTick(entry, 0.75),
        dynAnalysisDayTick(entry, 1)
      ],
      description: 'Timing within the selected analysis period. Day 1 is the first selected date.',
      note: 'The exported value is the ordinal analysis day, not calendar DOY. This keeps timing ordered correctly across calendar years.'
    };
  }

  if (type === 'DURATION') {
    return {
      palette: DYN_DURATION_VIS.palette,
      ticks: ['0', '92', '183', '275', '366'],
      description: 'Duration or temporal gap in days: pale colours are shorter and dark blue is longer.',
      note: 'The legend uses the standard 0–366 day display stretch; exported values are not truncated.'
    };
  }

  if (type === 'FRACTION') {
    return {
      palette: DYN_FRACTION_VIS.palette,
      ticks: ['0%', '25%', '50%', '75%', '100%'],
      description: 'Share of valid fused observation dates classified in a selected water class.',
      note: '0% means never selected; 100% means selected on every valid fused date.'
    };
  }

  if (type === 'VALID_COUNT') {
    return {
      palette: DYN_VALID_COUNT_VIS.palette,
      ticks: ['0', '30', '60', '90', '≥120'],
      description: 'Number of calendar dates satisfying the selected support, coverage or exclusion condition.',
      note: 'The map display saturates at 120. Exported pixel values are not truncated.'
    };
  }

  return {
    palette: DYN_COUNT_VIS.palette,
    ticks: ['0', '10', '20', '30', '≥40'],
    description: 'Number of fused daily observations satisfying the metric.',
    note: 'The map display saturates at 40. Exported pixel values are not truncated.'
  };
}

function dynRenderSplitTimingLegend(entry) {
  var splitDay = entry.firstHalfEndDay;
  var secondStart = Math.min(entry.periodDays, splitDay + 1);

  dynLegendContentPanel.add(ui.Label(
    'The selected period is shown with two independent colour ramps so each half uses the full visual contrast.'
  ));

  dynLegendContentPanel.add(ui.Label({
    value: 'First half: ' +
      dynFormatUtcDate(entry.periodStartMillis) + ' – ' +
      dynFormatUtcDate(dynPeriodDayDateMillis(entry, splitDay)),
    style: {fontWeight: 'bold', margin: '5px 0 0 0'}
  }));
  dynLegendContentPanel.add(dynMakeContinuousBar(
    DYN_TIMING_FIRST_HALF_PALETTE
  ));
  dynLegendContentPanel.add(dynMakeTickPanel([
    dynFormatUtcDate(entry.periodStartMillis) + '\nday 1',
    dynFormatUtcDate(dynPeriodDayDateMillis(
      entry,
      1 + Math.floor((splitDay - 1) / 2)
    )),
    dynFormatUtcDate(dynPeriodDayDateMillis(entry, splitDay)) +
      '\nday ' + splitDay
  ]));

  dynLegendContentPanel.add(ui.Label({
    value: 'Second half: ' +
      dynFormatUtcDate(dynPeriodDayDateMillis(entry, secondStart)) + ' – ' +
      dynFormatUtcDate(dynPeriodDayDateMillis(entry, entry.periodDays)),
    style: {fontWeight: 'bold', margin: '5px 0 0 0'}
  }));
  dynLegendContentPanel.add(ui.Label({
    value: ' ',
    style: {margin: '0', padding: '0'}
  }));
  dynLegendContentPanel.add(dynMakeContinuousBar(
    DYN_TIMING_SECOND_HALF_PALETTE
  ));
  dynLegendContentPanel.add(dynMakeTickPanel([
    dynFormatUtcDate(dynPeriodDayDateMillis(entry, secondStart)) +
      '\nday ' + secondStart,
    dynFormatUtcDate(dynPeriodDayDateMillis(
      entry,
      secondStart + Math.floor((entry.periodDays - secondStart) / 2)
    )),
    dynFormatUtcDate(dynPeriodDayDateMillis(entry, entry.periodDays)) +
      '\nday ' + entry.periodDays
  ]));

  dynLegendContentPanel.add(ui.Label({
    value: 'The colour discontinuity at the midpoint is intentional. Compare colours within each half; use the date labels to compare across halves.',
    style: {fontSize: '10px', color: '#555555', margin: '3px 0 0 0'}
  }));
}

function dynSourceCombinationName(value) {
  var names = [];

  if (value & DYN_SOURCE_DW) {
    names.push('Dynamic World');
  }

  if (value & DYN_SOURCE_HLS_LANDSAT) {
    names.push('HLS Landsat');
  }

  if (value & DYN_SOURCE_HLS_SENTINEL2) {
    names.push('HLS Sentinel-2');
  }

  if (value & DYN_SOURCE_S1) {
    names.push('OPERA S1');
  }

  return names.join(' + ');
}

function dynRenderLegend(metricLabel) {
  dynBuildLegendPanel();
  dynLegendContentPanel.clear();

  var entry = dynLegendMetricSpecs[metricLabel];

  if (!entry) {
    dynLegendContentPanel.add(ui.Label(
      'Run the analysis and select a generated product to display its legend.'
    ));
    return;
  }

  dynLegendContentPanel.add(ui.Label({
    value: entry.label,
    style: {
      fontWeight: 'bold',
      fontSize: '13px',
      margin: '0 0 5px 0'
    }
  }));

  if (entry.type === 'SOURCE') {
    dynLegendContentPanel.add(ui.Label(
      'The value is an additive source bitmask. Each colour identifies the source combination supporting the selected detection.'
    ));

    for (var value = 1; value <= 15; value++) {
      dynLegendContentPanel.add(dynMakeLegendRow(
        DYN_SOURCE_VIS.palette[value - 1],
        value + ': ' + dynSourceCombinationName(value)
      ));
    }

    dynLegendContentPanel.add(ui.Label({
      value: 'Bits: 1=DW, 2=HLS Landsat, 4=HLS Sentinel-2, 8=OPERA S1.',
      style: {fontSize: '10px', color: '#555555', margin: '4px 0 0 0'}
    }));
    return;
  }

  if (entry.type === 'EPISODES') {
    dynLegendContentPanel.add(ui.Label(
      'Number of distinct selected-water episodes using the configured maximum temporal gap.'
    ));

    DYN_EPISODE_VIS.palette.forEach(function(color, index) {
      var valueLabel = index === DYN_EPISODE_VIS.palette.length - 1 ?
        '6 or more episodes' : String(index + 1) + ' episode' + (index === 0 ? '' : 's');
      dynLegendContentPanel.add(dynMakeLegendRow(color, valueLabel));
    });

    dynLegendContentPanel.add(ui.Label({
      value: 'Values above 6 use the darkest display colour; exported values remain unchanged.',
      style: {fontSize: '10px', color: '#555555', margin: '4px 0 0 0'}
    }));
    return;
  }

  if (entry.type === 'ANALYSIS_DAY_SPLIT') {
    dynRenderSplitTimingLegend(entry);
    return;
  }

  var spec = dynContinuousLegendSpec(entry.type, entry);
  dynLegendContentPanel.add(ui.Label(spec.description));
  dynLegendContentPanel.add(dynMakeContinuousBar(spec.palette));
  dynLegendContentPanel.add(dynMakeTickPanel(spec.ticks));
  dynLegendContentPanel.add(ui.Label({
    value: spec.note,
    style: {fontSize: '10px', color: '#555555', margin: '3px 0 0 0'}
  }));
}

function dynSetLegendVisibility(shown) {
  dynBuildLegendPanel();

  if (shown && dynInspectorVisible) {
    dynSetInspectorVisibility(false, false);
  }

  dynLegendPanel.style().set('shown', Boolean(shown));

  if (shown && dynamicsLegendMetricSelect !== null) {
    dynRenderLegend(dynamicsLegendMetricSelect.getValue());
  }
}

function dynBuildLegendPanel() {
  if (dynLegendPanel !== null) {
    return;
  }

  var hideButton = ui.Button({
    label: 'Hide',
    style: {margin: '0 0 0 8px'},
    onClick: function() {
      if (dynamicsShowLegend !== null) {
        dynamicsShowLegend.setValue(false, false);
      }
      dynSetLegendVisibility(false);
    }
  });

  dynLegendContentPanel = ui.Panel();

  dynLegendPanel = ui.Panel({
    style: {
      position: 'bottom-right',
      width: '350px',
      maxHeight: '540px',
      padding: '8px',
      backgroundColor: '#FFFFFF',
      border: '1px solid #777777',
      shown: false
    }
  });

  dynLegendPanel.add(ui.Panel({
    widgets: [
      ui.Label({
        value: 'Metric legend',
        style: {
          fontWeight: 'bold',
          fontSize: '14px',
          stretch: 'horizontal'
        }
      }),
      hideButton
    ],
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {stretch: 'horizontal', margin: '0 0 5px 0'}
  }));

  dynLegendPanel.add(dynLegendContentPanel);
}

function dynUpdateLegendOptions(entries) {
  dynLegendMetricSpecs = {};
  dynLegendMetricOrder = [];

  entries.forEach(function(entry) {
    dynLegendMetricSpecs[entry.label] = entry;
    dynLegendMetricOrder.push(entry.label);
  });

  if (dynamicsLegendMetricSelect === null) {
    return;
  }

  dynamicsLegendMetricSelect.items().reset(dynLegendMetricOrder);
  dynamicsLegendMetricSelect.setDisabled(dynLegendMetricOrder.length === 0);

  if (dynLegendMetricOrder.length === 0) {
    dynSetLegendVisibility(false);
    return;
  }

  dynSynchronizingProductSelectors = true;
  dynamicsLegendMetricSelect.setValue(dynLegendMetricOrder[0], false);
  dynSynchronizingProductSelectors = false;
  dynRenderLegend(dynLegendMetricOrder[0]);

  if (dynamicsShowLegend !== null && dynamicsShowLegend.getValue()) {
    dynSetLegendVisibility(true);
  }
}

function dynHideAllPreviewLayersExcept(metricLabel) {
  dynPreviewProductOrder.forEach(function(label) {
    var layer = dynPreviewLayers[label];
    if (layer !== null && layer !== undefined) {
      layer.setShown(label === metricLabel);
    }
  });
}

function dynConfigureTimingPreview(entry, mode) {
  if (!entry || !entry.image || !entry.periodDays) {
    return entry;
  }

  entry.timingVisMode = mode;

  if (mode === DYN_TIMING_VIS_SPLIT) {
    var splitDay = entry.firstHalfEndDay;
    var raw = ee.Image(entry.image);

    var firstHalfRgb = raw
      .updateMask(raw.lte(splitDay))
      .visualize({
        min: 1,
        max: splitDay,
        palette: DYN_TIMING_FIRST_HALF_PALETTE
      });

    var secondHalfRgb = raw
      .updateMask(raw.gt(splitDay))
      .visualize({
        min: splitDay + 1,
        max: entry.periodDays,
        palette: DYN_TIMING_SECOND_HALF_PALETTE
      });

    entry.previewImage = ee.ImageCollection([
      firstHalfRgb,
      secondHalfRgb
    ]).mosaic();
    entry.previewVis = {};
    entry.type = 'ANALYSIS_DAY_SPLIT';
    return entry;
  }

  entry.previewImage = entry.image;
  entry.previewVis = dynTimingContinuousVis(
    entry.periodDays,
    mode === DYN_TIMING_VIS_MULTIHUE ?
      DYN_TIMING_MULTIHUE_PALETTE : DYN_ANALYSIS_DAY_VIS.palette
  );
  entry.type = 'ANALYSIS_DAY';
  return entry;
}

function dynRefreshTimingPreviews() {
  if (typeof dynamicsTimingVis === 'undefined' ||
      dynamicsTimingVis === null) {
    return;
  }

  var mode = dynamicsTimingVis.getValue();
  var updatedLabels = [];

  dynPreviewProductOrder.forEach(function(label) {
    var entry = dynPreviewProducts[label];
    if (!entry || !entry.isAnalysisDayTiming) {
      return;
    }

    dynConfigureTimingPreview(entry, mode);

    var layer = dynPreviewLayers[label];
    if (layer) {
      layer.setEeObject(entry.previewImage || entry.image);
      layer.setVisParams(entry.previewVis || entry.vis);
    }

    dynLegendMetricSpecs[label] = entry;
    updatedLabels.push(label);
  });

  if (
    updatedLabels.length > 0 &&
    dynamicsLegendMetricSelect !== null &&
    updatedLabels.indexOf(dynamicsLegendMetricSelect.getValue()) !== -1
  ) {
    dynRenderLegend(dynamicsLegendMetricSelect.getValue());
  }

  dynSetStatus(
    updatedLabels.length > 0 ?
      'Updated ' + updatedLabels.length + ' analysis-day timing preview ' +
      (updatedLabels.length === 1 ? 'layer' : 'layers') + ' to: ' + mode +
      '. Exported metric values are unchanged.' :
      'Timing colour scheme set to: ' + mode +
      '. Select and run at least one analysis-day timing metric to preview it.'
  );
}

function dynRegisterPreviewProducts(entries) {
  dynPreviewProducts = {};
  dynPreviewProductOrder = [];
  dynPreviewLayers = {};
  dynCurrentPreviewLabel = null;

  entries.forEach(function(entry, index) {
    dynPreviewProducts[entry.label] = entry;
    dynPreviewProductOrder.push(entry.label);

    // Add every checked product to the Layers panel. Only the first product is
    // visible initially. Hidden ui.Map.Layer objects are not requested until
    // the user turns them on, reproducing the working v4.2 behaviour.
    var layer = ui.Map.Layer(
      entry.previewImage || entry.image,
      entry.previewVis || entry.vis,
      entry.label,
      index === 0,
      1
    );
    dynPreviewLayers[entry.label] = layer;
    Map.layers().add(layer);

    if (index === 0) {
      dynCurrentPreviewLabel = entry.label;
    }
  });

  if (dynamicsPreviewMetricSelect === null) {
    return;
  }

  dynamicsPreviewMetricSelect.items().reset(dynPreviewProductOrder);
  var hasProducts = dynPreviewProductOrder.length > 0;
  dynamicsPreviewMetricSelect.setDisabled(!hasProducts);

  if (dynamicsLoadPreviewButton !== null) {
    dynamicsLoadPreviewButton.setDisabled(!hasProducts);
  }

  if (hasProducts) {
    dynSynchronizingProductSelectors = true;
    dynamicsPreviewMetricSelect.setValue(
      dynPreviewProductOrder[0],
      false
    );
    dynSynchronizingProductSelectors = false;
  }
}

function dynLoadPreviewProduct(metricLabel, updateStatus) {
  if (
    !metricLabel ||
    !dynPreviewProducts[metricLabel] ||
    !dynPreviewLayers[metricLabel]
  ) {
    if (updateStatus !== false) {
      dynSetStatus('Choose a generated product before loading a preview.');
    }
    return;
  }

  // The layers already exist in the Layers panel. The selector simply shows
  // the requested product and hides the other generated products. Users can
  // still manually enable several layers from the Layers panel if desired.
  dynHideAllPreviewLayersExcept(metricLabel);
  dynCurrentPreviewLabel = metricLabel;

  // Keep the clicked-point marker above the generated metric layers.
  if (dynInspectorPoint !== null) {
    dynShowInspectorPoint(dynInspectorPoint);
  }

  dynSynchronizingProductSelectors = true;

  if (dynamicsPreviewMetricSelect !== null) {
    dynamicsPreviewMetricSelect.setValue(metricLabel, false);
  }

  if (dynamicsLegendMetricSelect !== null) {
    dynamicsLegendMetricSelect.setValue(metricLabel, false);
  }

  dynSynchronizingProductSelectors = false;
  dynRenderLegend(metricLabel);

  if (updateStatus !== false) {
    dynSetStatus(
      'Showing map product: ' + metricLabel + '. All checked products remain ' +
      'available as separate entries in the Layers panel.'
    );
  }
}

function dynLoadSelectedPreviewProduct() {
  if (dynamicsPreviewMetricSelect === null) {
    return;
  }
  dynLoadPreviewProduct(dynamicsPreviewMetricSelect.getValue(), true);
}

// ------------------------------------------------------
// Hydrological-period dynamics UI
// ------------------------------------------------------

// Outer application panel. The three module panels are added once and are
// shown/hidden in place. This avoids re-parenting widgets and provides a clean
// structure for adding further modules in future versions.
var dynamicsPanel = ui.Panel({layout: ui.Panel.Layout.flow('vertical')});
var dynamicsAnalysisPanel = ui.Panel({layout: ui.Panel.Layout.flow('vertical')});
var dynamicsVisualizationPanel = ui.Panel({layout: ui.Panel.Layout.flow('vertical')});
var dynamicsExportPanel = ui.Panel({layout: ui.Panel.Layout.flow('vertical')});

var DYN_UI_VIEWS = [
  'Analysis',
  'Visualization',
  'Export'
];
var dynUiView = 'Analysis';
var dynUiViewPanels = {
  Analysis: dynamicsAnalysisPanel,
  Visualization: dynamicsVisualizationPanel,
  Export: dynamicsExportPanel
};
var dynUiViewButtons = {};

function dynSetUiView(viewName) {
  if (!dynUiViewPanels[viewName]) {
    return;
  }

  dynUiView = viewName;

  DYN_UI_VIEWS.forEach(function(name) {
    dynUiViewPanels[name].style().set('shown', name === viewName);

    if (dynUiViewButtons[name]) {
      // The active tab is disabled, which gives a clear visual indication of
      // the current view without moving or recreating any widget.
      dynUiViewButtons[name].setDisabled(name === viewName);
    }
  });
}

function dynCreateUiViewButton(viewName) {
  var button = ui.Button({
    label: viewName,
    style: {
      margin: '0 4px 0 0',
      padding: '0 6px'
    },
    onClick: function() {
      dynSetUiView(viewName);
    }
  });

  dynUiViewButtons[viewName] = button;
  return button;
}

dynamicsPanel.add(ui.Label({
  value: 'Hydrological-period water and inundation dynamics',
  style: {
    fontWeight: 'bold',
    margin: '8px 0 4px 0'
  }
}));

dynamicsPanel.add(ui.Label(
  'Configure and run the analysis, inspect generated products, and create ' +
  'exports from separate tabs. Water-class fusion is unchanged; timing is ' +
  'referenced to the selected period so cross-calendar hydrological years are valid.'
));

dynProgressLabel = ui.Label({
  value: 'Ready. Select an AOI, configure the analysis and press Run.',
  style: {
    margin: '6px 0 6px 0',
    padding: '5px',
    backgroundColor: 'F3F6F9',
    color: '34495E'
  }
});

dynamicsPanel.add(dynProgressLabel);

var dynamicsViewBar = ui.Panel({
  layout: ui.Panel.Layout.flow('horizontal'),
  style: {margin: '2px 0 8px 0'}
});

DYN_UI_VIEWS.forEach(function(viewName) {
  dynamicsViewBar.add(dynCreateUiViewButton(viewName));
});

dynamicsPanel.add(dynamicsViewBar);

// Fixed module panels: add each one exactly once, then only toggle `shown`.
dynamicsPanel.add(dynamicsAnalysisPanel);
dynamicsPanel.add(dynamicsVisualizationPanel);
dynamicsPanel.add(dynamicsExportPanel);
dynSetUiView('Analysis');

// ------------------------------------------------------
// AOI controls: no default AOI is ever used
// ------------------------------------------------------

dynamicsAnalysisPanel.add(ui.Label({
  value: 'Analysis configuration',
  style: {fontWeight: 'bold', fontSize: '14px', margin: '2px 0 4px 0'}
}));
dynamicsAnalysisPanel.add(ui.Label(
  'Choose the AOI, classes, sources, hydrological period and output metrics, then run the analysis.'
));

dynamicsAnalysisPanel.add(ui.Label({
  value: '1. Area of interest',
  style: {
    fontWeight: 'bold',
    margin: '10px 0 3px 0'
  }
}));

dynamicsAnalysisPanel.add(ui.Label(
  'Draw a rectangle or polygon. The analysis will not run without a ' +
  'user-selected AOI.'
));

var dynDrawRectangleButton = ui.Button({
  label: 'Draw rectangle',
  onClick: function() {
    dynStartDrawing('rectangle');
  }
});

var dynDrawPolygonButton = ui.Button({
  label: 'Draw polygon',
  onClick: function() {
    dynStartDrawing('polygon');
  }
});

var dynClearAoiButton = ui.Button({
  label: 'Clear AOI',
  onClick: dynClearAoi
});

dynamicsAnalysisPanel.add(ui.Panel([
  dynDrawRectangleButton,
  dynDrawPolygonButton,
  dynClearAoiButton
], ui.Panel.Layout.flow('horizontal')));

// ------------------------------------------------------
// Water-related class selection
// ------------------------------------------------------

dynamicsAnalysisPanel.add(ui.Label({
  value: '2. Water-related classes',
  style: {
    fontWeight: 'bold',
    margin: '10px 0 3px 0'
  }
}));

dynamicsAnalysisPanel.add(ui.Label(
  'The preset updates all class checkboxes. You can then adjust individual ' +
  'source classes. Open water is the default.'
));

var dynamicsClassPreset = ui.Select({
  items: [
    'Open water only',
    'Inundated / partial water only',
    'All water-related classes'
  ],
  value: 'Open water only',
  style: {stretch: 'horizontal'}
});

dynamicsAnalysisPanel.add(ui.Panel([
  ui.Label('Class preset:'),
  dynamicsClassPreset
], ui.Panel.Layout.flow('horizontal')));

dynamicsAnalysisPanel.add(ui.Label({
  value: 'Dynamic World',
  style: {
    fontWeight: 'bold',
    margin: '8px 0 2px 0'
  }
}));

var dynamicsUseDw = ui.Checkbox({
  label: 'Use Dynamic World',
  value: true
});

var dynamicsDwWater = ui.Checkbox({
  label: 'Class 0: water',
  value: true
});

var dynamicsDwFloodedVeg = ui.Checkbox({
  label: 'Class 3: flooded vegetation',
  value: false
});

dynamicsAnalysisPanel.add(dynamicsUseDw);
dynamicsAnalysisPanel.add(ui.Panel([
  dynamicsDwWater,
  dynamicsDwFloodedVeg
], ui.Panel.Layout.flow('vertical'), {margin: '0 0 0 18px'}));

dynamicsAnalysisPanel.add(ui.Label({
  value: 'OPERA DSWx-HLS',
  style: {
    fontWeight: 'bold',
    margin: '8px 0 2px 0'
  }
}));

var dynamicsUseHls = ui.Checkbox({
  label: 'Use OPERA DSWx-HLS',
  value: true
});

var dynamicsUseHlsLandsat = ui.Checkbox({
  label: 'Use HLS Landsat (SPACECRAFT_NAME = Landsat-*)',
  value: true
});

var dynamicsUseHlsSentinel2 = ui.Checkbox({
  label: 'Use HLS Sentinel-2 (SPACECRAFT_NAME = Sentinel-2*)',
  value: true
});

var dynamicsHlsMsiGapFill = ui.Checkbox({
  label: 'Restrict HLS Sentinel-2 to pixels with invalid same-day DW (recommended)',
  value: true
});

var dynamicsHlsOpen = ui.Checkbox({
  label: 'Class 1: open water',
  value: true
});

var dynamicsHlsPartial = ui.Checkbox({
  label: 'Class 2: partial surface water',
  value: false
});

dynamicsAnalysisPanel.add(dynamicsUseHls);
dynamicsAnalysisPanel.add(ui.Panel([
  dynamicsUseHlsLandsat,
  dynamicsUseHlsSentinel2,
  dynamicsHlsMsiGapFill,
  dynamicsHlsOpen,
  dynamicsHlsPartial
], ui.Panel.Layout.flow('vertical'), {margin: '0 0 0 18px'}));

dynamicsAnalysisPanel.add(ui.Label({
  value: 'OPERA DSWx-S1',
  style: {
    fontWeight: 'bold',
    margin: '8px 0 2px 0'
  }
}));

var dynamicsUseS1 = ui.Checkbox({
  label: 'Use OPERA DSWx-S1',
  value: true
});

var dynamicsS1Open = ui.Checkbox({
  label: 'Class 1: open water',
  value: true
});

var dynamicsS1InundatedVeg = ui.Checkbox({
  label: 'Class 3: inundated vegetation',
  value: false
});

dynamicsAnalysisPanel.add(dynamicsUseS1);
dynamicsAnalysisPanel.add(ui.Panel([
  dynamicsS1Open,
  dynamicsS1InundatedVeg
], ui.Panel.Layout.flow('vertical'), {margin: '0 0 0 18px'}));
dynamicsAnalysisPanel.add(ui.Label({
  value: 'Class 0 (not water) is always counted as a valid non-water observation. ' +
    'Classes 250, 251 and 254 remain invalid/masked.',
  style: {margin: '2px 0 4px 18px', color: '555555'}
}));

var dynamicsSameDayFusion = ui.Select({
  items: [
    DYN_FUSION_ANY_WATER,
    DYN_FUSION_PRIORITY
  ],
  value: DYN_FUSION_ANY_WATER,
  style: {stretch: 'horizontal'}
});

dynamicsAnalysisPanel.add(ui.Panel([
  ui.Label('Same-day fusion:'),
  dynamicsSameDayFusion
], ui.Panel.Layout.flow('vertical')));

dynamicsAnalysisPanel.add(ui.Label(
  'Only liquid-water/inundation classes are offered as targets. All ' +
  'unmasked Dynamic World labels count as valid support. HLS classes 0/1/2 ' +
  'and S1 classes 0/1/3 are valid; product mask classes remain excluded. ' +
  'HLS platforms are assigned primarily from SPACECRAFT_NAME and independently ' +
  'checked against the final system:index platform token. SENSOR is diagnostic ' +
  'only and cannot move a Sentinel-2 asset into the Landsat branch. HLS ' +
  'Sentinel-2 is enabled by default but restricted to same-day DW pixel gaps; ' +
  'untick that restriction to use all platform-identified Sentinel-2 observations. ' +
  'Use the pixel inspector HLS verification mode to see exact metadata and asset IDs.'
));

function applyDynamicsClassPreset(preset) {
  var selectOpen = preset === 'Open water only' ||
    preset === 'All water-related classes';

  var selectPartial = preset === 'Inundated / partial water only' ||
    preset === 'All water-related classes';

  dynamicsDwWater.setValue(selectOpen);
  dynamicsHlsOpen.setValue(selectOpen);
  dynamicsS1Open.setValue(selectOpen);

  dynamicsDwFloodedVeg.setValue(selectPartial);
  dynamicsHlsPartial.setValue(selectPartial);
  dynamicsS1InundatedVeg.setValue(selectPartial);
}

function getDynamicsClassOptions() {
  return {
    dwWater: dynamicsDwWater.getValue(),
    dwFloodedVeg: dynamicsDwFloodedVeg.getValue(),
    hlsOpen: dynamicsHlsOpen.getValue(),
    hlsPartial: dynamicsHlsPartial.getValue(),
    s1Open: dynamicsS1Open.getValue(),
    s1InundatedVeg: dynamicsS1InundatedVeg.getValue()
  };
}

function dynHasOpenClass(sourceOptions, classOptions) {
  return (
    sourceOptions.useDw && classOptions.dwWater
  ) || (
    (sourceOptions.useHlsLandsat || sourceOptions.useHlsSentinel2) &&
    classOptions.hlsOpen
  ) || (
    sourceOptions.useS1 && classOptions.s1Open
  );
}

function dynHasPartialClass(sourceOptions, classOptions) {
  return (
    sourceOptions.useDw && classOptions.dwFloodedVeg
  ) || (
    (sourceOptions.useHlsLandsat || sourceOptions.useHlsSentinel2) &&
    classOptions.hlsPartial
  ) || (
    sourceOptions.useS1 && classOptions.s1InundatedVeg
  );
}

dynamicsClassPreset.onChange(applyDynamicsClassPreset);

// ------------------------------------------------------
// Hydrological analysis period and episode definition
// ------------------------------------------------------

var DYN_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

dynamicsAnalysisPanel.add(ui.Label({
  value: '3. Hydrological period and episode settings',
  style: {
    fontWeight: 'bold',
    margin: '10px 0 3px 0'
  }
}));

var dynamicsStartMonthSelect = ui.Select({
  items: DYN_MONTH_NAMES,
  value: 'November',
  style: {width: '115px'}
});

var dynamicsStartYearBox = ui.Textbox({
  placeholder: 'YYYY',
  value: '2024',
  style: {width: '70px'}
});

var dynamicsEndMonthSelect = ui.Select({
  items: DYN_MONTH_NAMES,
  value: 'October',
  style: {width: '115px'}
});

var dynamicsEndYearBox = ui.Textbox({
  placeholder: 'YYYY',
  value: '2025',
  style: {width: '70px'}
});

var dynamicsMaxGapBox = ui.Textbox({
  placeholder: 'Days',
  value: '20',
  style: {width: '70px'}
});

function dynMonthNumber(monthName) {
  return DYN_MONTH_NAMES.indexOf(monthName) + 1;
}

function dynReadPeriodConfig() {
  var startMonth = dynMonthNumber(dynamicsStartMonthSelect.getValue());
  var endMonth = dynMonthNumber(dynamicsEndMonthSelect.getValue());
  var startYear = Number(dynamicsStartYearBox.getValue());
  var endYear = Number(dynamicsEndYearBox.getValue());

  if (
    !startMonth || !endMonth || !startYear || !endYear ||
    startYear < 2015 || endYear < 2015 ||
    startYear > 2100 || endYear > 2100
  ) {
    return {error: 'Enter valid start/end months and years (2015–2100).'};
  }

  var startMillis = Date.UTC(startYear, startMonth - 1, 1);
  // End month is inclusive, so the Earth Engine end date is the first day of
  // the following month because filterDate() uses an exclusive upper bound.
  var endExclusiveMillis = Date.UTC(endYear, endMonth, 1);
  var periodDays = Math.round(
    (endExclusiveMillis - startMillis) / 86400000
  );
  var periodMonths = (endYear - startYear) * 12 +
    (endMonth - startMonth) + 1;

  if (periodDays <= 0 || periodMonths <= 0) {
    return {error: 'The end month must be after the start month.'};
  }

  // The metric set is designed for one hydrological year. Shorter full-month
  // windows are allowed for testing, but windows longer than 12 months are
  // rejected so duration/count legends and annual interpretation remain clear.
  if (periodMonths > 12) {
    return {error: 'Select at most 12 full calendar months for one hydrological year.'};
  }

  var firstHalfMonths = periodMonths >= 2 ? Math.ceil(periodMonths / 2) : 0;
  var splitMillis = firstHalfMonths > 0 ?
    Date.UTC(startYear, startMonth - 1 + firstHalfMonths, 1) :
    startMillis + Math.floor(periodDays / 2) * 86400000;
  var firstHalfEndDay = Math.max(
    1,
    Math.min(periodDays - 1, Math.round((splitMillis - startMillis) / 86400000))
  );

  var shortMonths = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];
  var displayLabel = shortMonths[startMonth - 1] + ' ' + startYear +
    ' – ' + shortMonths[endMonth - 1] + ' ' + endYear;
  function twoDigit(value) {
    return value < 10 ? '0' + value : String(value);
  }
  var fileLabel = startYear + '_' + twoDigit(startMonth) +
    '_to_' + endYear + '_' + twoDigit(endMonth);

  return {
    startYear: startYear,
    startMonth: startMonth,
    endYear: endYear,
    endMonth: endMonth,
    startMillis: startMillis,
    endExclusiveMillis: endExclusiveMillis,
    start: ee.Date.fromYMD(startYear, startMonth, 1),
    end: ee.Date.fromYMD(endYear, endMonth, 1).advance(1, 'month'),
    periodDays: periodDays,
    periodMonths: periodMonths,
    firstHalfEndDay: firstHalfEndDay,
    displayLabel: displayLabel,
    fileLabel: fileLabel
  };
}

dynamicsAnalysisPanel.add(ui.Panel([
  ui.Label('Start:'),
  dynamicsStartMonthSelect,
  dynamicsStartYearBox
], ui.Panel.Layout.flow('horizontal')));

dynamicsAnalysisPanel.add(ui.Panel([
  ui.Label('End (inclusive):'),
  dynamicsEndMonthSelect,
  dynamicsEndYearBox
], ui.Panel.Layout.flow('horizontal')));

dynamicsAnalysisPanel.add(ui.Panel([
  ui.Label('Max gap within one episode:'),
  dynamicsMaxGapBox
], ui.Panel.Layout.flow('horizontal')));

dynamicsAnalysisPanel.add(ui.Label({
  value: 'Default hydrological year: November 2024 through October 2025. ' +
    'The timing outputs use analysis day 1 = the first day of the selected period.',
  style: {fontSize: '10px', color: '#555555', whiteSpace: 'normal'}
}));

dynamicsAnalysisPanel.add(ui.Label({
  value: 'Timing metrics',
  style: {
    fontWeight: 'bold',
    margin: '10px 0 2px 0'
  }
}));

var dynFirstWet = ui.Checkbox({
  label: 'First observed selected-water day (analysis day)',
  value: true
});

var dynLastWet = ui.Checkbox({
  label: 'Last selected water-class day (analysis day)',
  value: false
});

var dynFirstDryAfterWet = ui.Checkbox({
  label: 'First dry day after final selected detection (analysis day)',
  value: false
});

var dynFirstOpen = ui.Checkbox({
  label: 'First observed open-water day (analysis day)',
  value: false
});

var dynLastOpen = ui.Checkbox({
  label: 'Last observed open-water day (analysis day)',
  value: false
});

var dynFirstPartial = ui.Checkbox({
  label: 'First observed inundated/partial day (analysis day)',
  value: false
});

var dynLastPartial = ui.Checkbox({
  label: 'Last observed inundated/partial day (analysis day)',
  value: false
});

var dynOpenToPartialLag = ui.Checkbox({
  label: 'Lag: first open water → first inundated/partial (days)',
  value: false
});

dynamicsAnalysisPanel.add(dynFirstWet);
dynamicsAnalysisPanel.add(dynLastWet);
dynamicsAnalysisPanel.add(dynFirstDryAfterWet);
dynamicsAnalysisPanel.add(dynFirstOpen);
dynamicsAnalysisPanel.add(dynLastOpen);
dynamicsAnalysisPanel.add(dynFirstPartial);
dynamicsAnalysisPanel.add(dynLastPartial);
dynamicsAnalysisPanel.add(dynOpenToPartialLag);

dynamicsAnalysisPanel.add(ui.Label({
  value: 'Duration, frequency and episode metrics',
  style: {
    fontWeight: 'bold',
    margin: '10px 0 2px 0'
  }
}));

var dynWetSpan = ui.Checkbox({
  label: 'Observed selected-class span: first to last detection',
  value: false
});

var dynOpenSpan = ui.Checkbox({
  label: 'Observed open-water span: first to last open day',
  value: false
});

var dynPartialSpan = ui.Checkbox({
  label: 'Observed inundated/partial span',
  value: false
});

var dynWetCount = ui.Checkbox({
  label: 'Number of selected-class observations',
  value: false
});

var dynWetFraction = ui.Checkbox({
  label: 'Selected-class fraction of valid observations',
  value: false
});

var dynEpisodes = ui.Checkbox({
  label: 'Observed selected-class episodes',
  value: false
});

var dynLongestSpell = ui.Checkbox({
  label: 'Longest gap-aware selected-class spell (days)',
  value: false
});

dynamicsAnalysisPanel.add(dynWetSpan);
dynamicsAnalysisPanel.add(dynOpenSpan);
dynamicsAnalysisPanel.add(dynPartialSpan);
dynamicsAnalysisPanel.add(dynWetCount);
dynamicsAnalysisPanel.add(dynWetFraction);
dynamicsAnalysisPanel.add(dynEpisodes);
dynamicsAnalysisPanel.add(dynLongestSpell);

dynamicsAnalysisPanel.add(ui.Label({
  value: 'Data-support and provenance metrics',
  style: {
    fontWeight: 'bold',
    margin: '10px 0 2px 0'
  }
}));

var dynValidCount = ui.Checkbox({
  label: 'Fused valid observation-date count',
  value: false
});

var dynDwValidCount = ui.Checkbox({
  label: 'DW-supported valid date count',
  value: false
});

var dynHlsLandsatValidCount = ui.Checkbox({
  label: 'HLS Landsat-supported valid date count',
  value: false
});

var dynHlsSentinel2ValidCount = ui.Checkbox({
  label: 'HLS Sentinel-2-supported valid date count',
  value: false
});

var dynS1ValidCount = ui.Checkbox({
  label: 'OPERA-S1-supported valid date count',
  value: false
});

var dynFirstWetSource = ui.Checkbox({
  label: 'Source mask of first selected detection',
  value: false
});

var dynLastWetSource = ui.Checkbox({
  label: 'Source mask of last selected detection',
  value: false
});

var dynMaximumGap = ui.Checkbox({
  label: 'Maximum interval between valid observations (days)',
  value: false
});

var dynConflictCount = ui.Checkbox({
  label: 'Number of same-day wet/dry conflicts',
  value: false
});

dynamicsAnalysisPanel.add(dynValidCount);
dynamicsAnalysisPanel.add(ui.Panel([
  dynDwValidCount,
  dynHlsLandsatValidCount,
  dynHlsSentinel2ValidCount,
  dynS1ValidCount
], ui.Panel.Layout.flow('vertical'), {margin: '0 0 0 18px'}));
dynamicsAnalysisPanel.add(ui.Label({
  value: 'Per-source counts are fused calendar dates supported by that source. ' +
    'Their sum can exceed the fused count when sources coincide on a date.',
  style: {margin: '2px 0 4px 18px', color: '555555'}
}));


var dynShowCoverageDiagnosticOptions = ui.Checkbox({
  label: 'Show raw coverage and mask diagnostic metric options',
  value: false
});

var dynCoverageDiagnosticOptionsPanel = ui.Panel({
  style: {
    shown: false,
    margin: '2px 0 5px 18px',
    padding: '4px',
    border: '1px solid #CCCCCC'
  }
});

dynShowCoverageDiagnosticOptions.onChange(function(shown) {
  dynCoverageDiagnosticOptionsPanel.style().set('shown', shown);
});

var dynDwAssetFootprintCount = ui.Checkbox({
  label: 'DW raw asset-footprint date count', value: false
});
var dynDwMaskedNoValueCount = ui.Checkbox({
  label: 'DW asset date with masked/no label count', value: false
});

var dynHlsLandsatAssetFootprintCount = ui.Checkbox({
  label: 'HLS Landsat raw asset-footprint date count', value: false
});
var dynHlsLandsatProductValueCount = ui.Checkbox({
  label: 'HLS Landsat unmasked product-value date count', value: false
});
var dynHlsLandsatRawUsableCount = ui.Checkbox({
  label: 'HLS Landsat raw usable water-state date count', value: false
});
var dynHlsLandsatExcludedCount = ui.Checkbox({
  label: 'HLS Landsat excluded/unusable date count', value: false
});
var dynHlsLandsatNotWaterCount = ui.Checkbox({
  label: 'HLS Landsat class 0 not-water date count', value: false
});
var dynHlsLandsatSnowMaskCount = ui.Checkbox({
  label: 'HLS Landsat class 252 snow/ice date count', value: false
});
var dynHlsLandsatCloudMaskCount = ui.Checkbox({
  label: 'HLS Landsat class 253 cloud/shadow date count', value: false
});
var dynHlsLandsatOceanMaskCount = ui.Checkbox({
  label: 'HLS Landsat class 254 ocean-mask date count', value: false
});
var dynHlsLandsatMaskedNoValueCount = ui.Checkbox({
  label: 'HLS Landsat masked/no-value date count', value: false
});

var dynHlsSentinel2AssetFootprintCount = ui.Checkbox({
  label: 'HLS Sentinel-2 raw asset-footprint date count', value: false
});
var dynHlsSentinel2ProductValueCount = ui.Checkbox({
  label: 'HLS Sentinel-2 unmasked product-value date count', value: false
});
var dynHlsSentinel2RawUsableCount = ui.Checkbox({
  label: 'HLS Sentinel-2 raw usable water-state date count', value: false
});
var dynHlsSentinel2ExcludedCount = ui.Checkbox({
  label: 'HLS Sentinel-2 excluded/unusable date count', value: false
});
var dynHlsSentinel2NotWaterCount = ui.Checkbox({
  label: 'HLS Sentinel-2 class 0 not-water date count', value: false
});
var dynHlsSentinel2SnowMaskCount = ui.Checkbox({
  label: 'HLS Sentinel-2 class 252 snow/ice date count', value: false
});
var dynHlsSentinel2CloudMaskCount = ui.Checkbox({
  label: 'HLS Sentinel-2 class 253 cloud/shadow date count', value: false
});
var dynHlsSentinel2OceanMaskCount = ui.Checkbox({
  label: 'HLS Sentinel-2 class 254 ocean-mask date count', value: false
});
var dynHlsSentinel2MaskedNoValueCount = ui.Checkbox({
  label: 'HLS Sentinel-2 masked/no-value date count', value: false
});

var dynS1AssetFootprintCount = ui.Checkbox({
  label: 'OPERA-S1 raw asset-footprint date count', value: false
});
var dynS1ProductValueCount = ui.Checkbox({
  label: 'OPERA-S1 unmasked product-value date count', value: false
});
var dynS1RawUsableCount = ui.Checkbox({
  label: 'OPERA-S1 raw usable water-state date count', value: false
});
var dynS1ExcludedCount = ui.Checkbox({
  label: 'OPERA-S1 excluded/unusable date count', value: false
});
var dynS1NotWaterCount = ui.Checkbox({
  label: 'OPERA-S1 class 0 not-water date count', value: false
});
var dynS1HandMaskCount = ui.Checkbox({
  label: 'OPERA-S1 class 250 HAND-mask date count', value: false
});
var dynS1LayoverMaskCount = ui.Checkbox({
  label: 'OPERA-S1 class 251 layover/shadow date count', value: false
});
var dynS1OceanMaskCount = ui.Checkbox({
  label: 'OPERA-S1 class 254 ocean-mask date count', value: false
});
var dynS1MaskedNoValueCount = ui.Checkbox({
  label: 'OPERA-S1 masked/no-value date count', value: false
});

var dynDwDiagnosticCheckboxes = [
  dynDwAssetFootprintCount,
  dynDwMaskedNoValueCount
];
var dynHlsLandsatDiagnosticCheckboxes = [
  dynHlsLandsatAssetFootprintCount,
  dynHlsLandsatProductValueCount,
  dynHlsLandsatRawUsableCount,
  dynHlsLandsatExcludedCount,
  dynHlsLandsatNotWaterCount,
  dynHlsLandsatSnowMaskCount,
  dynHlsLandsatCloudMaskCount,
  dynHlsLandsatOceanMaskCount,
  dynHlsLandsatMaskedNoValueCount
];
var dynHlsSentinel2DiagnosticCheckboxes = [
  dynHlsSentinel2AssetFootprintCount,
  dynHlsSentinel2ProductValueCount,
  dynHlsSentinel2RawUsableCount,
  dynHlsSentinel2ExcludedCount,
  dynHlsSentinel2NotWaterCount,
  dynHlsSentinel2SnowMaskCount,
  dynHlsSentinel2CloudMaskCount,
  dynHlsSentinel2OceanMaskCount,
  dynHlsSentinel2MaskedNoValueCount
];
var dynS1DiagnosticCheckboxes = [
  dynS1AssetFootprintCount,
  dynS1ProductValueCount,
  dynS1RawUsableCount,
  dynS1ExcludedCount,
  dynS1NotWaterCount,
  dynS1HandMaskCount,
  dynS1LayoverMaskCount,
  dynS1OceanMaskCount,
  dynS1MaskedNoValueCount
];

function dynPanelAddCheckboxGroup(panel, title, checkboxes) {
  panel.add(ui.Label({
    value: title,
    style: {fontWeight: 'bold', margin: '4px 0 1px 0'}
  }));
  checkboxes.forEach(function(checkbox) {
    panel.add(checkbox);
  });
}

dynCoverageDiagnosticOptionsPanel.add(ui.Label({
  value: 'These raw-source counts are independent of the selected target ' +
    'water class. Asset footprint = usable state + excluded/unusable dates. ' +
    'Product-value counts include numeric mask classes.',
  style: {fontSize: '10px', color: '#555555', whiteSpace: 'normal'}
}));
dynPanelAddCheckboxGroup(
  dynCoverageDiagnosticOptionsPanel,
  'Dynamic World',
  dynDwDiagnosticCheckboxes
);
dynPanelAddCheckboxGroup(
  dynCoverageDiagnosticOptionsPanel,
  'HLS Landsat/OLI',
  dynHlsLandsatDiagnosticCheckboxes
);
dynPanelAddCheckboxGroup(
  dynCoverageDiagnosticOptionsPanel,
  'HLS Sentinel-2/MSI',
  dynHlsSentinel2DiagnosticCheckboxes
);
dynPanelAddCheckboxGroup(
  dynCoverageDiagnosticOptionsPanel,
  'OPERA-S1',
  dynS1DiagnosticCheckboxes
);

dynamicsAnalysisPanel.add(dynShowCoverageDiagnosticOptions);
dynamicsAnalysisPanel.add(dynCoverageDiagnosticOptionsPanel);
dynamicsAnalysisPanel.add(dynFirstWetSource);
dynamicsAnalysisPanel.add(dynLastWetSource);
dynamicsAnalysisPanel.add(dynMaximumGap);
dynamicsAnalysisPanel.add(dynConflictCount);

dynamicsVisualizationPanel.add(ui.Label({
  value: 'Visualization and inspection',
  style: {fontWeight: 'bold', fontSize: '14px', margin: '2px 0 4px 0'}
}));
dynamicsVisualizationPanel.add(ui.Label(
  'View products generated by the latest run, control legends, and inspect pixel time series.'
));

var dynamicsTimingVis = ui.Select({
  items: [
    DYN_TIMING_VIS_SPLIT,
    DYN_TIMING_VIS_MULTIHUE,
    DYN_TIMING_VIS_VIRIDIS
  ],
  value: DYN_TIMING_VIS_SPLIT,
  style: {stretch: 'horizontal'},
  onChange: function() {
    dynRefreshTimingPreviews();
  }
});

dynamicsVisualizationPanel.add(ui.Label({
  value: 'Analysis-day timing colour scheme (all timing layers)',
  style: {fontWeight: 'bold', margin: '10px 0 2px 0'}
}));
dynamicsVisualizationPanel.add(dynamicsTimingVis);
dynamicsVisualizationPanel.add(ui.Label({
  value: 'Applied consistently to every generated analysis-day timing layer: first/last selected water, first dry after the final selected detection, first/last open water, and first/last inundated or partial water. Recommended: two independent half-period ramps. The enhanced multi-hue and original Viridis alternatives remain available. Duration, count, fraction, episode, source and conflict layers retain their metric-appropriate palettes.',
  style: {fontSize: '10px', color: '#555555', whiteSpace: 'normal'}
}));

dynamicsVisualizationPanel.add(ui.Label({
  value: 'Generated-product visualization',
  style: {
    fontWeight: 'bold',
    margin: '10px 0 2px 0'
  }
}));

dynamicsPreviewMetricSelect = ui.Select({
  items: [],
  placeholder: 'Run analysis to list checked products',
  disabled: true,
  style: {stretch: 'horizontal'},
  onChange: function(metricLabel) {
    if (dynSynchronizingProductSelectors || !metricLabel) {
      return;
    }
    dynLoadPreviewProduct(metricLabel, true);
  }
});

dynamicsLoadPreviewButton = ui.Button({
  label: 'Show selected product and hide other generated products',
  disabled: true,
  style: {stretch: 'horizontal', margin: '4px 0 2px 0'},
  onClick: dynLoadSelectedPreviewProduct
});

dynamicsVisualizationPanel.add(dynamicsPreviewMetricSelect);
dynamicsVisualizationPanel.add(dynamicsLoadPreviewButton);
dynamicsVisualizationPanel.add(ui.Label(
  'Every checked product from the latest run is added to the Layers panel. ' +
  'The first is visible and the others are hidden. Selecting a product here ' +
  'shows it and hides the other generated products; layers can also be toggled ' +
  'directly in the Layers panel.'
));

dynamicsVisualizationPanel.add(ui.Label({
  value: 'Legend controls',
  style: {
    fontWeight: 'bold',
    margin: '10px 0 2px 0'
  }
}));

dynamicsShowLegend = ui.Checkbox({
  label: 'Show floating legend on the map',
  value: true,
  onChange: function(shown) {
    dynSetLegendVisibility(shown);
  }
});

dynamicsLegendMetricSelect = ui.Select({
  items: [],
  placeholder: 'Run analysis to list generated products',
  disabled: true,
  style: {stretch: 'horizontal'},
  onChange: function(metricLabel) {
    if (dynSynchronizingProductSelectors || !metricLabel) {
      return;
    }

    if (dynPreviewProducts[metricLabel]) {
      dynLoadPreviewProduct(metricLabel, true);
      return;
    }

    dynRenderLegend(metricLabel);
  }
});

dynamicsVisualizationPanel.add(dynamicsShowLegend);
dynamicsVisualizationPanel.add(dynamicsLegendMetricSelect);
dynamicsVisualizationPanel.add(ui.Label(
  'The selector contains only products generated in the latest run. Selecting ' +
  'a product shows its existing Layers-panel entry and updates the legend.'
));

dynamicsVisualizationPanel.add(ui.Label({
  value: 'Pixel temporal inspector',
  style: {
    fontWeight: 'bold',
    margin: '10px 0 2px 0'
  }
}));

dynamicsEnablePixelInspector = ui.Checkbox({
  label: 'Enable click-to-inspect after running',
  value: false,
  onChange: function(enabled) {
    if (enabled) {
      dynSetStatus(
        (lastDynamicsObservations === null && lastDynamicsLazyRunConfig === null) ?
          'Pixel inspector enabled. Run the selected-period analysis, then click a pixel.' :
          'Pixel inspector enabled. Click inside the analysis AOI. A small point-local daily graph is built for each click.'
      );
    } else {
      dynSetInspectorVisibility(false, true);
      dynRemoveInspectorPointLayer();
      dynInspectorPoint = null;
      dynInspectorCoordinates = null;
    }
  }
});

dynamicsVisualizationPanel.add(dynamicsEnablePixelInspector);
dynamicsVisualizationPanel.add(ui.Label(
  'A single hideable chart panel opens only after a map click. It replaces the ' +
  'floating legend while open, so the two overlays never cover the map together.'
));

var runDynamicsButton = ui.Button({
  label: 'Run selected hydrological-period dynamics',
  style: {
    stretch: 'horizontal',
    margin: '10px 0 4px 0'
  },
  onClick: runAnnualDynamics
});

dynamicsAnalysisPanel.add(runDynamicsButton);

dynamicsAnalysisPanel.add(ui.Label(
  'The first checked metric is loaded automatically. Every other checked ' +
  'metric is listed under Generated-product visualization and can replace the ' +
  'current map layer on demand. All checked metrics also remain export bands. ' +
  'The old "First observed wet day" equals the first selected-water day when ' +
  'all water-related classes are selected.'
));

dynamicsExportPanel.add(ui.Label({
  value: 'Export',
  style: {fontWeight: 'bold', fontSize: '14px', margin: '2px 0 4px 0'}
}));
dynamicsExportPanel.add(ui.Label(
  'Create an export task from the products selected in the latest analysis run.'
));

dynamicsExportPanel.add(ui.Label({
  value: 'Export selected metrics',
  style: {
    fontWeight: 'bold',
    margin: '12px 0 2px 0'
  }
}));

var dynamicsExportTarget = ui.Select({
  items: [
    'Google Drive',
    'Earth Engine Asset ImageCollection'
  ],
  value: 'Google Drive',
  style: {stretch: 'horizontal'}
});

var dynamicsDriveFolder = ui.Textbox({
  placeholder: 'Google Drive folder',
  value: 'GEE_hydrological_water_dynamics',
  style: {stretch: 'horizontal'}
});

var dynamicsAssetCollection = ui.Textbox({
  placeholder: 'users/your_user/hydrological_water_dynamics',
  value: 'users/your_user/hydrological_water_dynamics',
  style: {stretch: 'horizontal'}
});

var dynamicsExportScale = ui.Textbox({
  placeholder: 'Scale',
  value: '30',
  style: {width: '80px'}
});

dynamicsExportPanel.add(ui.Panel([
  ui.Label('Target:'),
  dynamicsExportTarget
], ui.Panel.Layout.flow('horizontal')));

dynamicsExportPanel.add(ui.Panel([
  ui.Label('Drive folder:'),
  dynamicsDriveFolder
], ui.Panel.Layout.flow('horizontal')));

dynamicsExportPanel.add(ui.Label('Asset ImageCollection path, if used:'));
dynamicsExportPanel.add(dynamicsAssetCollection);

dynamicsExportPanel.add(ui.Panel([
  ui.Label('Export scale, metres:'),
  dynamicsExportScale
], ui.Panel.Layout.flow('horizontal')));

var exportDynamicsButton = ui.Button({
  label: 'Create export task for selected dynamics',
  style: {
    stretch: 'horizontal',
    margin: '6px 0 4px 0'
  },
  onClick: exportAnnualDynamics
});

dynamicsExportPanel.add(exportDynamicsButton);

// Integrate with the existing application when its tab controls are present.
// Otherwise create a complete standalone user interface.
if (
  typeof tabSelect !== 'undefined' &&
  typeof tabPanel !== 'undefined'
) {
  tabSelect.items().add('Hydrological-period water dynamics');

  tabSelect.onChange(function(tabName) {
    tabPanel.clear();

    if (tabName === 'Visualize and export one result') {
      tabPanel.add(visPanel);
    }

    if (tabName === 'Batch export') {
      tabPanel.add(batchPanel);
    }

    if (tabName === 'SWOT-date export') {
      tabPanel.add(swotPanel);
    }

    if (tabName === 'Hydrological-period water dynamics') {
      tabPanel.add(dynamicsPanel);
    }
  });

  dynEnsureAoiLayer();
} else {
  Map.setOptions('SATELLITE');
  dynEnsureAoiLayer();

  var dynRootPanel = ui.Panel({
    style: {
      width: '440px',
      padding: '10px'
    }
  });

  dynRootPanel.add(ui.Label({
    value: 'Hydrological-period water and inundation dynamics',
    style: {
      fontWeight: 'bold',
      fontSize: '16px',
      margin: '0 0 6px 0'
    }
  }));

  dynRootPanel.add(dynamicsPanel);

  dynStandaloneStatusLabel = ui.Label({
    value: 'Select an AOI first.',
    style: {
      margin: '12px 0 0 0',
      color: '555555'
    }
  });

  dynRootPanel.add(dynStandaloneStatusLabel);
  ui.root.insert(0, dynRootPanel);

  // Generic initial view only; no AOI is loaded or used.
  Map.setCenter(20, 0, 2);
}

// Attach the floating legend as a map widget. It remains hidden until a run
// creates legend entries and the Show legend option is enabled.
dynBuildLegendPanel();
Map.add(dynLegendPanel);
dynBuildInspectorPanel();
Map.add(dynInspectorPanel);

// One lightweight listener is always registered. It performs no work unless
// the inspector checkbox is enabled and an hydrological-period run has been completed.
Map.onClick(function(coords) {
  dynInspectCoordinates(coords);
});

// ------------------------------------------------------
// Hydrological-period dynamics collection construction
// ------------------------------------------------------

function dynSourcePriority(sourceBit) {
  if (sourceBit === DYN_SOURCE_DW) {
    return 4;
  }

  if (sourceBit === DYN_SOURCE_HLS_LANDSAT) {
    return 3;
  }

  if (sourceBit === DYN_SOURCE_HLS_SENTINEL2) {
    return 2;
  }

  return 1;
}


function dynTagHlsPlatform(image) {
  var propertyNames = image.propertyNames();
  var sensor = ee.String(ee.Algorithms.If(
    propertyNames.contains('SENSOR'),
    image.get('SENSOR'),
    ''
  ));
  var spacecraft = ee.String(ee.Algorithms.If(
    propertyNames.contains('SPACECRAFT_NAME'),
    image.get('SPACECRAFT_NAME'),
    ''
  ));
  var systemIndex = ee.String(ee.Algorithms.If(
    propertyNames.contains('system:index'),
    image.get('system:index'),
    ''
  ));

  var indexParts = systemIndex.split('_');
  var indexToken = ee.String(ee.Algorithms.If(
    indexParts.size().gt(0),
    indexParts.get(indexParts.size().subtract(1)),
    ''
  ));

  // SPACECRAFT_NAME is the primary source of platform identity. This accepts
  // present and future platform numbers/letters without relying on SENSOR.
  var spacecraftIsLandsat = spacecraft.index('Landsat-').eq(0);
  var spacecraftIsSentinel2 = spacecraft.index('Sentinel-2').eq(0);
  var spacecraftRecognized = spacecraftIsLandsat.or(spacecraftIsSentinel2);

  var spacecraftGroup = ee.String(ee.Algorithms.If(
    spacecraftIsLandsat,
    DYN_HLS_GROUP_LANDSAT,
    ee.Algorithms.If(
      spacecraftIsSentinel2,
      DYN_HLS_GROUP_SENTINEL2,
      DYN_HLS_GROUP_UNRECOGNIZED
    )
  ));

  // The OPERA Earth Engine system:index currently ends in platform tokens such
  // as S2A/S2B/S2C or L8/L9. Additional common Landsat token forms are accepted
  // as a defensive fallback. The token does not override SPACECRAFT_NAME.
  var indexIsSentinel2 = indexToken.index('S2').eq(0);
  var indexIsLandsat = indexToken.index('L8').eq(0)
    .or(indexToken.index('L9').eq(0))
    .or(indexToken.index('LC08').eq(0))
    .or(indexToken.index('LC09').eq(0))
    .or(indexToken.index('LANDSAT8').eq(0))
    .or(indexToken.index('LANDSAT9').eq(0));
  var indexRecognized = indexIsLandsat.or(indexIsSentinel2);

  var indexGroup = ee.String(ee.Algorithms.If(
    indexIsLandsat,
    DYN_HLS_GROUP_LANDSAT,
    ee.Algorithms.If(
      indexIsSentinel2,
      DYN_HLS_GROUP_SENTINEL2,
      DYN_HLS_GROUP_UNRECOGNIZED
    )
  ));

  var spacecraftIndexConflict = spacecraftRecognized
    .and(indexRecognized)
    .and(spacecraftGroup.compareTo(indexGroup).neq(0));

  var candidateGroup = ee.String(ee.Algorithms.If(
    spacecraftRecognized,
    spacecraftGroup,
    ee.Algorithms.If(
      indexRecognized,
      indexGroup,
      DYN_HLS_GROUP_UNRECOGNIZED
    )
  ));

  // A real disagreement between two recognized platform identifiers is kept
  // out of both branches. Missing/unrecognized index tokens do not invalidate
  // a recognized SPACECRAFT_NAME.
  var group = ee.String(ee.Algorithms.If(
    spacecraftIndexConflict,
    DYN_HLS_GROUP_UNRECOGNIZED,
    candidateGroup
  ));

  var classificationBasis = ee.String(ee.Algorithms.If(
    spacecraftIndexConflict,
    'PLATFORM_CONFLICT_EXCLUDED',
    ee.Algorithms.If(
      spacecraftRecognized,
      'SPACECRAFT_NAME',
      ee.Algorithms.If(
        indexRecognized,
        'SYSTEM_INDEX_FALLBACK',
        'UNRECOGNIZED_EXCLUDED'
      )
    )
  ));

  // SENSOR is diagnostic only. It can reveal metadata anomalies such as a
  // Sentinel-2 spacecraft carrying SENSOR=OLI, but it never reassigns or
  // excludes an otherwise clear platform.
  var sensorNonEmpty = sensor.length().gt(0);
  var expectedSensorMatches = ee.Number(ee.Algorithms.If(
    candidateGroup.compareTo(DYN_HLS_GROUP_LANDSAT).eq(0),
    sensor.compareTo('OLI').eq(0),
    ee.Algorithms.If(
      candidateGroup.compareTo(DYN_HLS_GROUP_SENTINEL2).eq(0),
      sensor.compareTo('MSI').eq(0),
      true
    )
  ));
  var sensorSpacecraftConflict = spacecraftRecognized
    .and(sensorNonEmpty)
    .and(expectedSensorMatches.eq(0));

  return image.set({
    dyn_hls_platform_group: group,
    dyn_hls_platform_candidate_group: candidateGroup,
    dyn_hls_platform_assignment_basis: classificationBasis,
    dyn_hls_metadata_recognized: ee.Number(
      group.compareTo(DYN_HLS_GROUP_UNRECOGNIZED).neq(0)
    ),
    dyn_hls_sensor_metadata: sensor,
    dyn_hls_spacecraft_metadata: spacecraft,
    dyn_hls_system_index_metadata: systemIndex,
    dyn_hls_index_token: indexToken,
    dyn_hls_spacecraft_group: spacecraftGroup,
    dyn_hls_index_group: indexGroup,
    dyn_hls_spacecraft_recognized: ee.Number(spacecraftRecognized),
    dyn_hls_index_recognized: ee.Number(indexRecognized),
    dyn_hls_spacecraft_index_conflict: ee.Number(spacecraftIndexConflict),
    dyn_hls_sensor_spacecraft_conflict: ee.Number(sensorSpacecraftConflict)
  });
}

function dynAddDateKey(image) {
  return image.set(
    'date_key',
    ee.Date(image.get('system:time_start')).format('yyyy-MM-dd')
  );
}


function dynZeroDiagnosticImage(date, aoi) {
  var zero = ee.Image.constant(0).clip(aoi).toByte();
  var image = zero.rename(DYN_DIAGNOSTIC_BAND_ORDER[0]);

  DYN_DIAGNOSTIC_BAND_ORDER.slice(1).forEach(function(name) {
    image = image.addBands(zero.rename(name));
  });

  return image
    .select(DYN_DIAGNOSTIC_BAND_ORDER)
    .set({
      date_key: ee.Date(date).format('yyyy-MM-dd'),
      'system:time_start': ee.Date(date).millis(),
      placeholder: 1,
      has_real_observation: 0
    });
}

function dynNormalizeRawDiagnostic(image, kind, aoi) {
  var bandName = kind === DYN_DIAG_KIND_DW ?
    'label' : 'WTR_Water_classification';
  var raw = image.select(bandName);

  var assetFootprint = ee.Image.constant(1)
    .clip(image.geometry())
    .unmask(0, false)
    .clip(aoi)
    .rename('asset_footprint')
    .toByte();

  var productValue = raw.mask()
    .reduce(ee.Reducer.min())
    .gt(0)
    .unmask(0, false)
    .clip(aoi)
    .rename('product_value')
    .toByte();

  function flag(condition, name) {
    return ee.Image(condition)
      .unmask(0, false)
      .clip(aoi)
      .gt(0)
      .rename(name)
      .toByte();
  }

  var notWater;
  var openWater;
  var partial;
  var usable;
  var mask250 = flag(ee.Image(0), 'mask_250_hand');
  var mask251 = flag(ee.Image(0), 'mask_251_layover_shadow');
  var mask252 = flag(ee.Image(0), 'mask_252_snow_ice');
  var mask253 = flag(ee.Image(0), 'mask_253_cloud_shadow');
  var mask254 = flag(ee.Image(0), 'mask_254_ocean');
  var knownNumeric;

  if (kind === DYN_DIAG_KIND_DW) {
    openWater = flag(raw.eq(DYN_DW_WATER_ID), 'open_water');
    partial = flag(
      raw.eq(DYN_DW_FLOODED_VEG_ID),
      'partial_inundated'
    );
    usable = productValue.rename('usable_state');
    notWater = usable.and(openWater.not()).and(partial.not())
      .rename('not_water')
      .toByte();
    knownNumeric = productValue;
  } else if (kind === DYN_DIAG_KIND_HLS) {
    notWater = flag(raw.eq(0), 'not_water');
    openWater = flag(raw.eq(DYN_HLS_OPEN_ID), 'open_water');
    partial = flag(raw.eq(DYN_HLS_PARTIAL_ID), 'partial_inundated');
    mask252 = flag(raw.eq(252), 'mask_252_snow_ice');
    mask253 = flag(raw.eq(253), 'mask_253_cloud_shadow');
    mask254 = flag(raw.eq(254), 'mask_254_ocean');
    usable = notWater.or(openWater).or(partial)
      .rename('usable_state')
      .toByte();
    knownNumeric = usable.or(mask252).or(mask253).or(mask254);
  } else {
    notWater = flag(raw.eq(0), 'not_water');
    openWater = flag(raw.eq(DYN_S1_OPEN_ID), 'open_water');
    partial = flag(
      raw.eq(DYN_S1_INUNDATED_VEG_ID),
      'partial_inundated'
    );
    mask250 = flag(raw.eq(250), 'mask_250_hand');
    mask251 = flag(raw.eq(251), 'mask_251_layover_shadow');
    mask254 = flag(raw.eq(254), 'mask_254_ocean');
    usable = notWater.or(openWater).or(partial)
      .rename('usable_state')
      .toByte();
    knownNumeric = usable.or(mask250).or(mask251).or(mask254);
  }

  var maskedNoValue = assetFootprint.and(productValue.not())
    .rename('masked_no_value')
    .toByte();
  var excluded = assetFootprint.and(usable.not())
    .rename('excluded_state')
    .toByte();
  var otherNumeric = productValue.and(knownNumeric.not())
    .rename('other_numeric')
    .toByte();

  return assetFootprint
    .addBands(productValue)
    .addBands(usable)
    .addBands(notWater)
    .addBands(openWater)
    .addBands(partial)
    .addBands(excluded)
    .addBands(maskedNoValue)
    .addBands(mask250)
    .addBands(mask251)
    .addBands(mask252)
    .addBands(mask253)
    .addBands(mask254)
    .addBands(otherNumeric)
    .select(DYN_DIAGNOSTIC_BAND_ORDER)
    .cast(DYN_DIAGNOSTIC_BAND_TYPES, DYN_DIAGNOSTIC_BAND_ORDER)
    .copyProperties(image, ['system:time_start', 'system:index'])
    .set({placeholder: 0});
}

function dynBuildDailyDiagnosticCollection(rawCollection, kind, aoi, start) {
  var normalized = ee.ImageCollection(rawCollection.map(function(image) {
    return dynAddDateKey(dynNormalizeRawDiagnostic(image, kind, aoi));
  })).cast(DYN_DIAGNOSTIC_BAND_TYPES, DYN_DIAGNOSTIC_BAND_ORDER);

  var groupedInput = ee.ImageCollection([
    dynZeroDiagnosticImage(start, aoi)
  ])
    .merge(normalized)
    .cast(DYN_DIAGNOSTIC_BAND_TYPES, DYN_DIAGNOSTIC_BAND_ORDER);

  var distinctDays = ee.ImageCollection(
    groupedInput.distinct(['date_key'])
  ).sort('system:time_start');

  var sameDayJoin = ee.Join.saveAll({
    matchesKey: 'same_day_diagnostics',
    ordering: 'system:time_start',
    ascending: true
  });

  var joined = sameDayJoin.apply({
    primary: distinctDays,
    secondary: groupedInput,
    condition: ee.Filter.equals({
      leftField: 'date_key',
      rightField: 'date_key'
    })
  });

  return ee.ImageCollection(joined.map(function(dayElement) {
    var representative = ee.Image(dayElement);
    var candidates = ee.ImageCollection.fromImages(
      ee.List(representative.get('same_day_diagnostics'))
    );
    var realCount = candidates.filter(
      ee.Filter.neq('placeholder', 1)
    ).size();

    function anyBand(name) {
      return candidates.select(name)
        .reduce(ee.Reducer.max(), DYN_SAME_DAY_PARALLEL_SCALE)
        .rename(name)
        .unmask(0, false)
        .clip(aoi)
        .toByte();
    }

    var asset = anyBand('asset_footprint');
    var product = anyBand('product_value');
    var usable = anyBand('usable_state');
    var notWater = anyBand('not_water');
    var openWater = anyBand('open_water');
    var partial = anyBand('partial_inundated');
    var raw250 = anyBand('mask_250_hand');
    var raw251 = anyBand('mask_251_layover_shadow');
    var raw252 = anyBand('mask_252_snow_ice');
    var raw253 = anyBand('mask_253_cloud_shadow');
    var raw254 = anyBand('mask_254_ocean');
    var rawOther = anyBand('other_numeric');
    var rawMasked = asset.and(product.not());
    var excluded = asset.and(usable.not());

    // Exclusion reasons are made mutually exclusive per source/date/pixel.
    // A usable water-state observation wins over any simultaneous mask from
    // an overlapping same-day tile. This makes asset = usable + excluded.
    var remaining = excluded;
    var mask250 = remaining.and(raw250);
    remaining = remaining.and(mask250.not());
    var mask251 = remaining.and(raw251);
    remaining = remaining.and(mask251.not());
    var mask252 = remaining.and(raw252);
    remaining = remaining.and(mask252.not());
    var mask253 = remaining.and(raw253);
    remaining = remaining.and(mask253.not());
    var mask254 = remaining.and(raw254);
    remaining = remaining.and(mask254.not());
    var maskedNoValue = remaining.and(rawMasked);
    remaining = remaining.and(maskedNoValue.not());
    var otherNumeric = remaining.and(rawOther.or(product));
    remaining = remaining.and(otherNumeric.not());
    maskedNoValue = maskedNoValue.or(remaining);

    var date = ee.Date(representative.get('system:time_start'));
    return asset
      .addBands(product)
      .addBands(usable)
      .addBands(notWater)
      .addBands(openWater)
      .addBands(partial)
      .addBands(excluded.rename('excluded_state'))
      .addBands(maskedNoValue.rename('masked_no_value'))
      .addBands(mask250.rename('mask_250_hand'))
      .addBands(mask251.rename('mask_251_layover_shadow'))
      .addBands(mask252.rename('mask_252_snow_ice'))
      .addBands(mask253.rename('mask_253_cloud_shadow'))
      .addBands(mask254.rename('mask_254_ocean'))
      .addBands(otherNumeric.rename('other_numeric'))
      .select(DYN_DIAGNOSTIC_BAND_ORDER)
      .cast(DYN_DIAGNOSTIC_BAND_TYPES, DYN_DIAGNOSTIC_BAND_ORDER)
      .set({
        date_key: representative.get('date_key'),
        'system:time_start': date.millis(),
        has_real_observation: ee.Number(realCount.gt(0)),
        placeholder: ee.Number(realCount.eq(0))
      });
  })).sort('system:time_start')
    .cast(DYN_DIAGNOSTIC_BAND_TYPES, DYN_DIAGNOSTIC_BAND_ORDER);
}

function dynDiagnosticCount(collection, conditionBand, outputName) {
  return ee.ImageCollection(collection)
    .select(conditionBand)
    .sum()
    .rename(outputName)
    .toUint16();
}

function dynTypedMaskedRawObservation(date, aoi) {
  var mask = ee.Image.constant(0).clip(aoi).toByte();
  var zero = ee.Image.constant(0).clip(aoi).toByte().updateMask(mask);
  var image = zero.rename(DYN_RAW_BAND_ORDER[0]);

  DYN_RAW_BAND_ORDER.slice(1).forEach(function(name) {
    image = image.addBands(zero.rename(name));
  });

  return image
    .select(DYN_RAW_BAND_ORDER)
    .cast(DYN_RAW_BAND_TYPES, DYN_RAW_BAND_ORDER)
    .set({
      date_key: ee.Date(date).format('yyyy-MM-dd'),
      'system:time_start': ee.Date(date).millis(),
      source_code: 0,
      source_priority: 0,
      placeholder: 1
    });
}

function dynPackObservation(
  image,
  validMask,
  openClass,
  partialClass,
  openSelected,
  partialSelected,
  unselectedWater,
  dry,
  sourceBit
) {
  // All output bands are built from a real numeric source band and then
  // masked. This preserves an explicit uint8 type without filling the AOI
  // with zeros and without allowing a mask-derived MaskOnly validity band.
  var sourceBase = ee.Image(image).select(0).multiply(0).toByte();
  var supportMask = ee.Image(validMask).unmask(0).neq(0);

  function flag(condition, name) {
    return sourceBase
      .where(ee.Image(condition).unmask(0).neq(0), 1)
      .rename(name)
      .toByte()
      .updateMask(supportMask);
  }

  var valid = sourceBase.add(1)
    .rename('valid')
    .toByte()
    .updateMask(supportMask);
  var openClassBand = flag(openClass, 'open_class');
  var partialClassBand = flag(partialClass, 'partial_class');
  var open = flag(openSelected, 'open');
  var partial = flag(partialSelected, 'partial');
  var selected = flag(open.or(partial), 'selected');
  var unselected = flag(unselectedWater, 'unselected_water');
  var dryBand = flag(dry, 'dry');

  var state = sourceBase.rename('state')
    .where(open.eq(1), DYN_STATE_OPEN)
    .where(partial.eq(1), DYN_STATE_PARTIAL)
    .where(
      unselected.eq(1).and(selected.eq(0)),
      DYN_STATE_UNSELECTED_WATER
    )
    .toByte()
    .updateMask(supportMask);

  var sourceBand = sourceBase.add(sourceBit)
    .rename('source_bit')
    .toByte()
    .updateMask(supportMask);

  return state
    .addBands(selected)
    .addBands(openClassBand)
    .addBands(partialClassBand)
    .addBands(open)
    .addBands(partial)
    .addBands(unselected)
    .addBands(dryBand)
    .addBands(valid)
    .addBands(sourceBand)
    .select(DYN_RAW_BAND_ORDER)
    .cast(DYN_RAW_BAND_TYPES, DYN_RAW_BAND_ORDER)
    .copyProperties(image, ['system:time_start', 'system:index'])
    .set({
      source_code: sourceBit,
      source_priority: dynSourcePriority(sourceBit),
      placeholder: 0
    });
}

function dynNormalizeDw(image, classOptions) {
  var label = image.select('label');
  var validMask = label.mask().reduce(ee.Reducer.min()).gt(0);
  var waterClass = label.eq(DYN_DW_WATER_ID);
  var floodedClass = label.eq(DYN_DW_FLOODED_VEG_ID);

  var open = classOptions.dwWater ? waterClass : waterClass.multiply(0);
  var partial = classOptions.dwFloodedVeg ?
    floodedClass : floodedClass.multiply(0);
  var unselected = waterClass.and(open.not())
    .or(floodedClass.and(partial.not()));

  // Every unmasked DW semantic label is valid support. Snow/ice and other
  // non-target classes are valid non-selected/non-liquid-water evidence.
  var dry = validMask.and(waterClass.not()).and(floodedClass.not());

  return dynPackObservation(
    image,
    validMask,
    waterClass,
    floodedClass,
    open,
    partial,
    unselected,
    dry,
    DYN_SOURCE_DW
  );
}

function dynNormalizeHls(image, classOptions, sourceBit) {
  var wtr = image.select('WTR_Water_classification');
  var validMask = wtr.eq(0)
    .or(wtr.eq(DYN_HLS_OPEN_ID))
    .or(wtr.eq(DYN_HLS_PARTIAL_ID));
  var openClass = wtr.eq(DYN_HLS_OPEN_ID);
  var partialClass = wtr.eq(DYN_HLS_PARTIAL_ID);
  var open = classOptions.hlsOpen ? openClass : openClass.multiply(0);
  var partial = classOptions.hlsPartial ?
    partialClass : partialClass.multiply(0);
  var unselected = openClass.and(open.not())
    .or(partialClass.and(partial.not()));
  var dry = wtr.eq(0);

  return dynPackObservation(
    image,
    validMask,
    openClass,
    partialClass,
    open,
    partial,
    unselected,
    dry,
    sourceBit
  );
}

function dynNormalizeS1(image, classOptions) {
  var wtr = image.select('WTR_Water_classification');
  var openClass = wtr.eq(DYN_S1_OPEN_ID);
  var partialClass = wtr.eq(DYN_S1_INUNDATED_VEG_ID);

  // Class 0 is always valid non-water evidence. Mask classes 250, 251 and
  // 254 are not usable water-state observations and remain masked.
  var validMask = wtr.eq(0).or(openClass).or(partialClass);
  var open = classOptions.s1Open ? openClass : openClass.multiply(0);
  var partial = classOptions.s1InundatedVeg ?
    partialClass : partialClass.multiply(0);
  var unselected = openClass.and(open.not())
    .or(partialClass.and(partial.not()));
  var dry = wtr.eq(0);

  return dynPackObservation(
    image,
    validMask,
    openClass,
    partialClass,
    open,
    partial,
    unselected,
    dry,
    DYN_SOURCE_S1
  );
}

function dynCollapseOneSourcePerDay(collection) {
  collection = ee.ImageCollection(collection.map(dynAddDateKey));
  var distinctDays = ee.ImageCollection(
    collection.distinct(['date_key'])
  ).sort('system:time_start');

  var join = ee.Join.saveAll({
    matchesKey: 'same_source_day',
    ordering: 'system:time_start',
    ascending: true
  });

  var joined = join.apply({
    primary: distinctDays,
    secondary: collection,
    condition: ee.Filter.equals({
      leftField: 'date_key',
      rightField: 'date_key'
    })
  });

  return ee.ImageCollection(joined.map(function(dayElement) {
    var representative = ee.Image(dayElement);
    var candidates = ee.ImageCollection.fromImages(
      ee.List(representative.get('same_source_day'))
    );

    // Same source/date duplicates are generally adjacent tiles or duplicate
    // platform products. A mosaic retains one typed valid value per pixel.
    var daily = candidates.mosaic()
      .select(DYN_RAW_BAND_ORDER)
      .cast(DYN_RAW_BAND_TYPES, DYN_RAW_BAND_ORDER);

    return daily.set({
      date_key: representative.get('date_key'),
      'system:time_start': representative.get('system:time_start'),
      source_code: representative.get('source_code'),
      source_priority: representative.get('source_priority'),
      placeholder: 0
    });
  })).sort('system:time_start');
}

function dynAnyDailyBand(candidates, bandName) {
  return candidates.select(bandName)
    .reduce(ee.Reducer.max(), DYN_SAME_DAY_PARALLEL_SCALE)
    .rename(bandName)
    .unmask(0)
    .toByte();
}

function dynDailySourceMask(candidates, conditionBand, outputName) {
  return candidates.map(function(image) {
    return image.select(conditionBand)
      .eq(1)
      .multiply(image.select('source_bit'))
      .rename(outputName)
      .toByte();
  })
    .reduce(ee.Reducer.bitwiseOr(), DYN_SAME_DAY_PARALLEL_SCALE)
    .rename(outputName)
    .unmask(0)
    .toByte();
}

function dynApplyHlsMsiGapFillLight(candidates, sourceOptions) {
  if (!sourceOptions.hlsMsiGapFill || !sourceOptions.useDw) {
    return candidates;
  }

  var dwValid = candidates.map(function(image) {
    var isDw = ee.Number(image.get('source_code')).eq(DYN_SOURCE_DW);
    return image.select('valid')
      .multiply(isDw)
      .rename('valid')
      .toByte();
  })
    .reduce(ee.Reducer.max(), DYN_SAME_DAY_PARALLEL_SCALE)
    .rename('valid')
    .unmask(0)
    .toByte();

  var nonMsi = candidates.filter(
    ee.Filter.neq('source_code', DYN_SOURCE_HLS_SENTINEL2)
  );
  var msi = candidates.filter(
    ee.Filter.eq('source_code', DYN_SOURCE_HLS_SENTINEL2)
  ).map(function(image) {
    return image.updateMask(dwValid.not())
      .copyProperties(image, image.propertyNames());
  });

  return nonMsi.merge(msi);
}

function dynBuildDailyMetricUnion(candidates) {
  var validAny = dynAnyDailyBand(candidates, 'valid').rename('valid');
  var openAny = dynAnyDailyBand(candidates, 'open').rename('open');
  var partialAny = dynAnyDailyBand(candidates, 'partial').rename('partial');
  var selectedAny = openAny.or(partialAny).rename('selected').toByte();
  var unselectedAny = dynAnyDailyBand(candidates, 'unselected_water');
  var dryAny = dynAnyDailyBand(candidates, 'dry');
  var dryFinal = dryAny
    .and(selectedAny.not())
    .and(unselectedAny.not())
    .rename('dry')
    .toByte();
  var selectedSourceMask = dynDailySourceMask(
    candidates,
    'selected',
    'selected_source_mask'
  );
  var validSourceMask = dynDailySourceMask(
    candidates,
    'valid',
    'valid_source_mask'
  );
  var conflict = selectedAny.and(dryAny)
    .rename('conflict')
    .toByte();

  return selectedAny
    .addBands(openAny)
    .addBands(partialAny)
    .addBands(dryFinal)
    .addBands(validAny)
    .addBands(selectedSourceMask)
    .addBands(validSourceMask)
    .addBands(conflict)
    .updateMask(validAny.eq(1))
    .toByte();
}

function dynBuildDailyMetricPriority(candidates) {
  var priority = candidates.sort('source_priority').mosaic();
  var validAny = dynAnyDailyBand(candidates, 'valid').rename('valid');
  var selectedAny = dynAnyDailyBand(candidates, 'selected');
  var dryAny = dynAnyDailyBand(candidates, 'dry');
  var selectedSourceMask = dynDailySourceMask(
    candidates,
    'selected',
    'selected_source_mask'
  );
  var validSourceMask = dynDailySourceMask(
    candidates,
    'valid',
    'valid_source_mask'
  );
  var conflict = selectedAny.and(dryAny)
    .rename('conflict')
    .toByte();

  return priority.select(['selected', 'open', 'partial', 'dry', 'valid'])
    .addBands(selectedSourceMask)
    .addBands(validSourceMask)
    .addBands(conflict)
    .updateMask(validAny.eq(1))
    .toByte();
}

function dynBuildDailyUnionLight(candidates, aoi) {
  var validAny = dynAnyDailyBand(candidates, 'valid').rename('valid');
  var openClassAny = dynAnyDailyBand(candidates, 'open_class');
  var partialClassAny = dynAnyDailyBand(candidates, 'partial_class');
  var openAny = dynAnyDailyBand(candidates, 'open');
  var partialAny = dynAnyDailyBand(candidates, 'partial');
  var selectedAny = openAny.or(partialAny).rename('selected').toByte();
  var unselectedAny = dynAnyDailyBand(candidates, 'unselected_water');
  var dryAny = dynAnyDailyBand(candidates, 'dry');
  var dryFinal = dryAny
    .and(selectedAny.not())
    .and(unselectedAny.not())
    .rename('dry')
    .toByte();

  var state = ee.Image.constant(0).clip(aoi).toByte()
    .where(openAny.eq(1), DYN_STATE_OPEN)
    .where(partialAny.eq(1), DYN_STATE_PARTIAL)
    .where(
      unselectedAny.eq(1).and(selectedAny.eq(0)),
      DYN_STATE_UNSELECTED_WATER
    )
    .rename('state')
    .toByte();

  var validSourceMask = dynDailySourceMask(
    candidates,
    'valid',
    'valid_source_mask'
  );
  var selectedSourceMask = dynDailySourceMask(
    candidates,
    'selected',
    'selected_source_mask'
  );
  var conflict = selectedAny.and(dryAny)
    .rename('conflict')
    .toByte();
  var validSourceCount = validSourceMask.bitCount()
    .rename('valid_source_count')
    .toByte();

  return state
    .addBands(selectedAny)
    .addBands(openClassAny.rename('open_class'))
    .addBands(partialClassAny.rename('partial_class'))
    .addBands(openAny.rename('open'))
    .addBands(partialAny.rename('partial'))
    .addBands(unselectedAny.rename('unselected_water'))
    .addBands(dryFinal)
    .addBands(validAny)
    .addBands(validSourceMask.rename('source_bit'))
    .addBands(selectedSourceMask)
    .addBands(validSourceMask)
    .addBands(validSourceCount)
    .addBands(conflict)
    .updateMask(validAny.eq(1))
    .select(DYN_DAILY_BAND_ORDER.slice(0, -1))
    .toByte();
}

function dynBuildDailyPriorityLight(candidates, aoi) {
  var priority = candidates.sort('source_priority').mosaic()
    .select(DYN_RAW_BAND_ORDER)
    .cast(DYN_RAW_BAND_TYPES, DYN_RAW_BAND_ORDER);
  var validAny = dynAnyDailyBand(candidates, 'valid').rename('valid');
  var selectedAny = dynAnyDailyBand(candidates, 'selected');
  var dryAny = dynAnyDailyBand(candidates, 'dry');
  var validSourceMask = dynDailySourceMask(
    candidates,
    'valid',
    'valid_source_mask'
  );
  var selectedSourceMask = dynDailySourceMask(
    candidates,
    'selected',
    'selected_source_mask'
  );
  var validSourceCount = validSourceMask.bitCount()
    .rename('valid_source_count')
    .toByte();
  var conflict = selectedAny.and(dryAny)
    .rename('conflict')
    .toByte();

  return priority
    .addBands(selectedSourceMask)
    .addBands(validSourceMask)
    .addBands(validSourceCount)
    .addBands(conflict)
    .updateMask(validAny.eq(1))
    .select(DYN_DAILY_BAND_ORDER.slice(0, -1))
    .toByte();
}


// ------------------------------------------------------
// Metric-specific direct timing engine
// ------------------------------------------------------

/*
The successful standalone benchmark demonstrated that first/last timing
products do not need the complete daily fusion graph. Under the recommended
"Any selected water wins" rule, the temporal extreme can be calculated for
each source independently and then reduced across the enabled sources.

This path intentionally carries only one analysis-day band. Class-0 dry validity,
provenance, conflicts and raw diagnostics remain in their dedicated engines
because they cannot change a first/last selected-water date.
*/

function dynDirectMaskedAnalysisDay(name) {
  return ee.Image.constant(0)
    .rename(name)
    .toInt16()
    .updateMask(ee.Image.constant(0));
}

function dynDirectImageAnalysisDay(image, condition, outputName, periodStart) {
  var date = ee.Date(image.get('system:time_start'));
  var analysisDay = ee.Image.constant(
    dynAnalysisDayNumber(date, periodStart)
  )
    .rename(outputName)
    .toInt16();

  return analysisDay
    .updateMask(ee.Image(condition).unmask(0).eq(1))
    .copyProperties(image, ['system:time_start', 'system:index']);
}

function dynPrepareDirectSources(aoi, start, end) {
  start = ee.Date(start);
  end = ee.Date(end);

  var dwSource = DYNAMICS_DW
    .filterBounds(aoi)
    .filterDate(start, end)
    .select(['label']);

  var hlsAll = DYNAMICS_HLS
    .filterBounds(aoi)
    .filterDate(start, end);

  // SPACECRAFT_NAME is authoritative. SENSOR is retained only in the
  // metadata-verification workflow because Sentinel-2 assets have been
  // observed with SENSOR=OLI.
  var hlsLandsatSource = hlsAll
    .filter(ee.Filter.stringStartsWith('SPACECRAFT_NAME', 'Landsat-'))
    .select(['WTR_Water_classification']);

  var hlsSentinel2Source = hlsAll
    .filter(ee.Filter.stringStartsWith('SPACECRAFT_NAME', 'Sentinel-2'))
    .select(['WTR_Water_classification']);

  var s1Source = DYNAMICS_S1
    .filterBounds(aoi)
    .filterDate(start, end)
    .select(['WTR_Water_classification']);

  return {
    start: start,
    end: end,
    dw: dwSource,
    hlsAll: hlsAll,
    hlsLandsat: hlsLandsatSource,
    hlsSentinel2: hlsSentinel2Source,
    s1: s1Source
  };
}

function dynApplySameDayDwGapFillDirect(hlsS2Source, dwSource) {
  var dwWithDate = dwSource.map(dynAddDateKey);
  var hlsWithDate = hlsS2Source.map(dynAddDateKey);

  var join = ee.Join.saveAll({matchesKey: 'same_day_dw'});
  var joined = join.apply({
    primary: hlsWithDate,
    secondary: dwWithDate,
    condition: ee.Filter.equals({
      leftField: 'date_key',
      rightField: 'date_key'
    })
  });

  return ee.ImageCollection(joined.map(function(element) {
    var hlsImage = ee.Image(element);
    var dwImages = ee.ImageCollection.fromImages(
      ee.List(hlsImage.get('same_day_dw'))
    );

    // A real numeric placeholder handles dates without a matching DW asset.
    var zero = ee.Image.constant(0).rename('dw_valid').toByte();
    var dwValid = ee.ImageCollection([zero]).merge(
      dwImages.map(function(dwImage) {
        var label = ee.Image(dwImage).select('label');
        return label.mask()
          .reduce(ee.Reducer.min())
          .gt(0)
          .rename('dw_valid')
          .unmask(0)
          .toByte();
      })
    ).max().rename('dw_valid').toByte();

    return hlsImage
      .updateMask(dwValid.eq(0))
      .copyProperties(hlsImage, hlsImage.propertyNames());
  }));
}

function dynDirectCondition(image, sourceKind, classGroup, classOptions) {
  var condition = ee.Image.constant(0);

  if (sourceKind === 'DW') {
    var label = ee.Image(image).select('label');
    var water = label.eq(DYN_DW_WATER_ID);
    var partial = label.eq(DYN_DW_FLOODED_VEG_ID);

    if (classGroup === 'open') {
      condition = classOptions.dwWater ? water : water.multiply(0);
    } else if (classGroup === 'partial') {
      condition = classOptions.dwFloodedVeg ? partial : partial.multiply(0);
    } else {
      if (classOptions.dwWater) {
        condition = condition.or(water);
      }
      if (classOptions.dwFloodedVeg) {
        condition = condition.or(partial);
      }
    }

    return condition.and(
      label.mask().reduce(ee.Reducer.min()).gt(0)
    );
  }

  var wtr = ee.Image(image).select('WTR_Water_classification');
  var openClass;
  var partialClass;
  var useOpen;
  var usePartial;

  if (sourceKind === 'HLS') {
    openClass = wtr.eq(DYN_HLS_OPEN_ID);
    partialClass = wtr.eq(DYN_HLS_PARTIAL_ID);
    useOpen = classOptions.hlsOpen;
    usePartial = classOptions.hlsPartial;
  } else {
    openClass = wtr.eq(DYN_S1_OPEN_ID);
    partialClass = wtr.eq(DYN_S1_INUNDATED_VEG_ID);
    useOpen = classOptions.s1Open;
    usePartial = classOptions.s1InundatedVeg;
  }

  if (classGroup === 'open') {
    return useOpen ? openClass : openClass.multiply(0);
  }
  if (classGroup === 'partial') {
    return usePartial ? partialClass : partialClass.multiply(0);
  }

  if (useOpen) {
    condition = condition.or(openClass);
  }
  if (usePartial) {
    condition = condition.or(partialClass);
  }
  return condition;
}

function dynDirectExtremeForSource(
  source,
  enabled,
  sourceKind,
  classGroup,
  reducerName,
  outputName,
  classOptions,
  periodStart
) {
  if (!enabled) {
    return dynDirectMaskedAnalysisDay(outputName);
  }

  var candidates = ee.ImageCollection(source.map(function(image) {
    return dynDirectImageAnalysisDay(
      image,
      dynDirectCondition(image, sourceKind, classGroup, classOptions),
      outputName,
      periodStart
    );
  }));

  var placeholder = dynDirectMaskedAnalysisDay(outputName)
    .set('system:time_start', ee.Date('1900-01-01').millis());
  var safe = ee.ImageCollection([placeholder]).merge(candidates);

  if (reducerName === 'max') {
    return safe.max().rename(outputName).toInt16();
  }
  return safe.min().rename(outputName).toInt16();
}

function dynDirectFusedExtreme(
  sources,
  sourceOptions,
  classOptions,
  classGroup,
  reducerName,
  outputName
) {
  var hlsS2 = sources.hlsSentinel2;
  if (
    sourceOptions.useDw &&
    sourceOptions.useHlsSentinel2 &&
    sourceOptions.hlsMsiGapFill
  ) {
    hlsS2 = dynApplySameDayDwGapFillDirect(hlsS2, sources.dw);
  }

  var sourceImages = [
    dynDirectExtremeForSource(
      sources.dw,
      sourceOptions.useDw,
      'DW',
      classGroup,
      reducerName,
      outputName,
      classOptions,
      sources.start
    ),
    dynDirectExtremeForSource(
      sources.hlsLandsat,
      sourceOptions.useHlsLandsat,
      'HLS',
      classGroup,
      reducerName,
      outputName,
      classOptions,
      sources.start
    ),
    dynDirectExtremeForSource(
      hlsS2,
      sourceOptions.useHlsSentinel2,
      'HLS',
      classGroup,
      reducerName,
      outputName,
      classOptions,
      sources.start
    ),
    dynDirectExtremeForSource(
      sources.s1,
      sourceOptions.useS1,
      'S1',
      classGroup,
      reducerName,
      outputName,
      classOptions,
      sources.start
    )
  ];

  var collection = ee.ImageCollection.fromImages(
    sourceImages.map(function(image) {
      return ee.Image(image).rename(outputName);
    })
  );

  if (reducerName === 'max') {
    return collection.max().rename(outputName).toInt16();
  }
  return collection.min().rename(outputName).toInt16();
}

function dynBuildDirectTimingImages(
  sources,
  sourceOptions,
  classOptions,
  needs
) {
  function build(group, reducer, name, required) {
    return required ? dynDirectFusedExtreme(
      sources,
      sourceOptions,
      classOptions,
      group,
      reducer,
      name
    ) : null;
  }

  return {
    firstSelected: build(
      'selected', 'min', 'first_selected_class_analysis_day', needs.firstSelected
    ),
    lastSelected: build(
      'selected', 'max', 'last_selected_class_analysis_day', needs.lastSelected
    ),
    firstOpen: build(
      'open', 'min', 'first_open_water_analysis_day', needs.firstOpen
    ),
    lastOpen: build(
      'open', 'max', 'last_open_water_analysis_day', needs.lastOpen
    ),
    firstPartial: build(
      'partial', 'min', 'first_inundated_partial_analysis_day', needs.firstPartial
    ),
    lastPartial: build(
      'partial', 'max', 'last_inundated_partial_analysis_day', needs.lastPartial
    )
  };
}


// ------------------------------------------------------
// Lightweight first-dry-after-final-selection engine
// ------------------------------------------------------

/*
The first dry day after the final selected detection is more demanding than a
simple temporal minimum or maximum. The full daily engine previously carried
validity, provenance, conflict and source-mask bands for every date even though
this metric needs only two kinds of evidence after the already calculated last
selected date:

  dry               = an enabled source explicitly reports non-water;
  unselected_water   = a water-related class exists but is not part of the
                       current selected-class target.

Under "Any selected water wins", no selected-water observation can occur after
lastSelected by definition. Therefore, a later fused date is dry when at least
one source reports dry and no source reports an unselected water class. This
specialized engine preserves that rule while avoiding the complete daily
metric/provenance collection.
*/

var DYN_FIRST_DRY_BANDS = ['dry', 'unselected_water'];
var DYN_FIRST_DRY_TYPES = {
  dry: 'uint8',
  unselected_water: 'uint8'
};

function dynNormalizeFirstDryEvidence(image, sourceKind, classOptions) {
  var raw;
  var valid;
  var dry;
  var unselected;

  if (sourceKind === 'DW') {
    raw = ee.Image(image).select('label');
    valid = raw.mask().reduce(ee.Reducer.min()).gt(0);
    var dwWater = raw.eq(DYN_DW_WATER_ID);
    var dwPartial = raw.eq(DYN_DW_FLOODED_VEG_ID);

    dry = valid.and(dwWater.not()).and(dwPartial.not());
    unselected = dwWater.and(
      classOptions.dwWater ? ee.Image(0) : ee.Image(1)
    ).or(
      dwPartial.and(
        classOptions.dwFloodedVeg ? ee.Image(0) : ee.Image(1)
      )
    );
  } else {
    raw = ee.Image(image).select('WTR_Water_classification');

    if (sourceKind === 'HLS') {
      var hlsOpen = raw.eq(DYN_HLS_OPEN_ID);
      var hlsPartial = raw.eq(DYN_HLS_PARTIAL_ID);
      valid = raw.eq(0).or(hlsOpen).or(hlsPartial);
      dry = raw.eq(0);
      unselected = hlsOpen.and(
        classOptions.hlsOpen ? ee.Image(0) : ee.Image(1)
      ).or(
        hlsPartial.and(
          classOptions.hlsPartial ? ee.Image(0) : ee.Image(1)
        )
      );
    } else {
      var s1Open = raw.eq(DYN_S1_OPEN_ID);
      var s1Partial = raw.eq(DYN_S1_INUNDATED_VEG_ID);
      valid = raw.eq(0).or(s1Open).or(s1Partial);
      dry = raw.eq(0);
      unselected = s1Open.and(
        classOptions.s1Open ? ee.Image(0) : ee.Image(1)
      ).or(
        s1Partial.and(
          classOptions.s1InundatedVeg ? ee.Image(0) : ee.Image(1)
        )
      );
    }
  }

  return dry.rename('dry')
    .addBands(unselected.rename('unselected_water'))
    .updateMask(valid)
    .select(DYN_FIRST_DRY_BANDS)
    .cast(DYN_FIRST_DRY_TYPES, DYN_FIRST_DRY_BANDS)
    .copyProperties(image, ['system:time_start', 'system:index']);
}

function dynCollapseFirstDrySourcePerDay(collection) {
  collection = ee.ImageCollection(collection.map(dynAddDateKey));

  var distinctDays = ee.ImageCollection(
    collection.distinct(['date_key'])
  ).sort('system:time_start');

  var join = ee.Join.saveAll({
    matchesKey: 'same_source_first_dry_day',
    ordering: 'system:time_start',
    ascending: true
  });

  var joined = join.apply({
    primary: distinctDays,
    secondary: collection,
    condition: ee.Filter.equals({
      leftField: 'date_key',
      rightField: 'date_key'
    })
  });

  return ee.ImageCollection(joined.map(function(dayElement) {
    var representative = ee.Image(dayElement);
    var candidates = ee.ImageCollection.fromImages(
      ee.List(representative.get('same_source_first_dry_day'))
    );

    return candidates.mosaic()
      .select(DYN_FIRST_DRY_BANDS)
      .cast(DYN_FIRST_DRY_TYPES, DYN_FIRST_DRY_BANDS)
      .set({
        date_key: representative.get('date_key'),
        'system:time_start': representative.get('system:time_start')
      });
  })).sort('system:time_start');
}

function dynBuildDirectFirstDryAfterLastSelected(
  sources,
  sourceOptions,
  classOptions,
  lastSelected
) {
  var hlsS2 = sources.hlsSentinel2;

  // The same-day DW-gap rule applies to both wet and dry HLS Sentinel-2
  // evidence. Where DW has a valid same-day pixel, HLS Sentinel-2 contributes
  // neither a selected-water nor a dry observation.
  if (
    sourceOptions.useDw &&
    sourceOptions.useHlsSentinel2 &&
    sourceOptions.hlsMsiGapFill
  ) {
    hlsS2 = dynApplySameDayDwGapFillDirect(hlsS2, sources.dw);
  }

  var allDaily = ee.ImageCollection([]);

  if (sourceOptions.useDw) {
    allDaily = allDaily.merge(
      dynCollapseFirstDrySourcePerDay(
        sources.dw.map(function(image) {
          return dynNormalizeFirstDryEvidence(
            image, 'DW', classOptions
          );
        })
      )
    );
  }

  if (sourceOptions.useHlsLandsat) {
    allDaily = allDaily.merge(
      dynCollapseFirstDrySourcePerDay(
        sources.hlsLandsat.map(function(image) {
          return dynNormalizeFirstDryEvidence(
            image, 'HLS', classOptions
          );
        })
      )
    );
  }

  if (sourceOptions.useHlsSentinel2) {
    allDaily = allDaily.merge(
      dynCollapseFirstDrySourcePerDay(
        hlsS2.map(function(image) {
          return dynNormalizeFirstDryEvidence(
            image, 'HLS', classOptions
          );
        })
      )
    );
  }

  if (sourceOptions.useS1) {
    allDaily = allDaily.merge(
      dynCollapseFirstDrySourcePerDay(
        sources.s1.map(function(image) {
          return dynNormalizeFirstDryEvidence(
            image, 'S1', classOptions
          );
        })
      )
    );
  }

  var placeholder = ee.Image.constant([0, 0])
    .rename(DYN_FIRST_DRY_BANDS)
    .toByte()
    .updateMask(ee.Image.constant(0))
    .set({
      date_key: sources.start.format('yyyy-MM-dd'),
      'system:time_start': sources.start.millis(),
      placeholder: 1
    });

  var groupedInput = ee.ImageCollection([placeholder])
    .merge(allDaily)
    .map(function(image) {
      return ee.Image(image)
        .select(DYN_FIRST_DRY_BANDS)
        .cast(DYN_FIRST_DRY_TYPES, DYN_FIRST_DRY_BANDS)
        .copyProperties(image, image.propertyNames());
    });

  var distinctDates = ee.ImageCollection(
    groupedInput.distinct(['date_key'])
  ).sort('system:time_start');

  var sameDayJoin = ee.Join.saveAll({
    matchesKey: 'first_dry_same_day_sources',
    ordering: 'system:time_start',
    ascending: true
  });

  var joinedDates = sameDayJoin.apply({
    primary: distinctDates,
    secondary: groupedInput,
    condition: ee.Filter.equals({
      leftField: 'date_key',
      rightField: 'date_key'
    })
  });

  var candidates = ee.ImageCollection(joinedDates.map(function(dayElement) {
    var representative = ee.Image(dayElement);
    var sameDay = ee.ImageCollection.fromImages(
      ee.List(representative.get('first_dry_same_day_sources'))
    );

    var dryAny = sameDay.select('dry')
      .reduce(ee.Reducer.max(), DYN_SAME_DAY_PARALLEL_SCALE)
      .rename('dry')
      .unmask(0)
      .toByte();

    var unselectedAny = sameDay.select('unselected_water')
      .reduce(ee.Reducer.max(), DYN_SAME_DAY_PARALLEL_SCALE)
      .rename('unselected_water')
      .unmask(0)
      .toByte();

    var fusedDry = dryAny.and(unselectedAny.not());
    var date = ee.Date(representative.get('system:time_start'));
    var analysisDay = ee.Image.constant(
      dynAnalysisDayNumber(date, sources.start)
    )
      .rename('first_dry_candidate_analysis_day')
      .toInt16();

    // analysisDay.gt(lastSelected) also propagates the mask of lastSelected.
    // Pixels without any selected-water detection therefore remain masked.
    return analysisDay
      .updateMask(fusedDry.eq(1))
      .updateMask(analysisDay.gt(lastSelected))
      .set({
        date_key: representative.get('date_key'),
        'system:time_start': representative.get('system:time_start')
      });
  }));

  return candidates
    .reduce(ee.Reducer.min(), DYN_REDUCE_PARALLEL_SCALE)
    .rename('first_dry_after_final_selected_analysis_day')
    .toInt16();
}


// ------------------------------------------------------
// Lightweight selected/valid daily engine
// ------------------------------------------------------

/*
Counts, fractions, episodes, longest spells and maximum valid-observation gaps
need a daily temporal sequence, but they do not need provenance, source masks,
conflicts, raw diagnostic bands or the complete fused state schema.

Under "Any selected water wins", this engine carries only:
  selected = at least one enabled source reports a selected water class;
  valid    = at least one enabled source provides usable water/non-water state;
  analysis_day = ordinal UTC date within the selected analysis period (day 1 = period start).

The HLS Sentinel-2 same-day Dynamic World gap-fill policy is applied before
normalization, exactly as in the direct timing engine.
*/

var DYN_SELECTED_VALID_BANDS = ['selected', 'valid'];
var DYN_SELECTED_VALID_TYPES = {
  selected: 'uint8',
  valid: 'uint8'
};

function dynNormalizeSelectedValidEvidence(
  image,
  sourceKind,
  classOptions
) {
  var raw;
  var valid;
  var selected = ee.Image.constant(0);

  if (sourceKind === 'DW') {
    raw = ee.Image(image).select('label');
    valid = raw.mask().reduce(ee.Reducer.min()).gt(0);

    if (classOptions.dwWater) {
      selected = selected.or(raw.eq(DYN_DW_WATER_ID));
    }
    if (classOptions.dwFloodedVeg) {
      selected = selected.or(raw.eq(DYN_DW_FLOODED_VEG_ID));
    }
  } else {
    raw = ee.Image(image).select('WTR_Water_classification');

    if (sourceKind === 'HLS') {
      var hlsOpen = raw.eq(DYN_HLS_OPEN_ID);
      var hlsPartial = raw.eq(DYN_HLS_PARTIAL_ID);
      valid = raw.eq(0).or(hlsOpen).or(hlsPartial);

      if (classOptions.hlsOpen) {
        selected = selected.or(hlsOpen);
      }
      if (classOptions.hlsPartial) {
        selected = selected.or(hlsPartial);
      }
    } else {
      var s1Open = raw.eq(DYN_S1_OPEN_ID);
      var s1Partial = raw.eq(DYN_S1_INUNDATED_VEG_ID);
      valid = raw.eq(0).or(s1Open).or(s1Partial);

      if (classOptions.s1Open) {
        selected = selected.or(s1Open);
      }
      if (classOptions.s1InundatedVeg) {
        selected = selected.or(s1Partial);
      }
    }
  }

  return selected
    .and(valid)
    .rename('selected')
    .addBands(valid.rename('valid'))
    .updateMask(valid)
    .select(DYN_SELECTED_VALID_BANDS)
    .cast(DYN_SELECTED_VALID_TYPES, DYN_SELECTED_VALID_BANDS)
    .copyProperties(image, ['system:time_start', 'system:index']);
}

function dynCollapseSelectedValidSourcePerDay(collection) {
  collection = ee.ImageCollection(collection.map(dynAddDateKey));

  var distinctDays = ee.ImageCollection(
    collection.distinct(['date_key'])
  ).sort('system:time_start');

  var join = ee.Join.saveAll({
    matchesKey: 'same_source_selected_valid_day',
    ordering: 'system:time_start',
    ascending: true
  });

  var joined = join.apply({
    primary: distinctDays,
    secondary: collection,
    condition: ee.Filter.equals({
      leftField: 'date_key',
      rightField: 'date_key'
    })
  });

  return ee.ImageCollection(joined.map(function(dayElement) {
    var representative = ee.Image(dayElement);
    var candidates = ee.ImageCollection.fromImages(
      ee.List(representative.get('same_source_selected_valid_day'))
    );

    var selectedAny = candidates.select('selected')
      .reduce(ee.Reducer.max(), DYN_SAME_DAY_PARALLEL_SCALE)
      .rename('selected')
      .unmask(0)
      .toByte();

    var validAny = candidates.select('valid')
      .reduce(ee.Reducer.max(), DYN_SAME_DAY_PARALLEL_SCALE)
      .rename('valid')
      .unmask(0)
      .toByte();

    return selectedAny
      .addBands(validAny)
      .updateMask(validAny.eq(1))
      .select(DYN_SELECTED_VALID_BANDS)
      .cast(DYN_SELECTED_VALID_TYPES, DYN_SELECTED_VALID_BANDS)
      .set({
        date_key: representative.get('date_key'),
        'system:time_start': representative.get('system:time_start')
      });
  })).sort('system:time_start');
}

function dynBuildDirectSelectedValidCollection(
  sources,
  sourceOptions,
  classOptions
) {
  var hlsS2 = sources.hlsSentinel2;

  if (
    sourceOptions.useDw &&
    sourceOptions.useHlsSentinel2 &&
    sourceOptions.hlsMsiGapFill
  ) {
    hlsS2 = dynApplySameDayDwGapFillDirect(hlsS2, sources.dw);
  }

  var allDaily = ee.ImageCollection([]);

  if (sourceOptions.useDw) {
    allDaily = allDaily.merge(
      dynCollapseSelectedValidSourcePerDay(
        sources.dw.map(function(image) {
          return dynNormalizeSelectedValidEvidence(
            image, 'DW', classOptions
          );
        })
      )
    );
  }

  if (sourceOptions.useHlsLandsat) {
    allDaily = allDaily.merge(
      dynCollapseSelectedValidSourcePerDay(
        sources.hlsLandsat.map(function(image) {
          return dynNormalizeSelectedValidEvidence(
            image, 'HLS', classOptions
          );
        })
      )
    );
  }

  if (sourceOptions.useHlsSentinel2) {
    allDaily = allDaily.merge(
      dynCollapseSelectedValidSourcePerDay(
        hlsS2.map(function(image) {
          return dynNormalizeSelectedValidEvidence(
            image, 'HLS', classOptions
          );
        })
      )
    );
  }

  if (sourceOptions.useS1) {
    allDaily = allDaily.merge(
      dynCollapseSelectedValidSourcePerDay(
        sources.s1.map(function(image) {
          return dynNormalizeSelectedValidEvidence(
            image, 'S1', classOptions
          );
        })
      )
    );
  }

  var placeholder = ee.Image.constant([0, 0])
    .rename(DYN_SELECTED_VALID_BANDS)
    .toByte()
    .updateMask(ee.Image.constant(0))
    .set({
      date_key: sources.start.format('yyyy-MM-dd'),
      'system:time_start': sources.start.millis(),
      placeholder: 1
    });

  var groupedInput = ee.ImageCollection([placeholder])
    .merge(allDaily.map(dynAddDateKey))
    .map(function(image) {
      return ee.Image(image)
        .select(DYN_SELECTED_VALID_BANDS)
        .cast(DYN_SELECTED_VALID_TYPES, DYN_SELECTED_VALID_BANDS)
        .copyProperties(image, image.propertyNames());
    });

  var distinctDates = ee.ImageCollection(
    groupedInput.distinct(['date_key'])
  ).sort('system:time_start');

  var sameDayJoin = ee.Join.saveAll({
    matchesKey: 'selected_valid_same_day_sources',
    ordering: 'system:time_start',
    ascending: true
  });

  var joinedDates = sameDayJoin.apply({
    primary: distinctDates,
    secondary: groupedInput,
    condition: ee.Filter.equals({
      leftField: 'date_key',
      rightField: 'date_key'
    })
  });

  return ee.ImageCollection(joinedDates.map(function(dayElement) {
    var representative = ee.Image(dayElement);
    var sameDay = ee.ImageCollection.fromImages(
      ee.List(representative.get('selected_valid_same_day_sources'))
    );
    var realCount = sameDay.filter(ee.Filter.neq('placeholder', 1)).size();

    var selectedAny = sameDay.select('selected')
      .reduce(ee.Reducer.max(), DYN_SAME_DAY_PARALLEL_SCALE)
      .rename('selected')
      .unmask(0)
      .toByte();

    var validAny = sameDay.select('valid')
      .reduce(ee.Reducer.max(), DYN_SAME_DAY_PARALLEL_SCALE)
      .rename('valid')
      .unmask(0)
      .toByte();

    var date = ee.Date(representative.get('system:time_start'));
    var analysisDay = ee.Image.constant(
      dynAnalysisDayNumber(date, sources.start)
    )
      .rename('analysis_day')
      .toInt16()
      .updateMask(validAny.eq(1));

    return selectedAny
      .addBands(validAny)
      .addBands(analysisDay)
      .updateMask(validAny.eq(1))
      .select(['selected', 'valid', 'analysis_day'])
      .cast(
        {selected: 'uint8', valid: 'uint8', analysis_day: 'int16'},
        ['selected', 'valid', 'analysis_day']
      )
      .set({
        date_key: representative.get('date_key'),
        'system:time_start': representative.get('system:time_start'),
        has_real_observation: ee.Number(realCount.gt(0)),
        placeholder: ee.Number(realCount.eq(0))
      });
  }))
    .filter(ee.Filter.eq('has_real_observation', 1))
    .sort('system:time_start');
}

function buildAnnualDynamicsCollection(aoi, start, end, sourceOptions, classOptions) {
  start = ee.Date(start);
  end = ee.Date(end);

  var dwSource = DYNAMICS_DW
    .filterBounds(aoi)
    .filterDate(start, end)
    .select(['label']);

  var hlsAll = DYNAMICS_HLS
    .filterBounds(aoi)
    .filterDate(start, end);

  // SPACECRAFT_NAME is the authoritative platform discriminator in the metric
  // core. SENSOR is intentionally ignored because valid Sentinel-2C assets
  // have been observed with SENSOR=OLI. system:index remains available in the
  // separate verification inspector as an independent QA check.
  var hlsLandsatSource = hlsAll
    .filter(ee.Filter.stringStartsWith('SPACECRAFT_NAME', 'Landsat-'))
    .select(['WTR_Water_classification']);
  var hlsSentinel2Source = hlsAll
    .filter(ee.Filter.stringStartsWith('SPACECRAFT_NAME', 'Sentinel-2'))
    .select(['WTR_Water_classification']);

  var s1Source = DYNAMICS_S1
    .filterBounds(aoi)
    .filterDate(start, end)
    .select(['WTR_Water_classification']);

  var dwRaw = sourceOptions.useDw ? ee.ImageCollection(dwSource.map(function(image) {
    return dynNormalizeDw(image, classOptions);
  })) : ee.ImageCollection([]);

  var hlsLandsatRaw = sourceOptions.useHlsLandsat ?
    ee.ImageCollection(hlsLandsatSource.map(function(image) {
      return dynNormalizeHls(
        image,
        classOptions,
        DYN_SOURCE_HLS_LANDSAT
      );
    })) : ee.ImageCollection([]);

  var hlsSentinel2Raw = sourceOptions.useHlsSentinel2 ?
    ee.ImageCollection(hlsSentinel2Source.map(function(image) {
      return dynNormalizeHls(
        image,
        classOptions,
        DYN_SOURCE_HLS_SENTINEL2
      );
    })) : ee.ImageCollection([]);

  var s1Raw = sourceOptions.useS1 ? ee.ImageCollection(s1Source.map(function(image) {
    return dynNormalizeS1(image, classOptions);
  })) : ee.ImageCollection([]);

  // Collapse tile/platform duplicates before cross-source fusion.
  var dwDaily = dynCollapseOneSourcePerDay(dwRaw);
  var hlsLandsatDaily = dynCollapseOneSourcePerDay(hlsLandsatRaw);
  var hlsSentinel2Daily = dynCollapseOneSourcePerDay(hlsSentinel2Raw);
  var s1Daily = dynCollapseOneSourcePerDay(s1Raw);

  var allDaily = dwDaily
    .merge(hlsLandsatDaily)
    .merge(hlsSentinel2Daily)
    .merge(s1Daily);

  var groupedInput = ee.ImageCollection([
    dynTypedMaskedRawObservation(start, aoi)
  ]).merge(allDaily.map(dynAddDateKey));

  var distinctDays = ee.ImageCollection(
    groupedInput.distinct(['date_key'])
  ).sort('system:time_start');

  var join = ee.Join.saveAll({
    matchesKey: 'cross_source_day',
    ordering: 'source_priority',
    ascending: true
  });

  var joined = join.apply({
    primary: distinctDays,
    secondary: groupedInput,
    condition: ee.Filter.equals({
      leftField: 'date_key',
      rightField: 'date_key'
    })
  });

  // The metric collection and inspector collection are mapped independently.
  // Therefore map previews never depend on the richer inspector state bands.
  var metricCollection = ee.ImageCollection(joined.map(function(dayElement) {
    var representative = ee.Image(dayElement);
    var candidates = ee.ImageCollection.fromImages(
      ee.List(representative.get('cross_source_day'))
    );
    var realCount = candidates.filter(ee.Filter.neq('placeholder', 1)).size();
    candidates = dynApplyHlsMsiGapFillLight(candidates, sourceOptions);

    var observation = sourceOptions.sameDayFusion === DYN_FUSION_PRIORITY ?
      dynBuildDailyMetricPriority(candidates) :
      dynBuildDailyMetricUnion(candidates);
    var date = ee.Date(representative.get('system:time_start'));
    var analysisDay = observation.select('valid')
      .multiply(0)
      .add(dynAnalysisDayNumber(date, start))
      .rename('analysis_day')
      .toInt16()
      .updateMask(observation.select('valid'));

    return observation
      .addBands(analysisDay)
      .select(DYN_METRIC_BAND_ORDER)
      .cast(DYN_METRIC_BAND_TYPES, DYN_METRIC_BAND_ORDER)
      .set({
        date_key: representative.get('date_key'),
        'system:time_start': date.millis(),
        has_real_observation: ee.Number(realCount.gt(0)),
        placeholder: ee.Number(realCount.eq(0))
      });
  }))
    .filter(ee.Filter.eq('has_real_observation', 1))
    .sort('system:time_start');

  var inspectorCollection = ee.ImageCollection(joined.map(function(dayElement) {
    var representative = ee.Image(dayElement);
    var candidates = ee.ImageCollection.fromImages(
      ee.List(representative.get('cross_source_day'))
    );
    var realCount = candidates.filter(ee.Filter.neq('placeholder', 1)).size();
    candidates = dynApplyHlsMsiGapFillLight(candidates, sourceOptions);

    var observation = sourceOptions.sameDayFusion === DYN_FUSION_PRIORITY ?
      dynBuildDailyPriorityLight(candidates, aoi) :
      dynBuildDailyUnionLight(candidates, aoi);
    var date = ee.Date(representative.get('system:time_start'));
    var analysisDay = observation.select('valid')
      .multiply(0)
      .add(dynAnalysisDayNumber(date, start))
      .rename('analysis_day')
      .toInt16()
      .updateMask(observation.select('valid'));

    return observation
      .addBands(analysisDay)
      .select(DYN_DAILY_BAND_ORDER)
      .cast(DYN_DAILY_BAND_TYPES, DYN_DAILY_BAND_ORDER)
      .set({
        date_key: representative.get('date_key'),
        'system:time_start': date.millis(),
        has_real_observation: ee.Number(realCount.gt(0)),
        placeholder: ee.Number(realCount.eq(0))
      });
  }))
    .filter(ee.Filter.eq('has_real_observation', 1))
    .sort('system:time_start');

  // These diagnostic graphs are deliberately separate from metricCollection.
  // They are not evaluated unless selected for preview/export or requested by
  // the point inspector.
  var diagnosticCollections = {
    dw: dynBuildDailyDiagnosticCollection(
      sourceOptions.useDw ? dwSource : ee.ImageCollection([]),
      DYN_DIAG_KIND_DW,
      aoi,
      start
    ),
    hlsLandsat: dynBuildDailyDiagnosticCollection(
      sourceOptions.useHlsLandsat ? hlsLandsatSource : ee.ImageCollection([]),
      DYN_DIAG_KIND_HLS,
      aoi,
      start
    ),
    hlsSentinel2: dynBuildDailyDiagnosticCollection(
      sourceOptions.useHlsSentinel2 ? hlsSentinel2Source : ee.ImageCollection([]),
      DYN_DIAG_KIND_HLS,
      aoi,
      start
    ),
    s1: dynBuildDailyDiagnosticCollection(
      sourceOptions.useS1 ? s1Source : ee.ImageCollection([]),
      DYN_DIAG_KIND_S1,
      aoi,
      start
    )
  };

  return {
    collection: metricCollection,
    inspectorCollection: inspectorCollection,
    rawCollections: {
      dw: dwRaw,
      hlsLandsat: hlsLandsatRaw,
      hlsSentinel2: hlsSentinel2Raw,
      s1: s1Raw,
      dwVerification: dwSource,
      hlsAllTagged: hlsAll.map(dynTagHlsPlatform),
      hlsLandsatSource: hlsLandsatSource,
      hlsSentinel2Source: hlsSentinel2Source,
      s1Source: s1Source
    },
    diagnosticCollections: diagnosticCollections
  };
}

// ------------------------------------------------------
// Hydrological-period dynamics metric helpers
// ------------------------------------------------------

function dynMaskedConstant(name) {
  return ee.Image.constant(0)
    .rename(name)
    .updateMask(ee.Image(0));
}

function dynConditionAnalysisDaySingle(
  collection,
  conditionBand,
  reducerName,
  outputName
) {
  var candidates = ee.ImageCollection(collection.map(function(image) {
    return image.select('analysis_day')
      .updateMask(image.select(conditionBand).eq(1));
  }));

  if (reducerName === 'max') {
    return candidates
      .reduce(ee.Reducer.max(), DYN_REDUCE_PARALLEL_SCALE)
      .rename(outputName)
      .toInt16();
  }

  return candidates
    .reduce(ee.Reducer.min(), DYN_REDUCE_PARALLEL_SCALE)
    .rename(outputName)
    .toInt16();
}

function dynConditionAnalysisDayMinMax(
  collection,
  conditionBand,
  firstOutputName,
  lastOutputName
) {
  // Build one conditional analysis-day collection and obtain the minimum and maximum
  // in one traversal. Earlier versions calculated first and last dates with
  // two independent collection reductions. A span layer then had to evaluate
  // both full reductions in the same map-tile request, which could exceed the
  // interactive memory limit after the source graph became more complex.
  var candidates = collection.map(function(image) {
    return image.select('analysis_day')
      .updateMask(image.select(conditionBand).eq(1))
      .rename('condition_analysis_day')
      .toInt16();
  });

  var minMax = candidates
    .reduce(ee.Reducer.minMax(), DYN_REDUCE_PARALLEL_SCALE);

  return {
    first: minMax.select('condition_analysis_day_min')
      .rename(firstOutputName)
      .toInt16(),
    last: minMax.select('condition_analysis_day_max')
      .rename(lastOutputName)
      .toInt16()
  };
}

function dynFirstDryAfterLastWet(collection, lastWet) {
  return collection.map(function(image) {
    var analysisDay = image.select('analysis_day');
    var candidate = image.select('dry').eq(1)
      .and(analysisDay.gt(lastWet));

    return analysisDay.updateMask(candidate);
  })
  .reduce(ee.Reducer.min(), DYN_REDUCE_PARALLEL_SCALE)
  .rename('first_dry_after_final_selected_analysis_day')
  .toInt16();
}

function dynSpan(firstImage, lastImage, name) {
  return lastImage
    .subtract(firstImage)
    .add(1)
    .rename(name)
    .updateMask(firstImage.mask().and(lastImage.mask()))
    .toInt16();
}

function dynSelectedValidCountSummary(collection) {
  // Selected and valid counts are derived in one two-band sum reduction.
  // This prevents the fraction layer from evaluating two independent full
  // collection reductions simultaneously.
  var countInputs = collection.map(function(image) {
    return image.select(['selected', 'valid'])
      .unmask(0)
      .rename(['selected_count_input', 'valid_count_input'])
      .toInt16();
  });

  var sums = countInputs
    .reduce(ee.Reducer.sum(), DYN_REDUCE_PARALLEL_SCALE);

  return {
    selected: sums.select('selected_count_input_sum')
      .rename('selected_observation_count')
      .toInt16(),
    valid: sums.select('valid_count_input_sum')
      .rename('valid_observation_count')
      .toInt16()
  };
}

function dynObservationCount(collection, conditionBand, outputName) {
  return collection.map(function(image) {
    return image.select(conditionBand)
      .eq(1)
      .rename(outputName)
      .unmask(0)
      .toInt16();
  })
  .reduce(ee.Reducer.sum(), DYN_REDUCE_PARALLEL_SCALE)
  .rename(outputName)
  .toInt16();
}

function dynSourceValidObservationCount(
  collection,
  sourceBit,
  outputName
) {
  return collection.map(function(image) {
    return image.select('valid_source_mask')
      .bitwiseAnd(sourceBit)
      .neq(0)
      .rename(outputName)
      .unmask(0)
      .toInt16();
  })
  .reduce(ee.Reducer.sum(), DYN_REDUCE_PARALLEL_SCALE)
  .rename(outputName)
  .toInt16();
}

function dynWetFractionFromCounts(selectedCount, validCount) {
  return selectedCount
    .divide(validCount)
    .rename('selected_observation_fraction')
    .updateMask(validCount.gt(0))
    .toFloat();
}

function dynSourceAtAnalysisDay(collection, targetAnalysisDay, outputName) {
  return collection.map(function(image) {
    var onTargetDate = image.select('analysis_day').eq(targetAnalysisDay);

    return image.select('selected_source_mask')
      .updateMask(image.select('selected').eq(1).and(onTargetDate));
  })
  .reduce(ee.Reducer.max(), DYN_REDUCE_PARALLEL_SCALE)
  .rename(outputName)
  .toByte();
}

function dynSequenceMetrics(collection, maxGapDays) {
  // Use the union of all valid-observation footprints. No collection-to-list
  // conversion is used; iterate() runs directly over the ordered collection.
  var template = collection
    .select('valid')
    .reduce(ee.Reducer.max(), DYN_REDUCE_PARALLEL_SCALE)
    .rename('valid')
    .unmask(0)
    .multiply(0)
    .toInt16();

  var initial = template.rename('previous_analysis_day')
    .addBands(template.rename('previous_selected'))
    .addBands(template.rename('has_previous'))
    .addBands(template.rename('run_start_analysis_day'))
    .addBands(template.rename('selected_episode_count'))
    .addBands(template.rename('longest_selected_spell_days'))
    .addBands(template.rename('maximum_valid_gap_days'));

  var result = ee.Image(collection.iterate(function(item, accumulator) {
    var image = ee.Image(item);
    var acc = ee.Image(accumulator);

    var valid = image.select('valid').eq(1).unmask(0);
    var selected = image.select('selected').eq(1).unmask(0);
    var analysisDay = image.select('analysis_day').unmask(0).toInt16();

    var previousAnalysisDay = acc.select('previous_analysis_day');
    var previousSelected = acc.select('previous_selected');
    var hasPrevious = acc.select('has_previous');
    var previousRunStart = acc.select('run_start_analysis_day');

    var gap = analysisDay.subtract(previousAnalysisDay);
    var hasComparablePrevious = valid.and(hasPrevious.eq(1));
    var continuous = hasComparablePrevious
      .and(previousSelected.eq(1))
      .and(gap.lte(maxGapDays));

    var selectedValid = valid.and(selected);
    var startsEpisode = selectedValid.and(continuous.not());

    var runStart = previousRunStart;
    runStart = runStart.where(valid.and(selected.not()), 0);
    runStart = runStart.where(startsEpisode, analysisDay);

    var currentRunDays = analysisDay
      .subtract(runStart)
      .add(1)
      .where(selectedValid.not(), 0);

    var episodes = acc.select('selected_episode_count')
      .add(startsEpisode.toInt16());

    var longest = acc.select('longest_selected_spell_days')
      .max(currentRunDays);

    var maximumGap = acc.select('maximum_valid_gap_days')
      .max(gap.where(hasComparablePrevious.not(), 0));

    var nextPreviousAnalysisDay = previousAnalysisDay.where(valid, analysisDay);
    var nextPreviousSelected = previousSelected.where(
      valid,
      selected.toInt16()
    );
    var nextHasPrevious = hasPrevious.where(valid, 1);

    return nextPreviousAnalysisDay
      .rename('previous_analysis_day')
      .addBands(nextPreviousSelected.rename('previous_selected'))
      .addBands(nextHasPrevious.rename('has_previous'))
      .addBands(runStart.rename('run_start_analysis_day'))
      .addBands(episodes.rename('selected_episode_count'))
      .addBands(longest.rename('longest_selected_spell_days'))
      .addBands(maximumGap.rename('maximum_valid_gap_days'))
      .toInt16();
  }, initial));

  return result.select([
    'selected_episode_count',
    'longest_selected_spell_days',
    'maximum_valid_gap_days'
  ]);
}

function dynAddLayer(image, vis, label, isFirstLayer) {
  Map.addLayer(
    image,
    vis,
    label,
    isFirstLayer
  );
}

function dynAppendBand(stack, image) {
  if (stack === null) {
    return image;
  }

  return ee.Image(stack).addBands(image);
}

// ------------------------------------------------------
// Run and export selected-period dynamics
// ------------------------------------------------------


function dynAnyCheckboxSelected(checkboxes) {
  return checkboxes.some(function(checkbox) {
    return checkbox.getValue();
  });
}

function runAnnualDynamics() {
  var aoi = dynRequireAoi();

  if (aoi === null) {
    return;
  }

  var period = dynReadPeriodConfig();

  if (period.error) {
    dynSetStatus(period.error);
    return;
  }

  var start = period.start;
  var end = period.end;
  var periodDays = period.periodDays;
  var periodLabel = period.displayLabel;
  var useHlsMaster = dynamicsUseHls.getValue();

  var sourceOptions = {
    useDw: dynamicsUseDw.getValue(),
    useHlsLandsat: useHlsMaster && dynamicsUseHlsLandsat.getValue(),
    useHlsSentinel2: useHlsMaster && dynamicsUseHlsSentinel2.getValue(),
    hlsMsiGapFill: dynamicsHlsMsiGapFill.getValue(),
    useS1: dynamicsUseS1.getValue(),
    sameDayFusion: dynamicsSameDayFusion.getValue()
  };

  if (
    !sourceOptions.useDw &&
    !sourceOptions.useHlsLandsat &&
    !sourceOptions.useHlsSentinel2 &&
    !sourceOptions.useS1
  ) {
    dynSetStatus('Select at least one observation source.');
    return;
  }

  if (
    useHlsMaster &&
    !sourceOptions.useHlsLandsat &&
    !sourceOptions.useHlsSentinel2
  ) {
    dynSetStatus(
      'OPERA-HLS is enabled. Select Landsat/OLI and/or Sentinel-2/MSI.'
    );
    return;
  }

  if (dynDwValidCount.getValue() && !sourceOptions.useDw) {
    dynSetStatus('DW valid-date count is selected, but Dynamic World is disabled.');
    return;
  }

  if (
    dynHlsLandsatValidCount.getValue() &&
    !sourceOptions.useHlsLandsat
  ) {
    dynSetStatus(
      'HLS Landsat valid-date count is selected, but HLS Landsat is disabled.'
    );
    return;
  }

  if (
    dynHlsSentinel2ValidCount.getValue() &&
    !sourceOptions.useHlsSentinel2
  ) {
    dynSetStatus(
      'HLS Sentinel-2 valid-date count is selected, but HLS Sentinel-2 is disabled.'
    );
    return;
  }

  if (dynS1ValidCount.getValue() && !sourceOptions.useS1) {
    dynSetStatus('OPERA-S1 valid-date count is selected, but S1 is disabled.');
    return;
  }

  if (
    dynAnyCheckboxSelected(dynDwDiagnosticCheckboxes) &&
    !sourceOptions.useDw
  ) {
    dynSetStatus('A Dynamic World raw diagnostic is selected, but DW is disabled.');
    return;
  }
  if (
    dynAnyCheckboxSelected(dynHlsLandsatDiagnosticCheckboxes) &&
    !sourceOptions.useHlsLandsat
  ) {
    dynSetStatus('An HLS Landsat raw diagnostic is selected, but that source is disabled.');
    return;
  }
  if (
    dynAnyCheckboxSelected(dynHlsSentinel2DiagnosticCheckboxes) &&
    !sourceOptions.useHlsSentinel2
  ) {
    dynSetStatus('An HLS Sentinel-2 raw diagnostic is selected, but that source is disabled.');
    return;
  }
  if (
    dynAnyCheckboxSelected(dynS1DiagnosticCheckboxes) &&
    !sourceOptions.useS1
  ) {
    dynSetStatus('An OPERA-S1 raw diagnostic is selected, but S1 is disabled.');
    return;
  }

  var classOptions = getDynamicsClassOptions();

  if (
    sourceOptions.useDw &&
    !classOptions.dwWater &&
    !classOptions.dwFloodedVeg
  ) {
    dynSetStatus(
      'Dynamic World is enabled. Select water and/or flooded vegetation.'
    );
    return;
  }

  if (
    (sourceOptions.useHlsLandsat || sourceOptions.useHlsSentinel2) &&
    !classOptions.hlsOpen &&
    !classOptions.hlsPartial
  ) {
    dynSetStatus(
      'OPERA-HLS is enabled. Select open water and/or partial surface water.'
    );
    return;
  }

  if (
    sourceOptions.useS1 &&
    !classOptions.s1Open &&
    !classOptions.s1InundatedVeg
  ) {
    dynSetStatus(
      'OPERA-S1 is enabled. Select open water and/or inundated vegetation.'
    );
    return;
  }

  var hasOpenClass = dynHasOpenClass(sourceOptions, classOptions);
  var hasPartialClass = dynHasPartialClass(sourceOptions, classOptions);

  var openMetricSelected = dynFirstOpen.getValue() ||
    dynLastOpen.getValue() ||
    dynOpenSpan.getValue();

  var partialMetricSelected = dynFirstPartial.getValue() ||
    dynLastPartial.getValue() ||
    dynPartialSpan.getValue();

  if (openMetricSelected && !hasOpenClass) {
    dynSetStatus(
      'An open-water metric is selected, but no open-water class is enabled.'
    );
    return;
  }

  if (partialMetricSelected && !hasPartialClass) {
    dynSetStatus(
      'An inundated/partial metric is selected, but no corresponding class ' +
      'is enabled.'
    );
    return;
  }

  if (
    dynOpenToPartialLag.getValue() &&
    (!hasOpenClass || !hasPartialClass)
  ) {
    dynSetStatus(
      'The open-to-inundated/partial lag requires both class groups.'
    );
    return;
  }

  var selectedMetricCount = 0;
  [
    dynFirstWet,
    dynLastWet,
    dynFirstDryAfterWet,
    dynFirstOpen,
    dynLastOpen,
    dynFirstPartial,
    dynLastPartial,
    dynOpenToPartialLag,
    dynWetSpan,
    dynOpenSpan,
    dynPartialSpan,
    dynWetCount,
    dynWetFraction,
    dynEpisodes,
    dynLongestSpell,
    dynValidCount,
    dynDwValidCount,
    dynHlsLandsatValidCount,
    dynHlsSentinel2ValidCount,
    dynS1ValidCount,
    dynFirstWetSource,
    dynLastWetSource,
    dynMaximumGap,
    dynConflictCount
  ].concat(
    dynDwDiagnosticCheckboxes,
    dynHlsLandsatDiagnosticCheckboxes,
    dynHlsSentinel2DiagnosticCheckboxes,
    dynS1DiagnosticCheckboxes
  ).forEach(function(checkbox) {
    if (checkbox.getValue()) {
      selectedMetricCount++;
    }
  });

  if (selectedMetricCount === 0) {
    dynSetStatus('Select at least one dynamics metric.');
    return;
  }

  var maxGapDays = Number(dynamicsMaxGapBox.getValue());

  if (!maxGapDays || maxGapDays < 1) {
    maxGapDays = 20;
  }

  dynSetBusy(
    true,
    'Stage 1/3: building a memory-safe daily observation graph…'
  );

  // Remove any stale inspector result from a previous run. The inspector can
  // be used again immediately after the new observation graph is prepared.
  dynSetInspectorVisibility(false, false);
  dynRemoveInspectorPointLayer();
  dynInspectorPoint = null;
  dynInspectorCoordinates = null;
  lastDynamicsObservations = null;
  lastDynamicsYear = null;
  lastDynamicsPeriodFileLabel = null;
  lastDynamicsRawHls = null;
  lastDynamicsRawDw = null;
  lastDynamicsSourceOptions = null;
  lastDynamicsDiagnosticCollections = null;
  lastDynamicsLazyRunConfig = null;
  dynLastHlsVerificationFeatures = null;
  dynInspectorRequestToken++;

  // Add the AOI immediately. No full collection count is evaluated before
  // map-layer creation, so the interface no longer blocks on size/list work.
  Map.layers().reset();
  dynInspectorPointLayer = null;
  dynPreviewLayers = {};
  dynCurrentPreviewLabel = null;
  dynPreviewProducts = {};
  dynPreviewProductOrder = [];
  if (dynamicsPreviewMetricSelect !== null) {
    dynamicsPreviewMetricSelect.items().reset([]);
    dynamicsPreviewMetricSelect.setDisabled(true);
  }
  if (dynamicsLoadPreviewButton !== null) {
    dynamicsLoadPreviewButton.setDisabled(true);
  }
  Map.addLayer(aoi, {color: 'red'}, 'AOI');
  Map.centerObject(aoi, 10);

  dynSetStatus(
    'Stage 2/3: selecting the smallest metric engine for each product…'
  );

  // Timing products use the successful direct per-source benchmark engine
  // under the recommended any-water fusion rule. Priority fusion retains the
  // exact daily-fusion pathway because a lower-priority wet detection can be
  // overridden by a higher-priority dry classification on the same date.
  var useDirectTiming =
    sourceOptions.sameDayFusion === DYN_FUSION_ANY_WATER;

  // First-dry timing has its own lightweight two-band daily engine under the
  // recommended any-water fusion rule. Priority fusion still requires the
  // complete daily collection because a higher-priority classification can
  // suppress lower-priority evidence on the same date.
  var useDirectFirstDry = useDirectTiming &&
    dynFirstDryAfterWet.getValue();

  var needFirstSelected = dynFirstWet.getValue() ||
    dynWetSpan.getValue() || dynFirstWetSource.getValue();
  var needLastSelected = dynLastWet.getValue() ||
    dynWetSpan.getValue() || dynFirstDryAfterWet.getValue() ||
    dynLastWetSource.getValue();
  var needFirstOpen = dynFirstOpen.getValue() ||
    dynOpenSpan.getValue() || dynOpenToPartialLag.getValue();
  var needLastOpen = dynLastOpen.getValue() || dynOpenSpan.getValue();
  var needFirstPartial = dynFirstPartial.getValue() ||
    dynPartialSpan.getValue() || dynOpenToPartialLag.getValue();
  var needLastPartial = dynLastPartial.getValue() || dynPartialSpan.getValue();

  var directSources = dynPrepareDirectSources(aoi, start, end);
  var directTiming = useDirectTiming ? dynBuildDirectTimingImages(
    directSources,
    sourceOptions,
    classOptions,
    {
      firstSelected: needFirstSelected,
      lastSelected: needLastSelected,
      firstOpen: needFirstOpen,
      lastOpen: needLastOpen,
      firstPartial: needFirstPartial,
      lastPartial: needLastPartial
    }
  ) : null;

  var diagnosticMetricSelected = dynAnyCheckboxSelected(
    dynDwDiagnosticCheckboxes
  ) || dynAnyCheckboxSelected(
    dynHlsLandsatDiagnosticCheckboxes
  ) || dynAnyCheckboxSelected(
    dynHlsSentinel2DiagnosticCheckboxes
  ) || dynAnyCheckboxSelected(
    dynS1DiagnosticCheckboxes
  );

  var timingMetricSelected = needFirstSelected || needLastSelected ||
    needFirstOpen || needLastOpen || needFirstPartial || needLastPartial;

  var selectedValidMetricSelected =
    dynWetCount.getValue() ||
    dynWetFraction.getValue() ||
    dynEpisodes.getValue() ||
    dynLongestSpell.getValue() ||
    dynValidCount.getValue() ||
    dynMaximumGap.getValue();

  // Under "Any selected water wins", counts and sequence metrics use the
  // lightweight selected/valid daily engine. Priority fusion still requires
  // the complete daily collection because a higher-priority dry or
  // unselected-water observation can suppress a lower-priority detection.
  var useDirectSelectedValid =
    useDirectTiming && selectedValidMetricSelected;

  var needDailyEngine =
    (!useDirectTiming && timingMetricSelected) ||
    (dynFirstDryAfterWet.getValue() && !useDirectFirstDry) ||
    (selectedValidMetricSelected && !useDirectSelectedValid) ||
    dynDwValidCount.getValue() ||
    dynHlsLandsatValidCount.getValue() ||
    dynHlsSentinel2ValidCount.getValue() ||
    dynS1ValidCount.getValue() ||
    dynFirstWetSource.getValue() ||
    dynLastWetSource.getValue() ||
    dynConflictCount.getValue() ||
    diagnosticMetricSelected;

  var annual = needDailyEngine ? buildAnnualDynamicsCollection(
    aoi,
    start,
    end,
    sourceOptions,
    classOptions
  ) : null;

  var observations = annual === null ? null : annual.collection;

  var selectedValidObservations = selectedValidMetricSelected ? (
    useDirectSelectedValid ? dynBuildDirectSelectedValidCollection(
      directSources,
      sourceOptions,
      classOptions
    ) : observations
  ) : null;

  var firstSelected = needFirstSelected ? (
    useDirectTiming ? directTiming.firstSelected : dynConditionAnalysisDaySingle(
      observations, 'selected', 'min', 'first_selected_class_analysis_day'
    )
  ) : null;
  var lastSelected = needLastSelected ? (
    useDirectTiming ? directTiming.lastSelected : dynConditionAnalysisDaySingle(
      observations, 'selected', 'max', 'last_selected_class_analysis_day'
    )
  ) : null;
  var firstOpen = needFirstOpen ? (
    useDirectTiming ? directTiming.firstOpen : dynConditionAnalysisDaySingle(
      observations, 'open', 'min', 'first_open_water_analysis_day'
    )
  ) : null;
  var lastOpen = needLastOpen ? (
    useDirectTiming ? directTiming.lastOpen : dynConditionAnalysisDaySingle(
      observations, 'open', 'max', 'last_open_water_analysis_day'
    )
  ) : null;
  var firstPartial = needFirstPartial ? (
    useDirectTiming ? directTiming.firstPartial : dynConditionAnalysisDaySingle(
      observations, 'partial', 'min', 'first_inundated_partial_analysis_day'
    )
  ) : null;
  var lastPartial = needLastPartial ? (
    useDirectTiming ? directTiming.lastPartial : dynConditionAnalysisDaySingle(
      observations, 'partial', 'max', 'last_inundated_partial_analysis_day'
    )
  ) : null;

  var firstDryAfterSelected = dynFirstDryAfterWet.getValue() ? (
    useDirectFirstDry ? dynBuildDirectFirstDryAfterLastSelected(
      directSources, sourceOptions, classOptions, lastSelected
    ) : dynFirstDryAfterLastWet(observations, lastSelected)
  ) : null;

  var needSelectedCount = dynWetCount.getValue() || dynWetFraction.getValue();
  var needValidCount = dynValidCount.getValue() || dynWetFraction.getValue() ||
    dynMaximumGap.getValue();
  var selectedObservationCount = needSelectedCount ? dynObservationCount(
    selectedValidObservations,
    'selected',
    'selected_class_observation_count'
  ) : null;
  var fusedValidObservationCount = needValidCount ? dynObservationCount(
    selectedValidObservations,
    'valid',
    'valid_observation_count'
  ) : null;

  var needsSequence = dynEpisodes.getValue() ||
    dynLongestSpell.getValue() ||
    dynMaximumGap.getValue();

  var sequence = needsSequence ?
    dynSequenceMetrics(selectedValidObservations, maxGapDays) :
    null;

  var stack = null;
  var bandNames = [];
  var legendEntries = [];
  var previewEntries = [];

  function addSelected(image, vis, label, legendType) {
    var clipped = ee.Image(image).clip(aoi);
    var entry = {
      label: label,
      image: clipped,
      vis: vis,
      type: legendType,
      periodStartMillis: period.startMillis,
      periodEndExclusiveMillis: period.endExclusiveMillis,
      periodDays: period.periodDays,
      periodMonths: period.periodMonths,
      firstHalfEndDay: period.firstHalfEndDay,
      periodLabel: period.displayLabel
    };

    if (legendType === 'ANALYSIS_DAY') {
      entry.isAnalysisDayTiming = true;
      dynConfigureTimingPreview(
        entry,
        dynamicsTimingVis.getValue()
      );
    }

    previewEntries.push(entry);
    legendEntries.push(entry);

    stack = dynAppendBand(stack, clipped);
    bandNames.push(clipped.bandNames().get(0));
    return entry;
  }

  var timingViridisVis = dynTimingContinuousVis(
    periodDays,
    DYN_ANALYSIS_DAY_VIS.palette
  );

  if (dynFirstWet.getValue()) {
    addSelected(
      firstSelected,
      timingViridisVis,
      'First observed selected-water day (analysis day)',
      'ANALYSIS_DAY'
    );
  }

  if (dynLastWet.getValue()) {
    addSelected(
      lastSelected,
      timingViridisVis,
      'Last selected water-class day (analysis day)',
      'ANALYSIS_DAY'
    );
  }

  if (dynFirstDryAfterWet.getValue()) {
    addSelected(
      firstDryAfterSelected,
      timingViridisVis,
      'First dry day after final selected detection (analysis day)',
      'ANALYSIS_DAY'
    );
  }

  if (dynFirstOpen.getValue()) {
    addSelected(
      firstOpen,
      timingViridisVis,
      'First observed open-water day (analysis day)',
      'ANALYSIS_DAY'
    );
  }

  if (dynLastOpen.getValue()) {
    addSelected(
      lastOpen,
      timingViridisVis,
      'Last observed open-water day (analysis day)',
      'ANALYSIS_DAY'
    );
  }

  if (dynFirstPartial.getValue()) {
    addSelected(
      firstPartial,
      timingViridisVis,
      'First observed inundated/partial day (analysis day)',
      'ANALYSIS_DAY'
    );
  }

  if (dynLastPartial.getValue()) {
    addSelected(
      lastPartial,
      timingViridisVis,
      'Last observed inundated/partial day (analysis day)',
      'ANALYSIS_DAY'
    );
  }

  if (dynOpenToPartialLag.getValue()) {
    var lag = firstPartial
      .subtract(firstOpen)
      .rename('open_to_inundated_partial_lag_days')
      .updateMask(firstOpen.mask().and(firstPartial.mask()))
      .updateMask(firstPartial.gte(firstOpen))
      .toInt16();

    addSelected(
      lag,
      DYN_DURATION_VIS,
      'Lag: open water to inundated/partial (days)',
      'DURATION'
    );
  }

  if (dynWetSpan.getValue()) {
    addSelected(
      dynSpan(
        firstSelected,
        lastSelected,
        'observed_selected_class_span_days'
      ),
      DYN_DURATION_VIS,
      'Observed selected-class span (days)',
      'DURATION'
    );
  }

  if (dynOpenSpan.getValue()) {
    addSelected(
      dynSpan(firstOpen, lastOpen, 'observed_open_water_span_days'),
      DYN_DURATION_VIS,
      'Observed open-water span (days)',
      'DURATION'
    );
  }

  if (dynPartialSpan.getValue()) {
    addSelected(
      dynSpan(
        firstPartial,
        lastPartial,
        'observed_inundated_partial_span_days'
      ),
      DYN_DURATION_VIS,
      'Observed inundated/partial span (days)',
      'DURATION'
    );
  }

  if (dynWetCount.getValue()) {
    addSelected(
      selectedObservationCount,
      DYN_COUNT_VIS,
      'Selected-class observation count',
      'COUNT'
    );
  }

  if (dynWetFraction.getValue()) {
    addSelected(
      dynWetFractionFromCounts(
        selectedObservationCount,
        fusedValidObservationCount
      ),
      DYN_FRACTION_VIS,
      'Selected-class fraction of valid observations',
      'FRACTION'
    );
  }

  if (dynEpisodes.getValue()) {
    addSelected(
      sequence.select('selected_episode_count'),
      DYN_EPISODE_VIS,
      'Observed selected-class episodes',
      'EPISODES'
    );
  }

  if (dynLongestSpell.getValue()) {
    addSelected(
      sequence.select('longest_selected_spell_days'),
      DYN_DURATION_VIS,
      'Longest gap-aware selected-class spell (days)',
      'DURATION'
    );
  }

  if (dynValidCount.getValue()) {
    addSelected(
      fusedValidObservationCount,
      DYN_VALID_COUNT_VIS,
      'Fused valid observation-date count',
      'VALID_COUNT'
    );
  }

  if (dynDwValidCount.getValue()) {
    addSelected(
      dynSourceValidObservationCount(
        observations,
        DYN_SOURCE_DW,
        'dw_valid_observation_count'
      ),
      DYN_VALID_COUNT_VIS,
      'DW-supported valid date count',
      'VALID_COUNT'
    );
  }

  if (dynHlsLandsatValidCount.getValue()) {
    addSelected(
      dynSourceValidObservationCount(
        observations,
        DYN_SOURCE_HLS_LANDSAT,
        'hls_landsat_valid_observation_count'
      ),
      DYN_VALID_COUNT_VIS,
      'HLS Landsat-supported valid date count',
      'VALID_COUNT'
    );
  }

  if (dynHlsSentinel2ValidCount.getValue()) {
    addSelected(
      dynSourceValidObservationCount(
        observations,
        DYN_SOURCE_HLS_SENTINEL2,
        'hls_sentinel2_valid_observation_count'
      ),
      DYN_VALID_COUNT_VIS,
      'HLS Sentinel-2-supported valid date count',
      'VALID_COUNT'
    );
  }

  if (dynS1ValidCount.getValue()) {
    addSelected(
      dynSourceValidObservationCount(
        observations,
        DYN_SOURCE_S1,
        's1_valid_observation_count'
      ),
      DYN_VALID_COUNT_VIS,
      'OPERA-S1-supported valid date count',
      'VALID_COUNT'
    );
  }

  function addRawDiagnostic(
    checkbox,
    collection,
    conditionBand,
    outputName,
    label
  ) {
    if (!checkbox.getValue()) {
      return;
    }
    addSelected(
      dynDiagnosticCount(collection, conditionBand, outputName),
      DYN_VALID_COUNT_VIS,
      label,
      'VALID_COUNT'
    );
  }

  var diag = annual === null ? null : annual.diagnosticCollections;

  // In a direct-timing-only run, the daily/diagnostic engine is deliberately
  // not constructed and `diag` is null. JavaScript evaluates function
  // arguments before entering addRawDiagnostic(), so expressions such as
  // `diag.dw` must not be referenced merely because a checkbox is off.
  if (diag !== null) {
    addRawDiagnostic(
    dynDwAssetFootprintCount,
    diag.dw,
    'asset_footprint',
    'dw_asset_footprint_date_count',
    'DW raw asset-footprint date count'
  );
  addRawDiagnostic(
    dynDwMaskedNoValueCount,
    diag.dw,
    'masked_no_value',
    'dw_masked_no_label_date_count',
    'DW asset date with masked/no label count'
  );

  addRawDiagnostic(
    dynHlsLandsatAssetFootprintCount,
    diag.hlsLandsat,
    'asset_footprint',
    'hls_landsat_asset_footprint_date_count',
    'HLS Landsat raw asset-footprint date count'
  );
  addRawDiagnostic(
    dynHlsLandsatProductValueCount,
    diag.hlsLandsat,
    'product_value',
    'hls_landsat_product_value_date_count',
    'HLS Landsat unmasked product-value date count'
  );
  addRawDiagnostic(
    dynHlsLandsatRawUsableCount,
    diag.hlsLandsat,
    'usable_state',
    'hls_landsat_raw_usable_state_date_count',
    'HLS Landsat raw usable water-state date count'
  );
  addRawDiagnostic(
    dynHlsLandsatExcludedCount,
    diag.hlsLandsat,
    'excluded_state',
    'hls_landsat_excluded_date_count',
    'HLS Landsat excluded/unusable date count'
  );
  addRawDiagnostic(
    dynHlsLandsatNotWaterCount,
    diag.hlsLandsat,
    'not_water',
    'hls_landsat_not_water_class0_date_count',
    'HLS Landsat class 0 not-water date count'
  );
  addRawDiagnostic(
    dynHlsLandsatSnowMaskCount,
    diag.hlsLandsat,
    'mask_252_snow_ice',
    'hls_landsat_snow_ice_mask_date_count',
    'HLS Landsat class 252 snow/ice date count'
  );
  addRawDiagnostic(
    dynHlsLandsatCloudMaskCount,
    diag.hlsLandsat,
    'mask_253_cloud_shadow',
    'hls_landsat_cloud_shadow_mask_date_count',
    'HLS Landsat class 253 cloud/shadow date count'
  );
  addRawDiagnostic(
    dynHlsLandsatOceanMaskCount,
    diag.hlsLandsat,
    'mask_254_ocean',
    'hls_landsat_ocean_mask_date_count',
    'HLS Landsat class 254 ocean-mask date count'
  );
  addRawDiagnostic(
    dynHlsLandsatMaskedNoValueCount,
    diag.hlsLandsat,
    'masked_no_value',
    'hls_landsat_masked_no_value_date_count',
    'HLS Landsat masked/no-value date count'
  );

  addRawDiagnostic(
    dynHlsSentinel2AssetFootprintCount,
    diag.hlsSentinel2,
    'asset_footprint',
    'hls_sentinel2_asset_footprint_date_count',
    'HLS Sentinel-2 raw asset-footprint date count'
  );
  addRawDiagnostic(
    dynHlsSentinel2ProductValueCount,
    diag.hlsSentinel2,
    'product_value',
    'hls_sentinel2_product_value_date_count',
    'HLS Sentinel-2 unmasked product-value date count'
  );
  addRawDiagnostic(
    dynHlsSentinel2RawUsableCount,
    diag.hlsSentinel2,
    'usable_state',
    'hls_sentinel2_raw_usable_state_date_count',
    'HLS Sentinel-2 raw usable water-state date count'
  );
  addRawDiagnostic(
    dynHlsSentinel2ExcludedCount,
    diag.hlsSentinel2,
    'excluded_state',
    'hls_sentinel2_excluded_date_count',
    'HLS Sentinel-2 excluded/unusable date count'
  );
  addRawDiagnostic(
    dynHlsSentinel2NotWaterCount,
    diag.hlsSentinel2,
    'not_water',
    'hls_sentinel2_not_water_class0_date_count',
    'HLS Sentinel-2 class 0 not-water date count'
  );
  addRawDiagnostic(
    dynHlsSentinel2SnowMaskCount,
    diag.hlsSentinel2,
    'mask_252_snow_ice',
    'hls_sentinel2_snow_ice_mask_date_count',
    'HLS Sentinel-2 class 252 snow/ice date count'
  );
  addRawDiagnostic(
    dynHlsSentinel2CloudMaskCount,
    diag.hlsSentinel2,
    'mask_253_cloud_shadow',
    'hls_sentinel2_cloud_shadow_mask_date_count',
    'HLS Sentinel-2 class 253 cloud/shadow date count'
  );
  addRawDiagnostic(
    dynHlsSentinel2OceanMaskCount,
    diag.hlsSentinel2,
    'mask_254_ocean',
    'hls_sentinel2_ocean_mask_date_count',
    'HLS Sentinel-2 class 254 ocean-mask date count'
  );
  addRawDiagnostic(
    dynHlsSentinel2MaskedNoValueCount,
    diag.hlsSentinel2,
    'masked_no_value',
    'hls_sentinel2_masked_no_value_date_count',
    'HLS Sentinel-2 masked/no-value date count'
  );

  addRawDiagnostic(
    dynS1AssetFootprintCount,
    diag.s1,
    'asset_footprint',
    's1_asset_footprint_date_count',
    'OPERA-S1 raw asset-footprint date count'
  );
  addRawDiagnostic(
    dynS1ProductValueCount,
    diag.s1,
    'product_value',
    's1_product_value_date_count',
    'OPERA-S1 unmasked product-value date count'
  );
  addRawDiagnostic(
    dynS1RawUsableCount,
    diag.s1,
    'usable_state',
    's1_raw_usable_state_date_count',
    'OPERA-S1 raw usable water-state date count'
  );
  addRawDiagnostic(
    dynS1ExcludedCount,
    diag.s1,
    'excluded_state',
    's1_excluded_date_count',
    'OPERA-S1 excluded/unusable date count'
  );
  addRawDiagnostic(
    dynS1NotWaterCount,
    diag.s1,
    'not_water',
    's1_not_water_class0_date_count',
    'OPERA-S1 class 0 not-water date count'
  );
  addRawDiagnostic(
    dynS1HandMaskCount,
    diag.s1,
    'mask_250_hand',
    's1_hand_mask_date_count',
    'OPERA-S1 class 250 HAND-mask date count'
  );
  addRawDiagnostic(
    dynS1LayoverMaskCount,
    diag.s1,
    'mask_251_layover_shadow',
    's1_layover_shadow_mask_date_count',
    'OPERA-S1 class 251 layover/shadow date count'
  );
  addRawDiagnostic(
    dynS1OceanMaskCount,
    diag.s1,
    'mask_254_ocean',
    's1_ocean_mask_date_count',
    'OPERA-S1 class 254 ocean-mask date count'
  );
    addRawDiagnostic(
      dynS1MaskedNoValueCount,
      diag.s1,
      'masked_no_value',
      's1_masked_no_value_date_count',
      'OPERA-S1 masked/no-value date count'
    );
  }

  if (dynFirstWetSource.getValue()) {
    addSelected(
      dynSourceAtAnalysisDay(
        observations,
        firstSelected,
        'first_selected_source'
      ),
      DYN_SOURCE_VIS,
      'Source mask of first selected detection',
      'SOURCE'
    );
  }

  if (dynLastWetSource.getValue()) {
    addSelected(
      dynSourceAtAnalysisDay(
        observations,
        lastSelected,
        'last_selected_source'
      ),
      DYN_SOURCE_VIS,
      'Source mask of last selected detection',
      'SOURCE'
    );
  }

  if (dynMaximumGap.getValue()) {
    addSelected(
      sequence.select('maximum_valid_gap_days')
        .updateMask(fusedValidObservationCount.gte(2)),
      DYN_DURATION_VIS,
      'Maximum interval between valid observations (days)',
      'DURATION'
    );
  }

  if (dynConflictCount.getValue()) {
    addSelected(
      dynObservationCount(
        observations,
        'conflict',
        'same_day_wet_dry_conflict_count'
      ),
      DYN_COUNT_VIS,
      'Same-day wet/dry conflict count',
      'COUNT'
    );
  }

  // Register every checked metric as a separate Layers-panel entry. The first
  // product is visible initially and all remaining products are hidden.
  dynRegisterPreviewProducts(previewEntries);
  dynUpdateLegendOptions(legendEntries);

  var selectedClassSummary = [
    sourceOptions.useDw ?
      'DW[' +
      (classOptions.dwWater ? 'water' : '') +
      (classOptions.dwWater && classOptions.dwFloodedVeg ? '+' : '') +
      (classOptions.dwFloodedVeg ? 'flooded_vegetation' : '') +
      ']' : '',
    sourceOptions.useHlsLandsat ?
      'HLS-Landsat[' +
      (classOptions.hlsOpen ? 'open_water' : '') +
      (classOptions.hlsOpen && classOptions.hlsPartial ? '+' : '') +
      (classOptions.hlsPartial ? 'partial_surface_water' : '') +
      ']' : '',
    sourceOptions.useHlsSentinel2 ?
      'HLS-Sentinel2[' +
      (classOptions.hlsOpen ? 'open_water' : '') +
      (classOptions.hlsOpen && classOptions.hlsPartial ? '+' : '') +
      (classOptions.hlsPartial ? 'partial_surface_water' : '') +
      ']' : '',
    sourceOptions.useS1 ?
      'S1[' +
      (classOptions.s1Open ? 'open_water' : '') +
      (classOptions.s1Open && classOptions.s1InundatedVeg ? '+' : '') +
      (classOptions.s1InundatedVeg ? 'inundated_vegetation' : '') +
      ']' : ''
  ].filter(function(item) {
    return item !== '';
  }).join('; ');

  lastDynamicsImage = ee.Image(stack)
    .toFloat()
    .clip(aoi)
    .set({
      analysis_period: period.displayLabel,
      analysis_start_date: start.format('yyyy-MM-dd'),
      analysis_end_date: end.advance(-1, 'day').format('yyyy-MM-dd'),
      analysis_period_days: periodDays,
      analysis_period_months: period.periodMonths,
      timing_value_definition: 'Ordinal day within selected analysis period; day 1 = analysis_start_date',
      calendar_doy_wrap_avoided: true,
      analysis_day_timing_visualization: dynamicsTimingVis.getValue(),
      selected_water_classes: selectedClassSummary,
      same_day_fusion: sourceOptions.sameDayFusion,
      hls_sentinel2_gap_fill_only: sourceOptions.hlsMsiGapFill,
      unselected_water_classes_are_not_dry: true,
      s1_class_zero_used_as_dry: true,
      dw_all_unmasked_labels_count_as_valid: true,
      hls_valid_classes: '0,1,2',
      s1_valid_classes: '0,1,3',
      maximum_gap_masked_when_valid_count_below_2: true,
      source_mask_bits: '1=DW,2=HLS-Landsat,4=HLS-Sentinel2,8=S1',
      episode_max_gap_days: maxGapDays,
      memory_safe_date_grouping: 'Metric-specific direct timing; daily fusion only for metrics that require it',
      direct_timing_engine_used: useDirectTiming,
      reduction_parallel_scale: DYN_REDUCE_PARALLEL_SCALE,
      dynamic_legend_enabled: true,
      dynamic_legend_product_count: legendEntries.length,
      pixel_time_series_inspector_available: true,
      inspector_default_scale_m: 30,
      inspector_real_acquisition_dates_only: true,
      inspector_classification_evolution_available: true,
      inspector_evolution_independent_of_target_selection: true,
      hls_platform_separation: 'Main fusion uses direct SPACECRAFT_NAME filters; system:index and SENSOR retained for optional QA',
      hls_landsat_filter: 'SPACECRAFT_NAME starts Landsat-',
      hls_sentinel2_filter: 'SPACECRAFT_NAME starts Sentinel-2',
      hls_sensor_property_is_qa_only: true,
      hls_platform_identifier_conflicts_are_qa_only: true,
      unrecognized_hls_assets_excluded_from_fusion: true,
      homogeneous_daily_schema_cast_applied_when_daily_engine_used: true,
      typed_masked_validity_bands: true,
      per_source_daily_collapse_before_cross_source_fusion_when_required: true,
      map_preview_layers_created: 1,
      generated_visualization_product_count: previewEntries.length,
      generated_products_loaded_one_at_a_time: true,
      unchecked_or_nonpreview_metrics_do_not_create_tiles: true,
      metric_and_inspector_collections_separated: true,
      inspector_daily_graph_built_point_locally_on_every_click: true,
      inspector_local_buffer_m: DYN_INSPECTOR_LOCAL_RADIUS_METERS,
      hls_raw_metadata_verification_available: true,
      raw_product_coverage_diagnostics_available: true,
      raw_diagnostic_identity: 'asset_footprint = usable_state + excluded_state',
      s1_mask_diagnostics: '250=HAND,251=layover/shadow,254=ocean',
      hls_mask_diagnostics: '252=snow/ice,253=cloud/shadow,254=ocean'
    });

  lastDynamicsName = 'hydrological_selected_water_dynamics_' + period.fileLabel;
  lastDynamicsBands = bandNames;
  lastDynamicsAoi = aoi;
  lastDynamicsYear = periodLabel;
  lastDynamicsPeriodFileLabel = period.fileLabel;
  lastDynamicsSourceOptions = sourceOptions;
  lastDynamicsLazyRunConfig = {
    aoi: aoi,
    start: start,
    end: end,
    periodLabel: periodLabel,
    periodDays: periodDays,
    sourceOptions: sourceOptions,
    classOptions: classOptions
  };

  // The map/export daily engine, when required, may cover the full AOI and is
  // intentionally never reused by the click inspector. Each click constructs
  // a separate tiny point-local graph so charts remain independent of AOI size.
  dynClearPointLocalInspectorData();
  dynUpdateInspectorDiagnosticSources(sourceOptions);

  dynSetBusy(
    false,
    'Stage 3/3: metric-specific preview queued for ' + periodLabel + '. The ' +
    (useDirectTiming ?
      'direct per-source timing engine was used for timing products. ' :
      'priority-fusion daily engine was used because priority fusion was selected. ') +
    'The first checked metric was loaded automatically. All ' +
    previewEntries.length + ' checked products are available in the generated-' +
    'product selector and are loaded one at a time. The richer inspector and ' +
    'diagnostic graph is built in a small local buffer on every pixel click.'
  );
}

function exportAnnualDynamics() {
  if (lastDynamicsImage === null) {
    dynSetStatus(
      'No dynamics image is available. Run the hydrological-period dynamics first.'
    );
    return;
  }

  var scale = Number(dynamicsExportScale.getValue());

  if (!scale || scale <= 0) {
    scale = 30;
  }

  // Do not use exportImage(): that helper casts every band to Byte, while
  // annual dates/durations require Int16 and fractions require Float.
  var aoi = lastDynamicsAoi;

  if (aoi === null) {
    dynSetStatus('The analysis AOI is unavailable. Run the analysis again.');
    return;
  }

  var description = dynSanitizeName(lastDynamicsName);
  var target = dynamicsExportTarget.getValue();

  if (target === 'Google Drive') {
    Export.image.toDrive({
      image: ee.Image(lastDynamicsImage),
      description: description,
      folder: dynamicsDriveFolder.getValue(),
      fileNamePrefix: description,
      region: aoi,
      scale: scale,
      maxPixels: 1e13
    });
  }

  if (target === 'Earth Engine Asset ImageCollection') {
    var assetRoot = dynRemoveTrailingSlash(
      dynamicsAssetCollection.getValue()
    );

    Export.image.toAsset({
      image: ee.Image(lastDynamicsImage),
      description: description,
      assetId: assetRoot + '/' + description,
      region: aoi,
      scale: scale,
      maxPixels: 1e13
    });
  }

  dynSetStatus(
    'Export task created for ' + description + '. Open the Tasks tab to run it.'
  );
}
