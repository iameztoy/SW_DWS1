// =====================================================================
// v1.4h4 — Seasonal UC (target-season) exports
//          - Target = calendar season window (e.g., 20240601–20240930)
//          - For each target: pick ONE DW season-used (with fallback)
//            then cross DW classes with pre-DW seasonal water aggregate
//          - Export name: SEAS__<targetStart_targetEnd>__<seasonUsed>[__FB]
//          - Fast queue remains silent (no prints on failed .start())
//          - Monthly products & other logic kept as in v1.4h3
// =====================================================================

// =====================================================================
// 0) USER SETTINGS — change values here only
// =====================================================================

// -- AOI & run mode
var USE_TESTING_GEOM = false;             // true: small rectangle; false: full basin
var HYDROBASINS_ID = 1041259950;          // Lake Tanganyika basin HYBAS_ID
var MAP_ZOOM = 7;                         // initial map zoom

// -- Inputs (assets & collections)
var WATER_IC_PATH = 'projects/ee-iameztoy/assets/Lake_Tanganyika_Basin/WaterSurface';
var LAVA_MASK_ASSET = 'projects/hardy-tenure-383607/assets/Tanganyika/lava_similarity_mask_2024_thr080';
var DYNAMIC_WORLD_ID = 'GOOGLE/DYNAMICWORLD/V1';

// -- Time window for monthly Sentinel-1 water masks
var WATER_DATE_START = '2020-01-01';
var WATER_DATE_END   = '2025-08-01';      // end-exclusive

// --- Polarization selection ---
// Options: 'UNION' | 'VV_ONLY' | 'VH_ONLY' | 'INTERSECTION'
var POL_MODE = 'UNION';

// -- Commission-error masks toggles + params
var APPLY_HAND_MASK = true;
var HAND_HND_MAX = 48.8;                  // meters above nearest drainage (MERIT Hydro hnd)
var APPLY_LAVA_MASK = true;

// -- Dynamic World (seasonal vegetation) options
var APPLY_DW_VEG_MASK = true;

// Season definitions (customizable)
var WET_START_MONTH = 11;                 // November
var WET_END_MONTH   = 5;                  // May (included)
var DRY_START_MONTH = 6;                  // June
var DRY_END_MONTH   = 9;                  // September
var EXTRA_DRY_MONTHS = [10];              // October uses dry mask
var EXTRA_WET_MONTHS = [];                // e.g., [5] if later WET_END_MONTH=4 but want May as wet

// Include trees (DW class=1) in the veg mask AND output trees∩water layers
var INCLUDE_TREES_IN_DW_MASK = true;      // default: true

// Dynamic World dataset temporal bounds (clamped)
var DW_MIN_DATE = '2015-06-27';
var DW_MAX_DATE = '2025-05-31';

// Fallback search depth
var WET_FORWARD_MAX_YEARS = 5;
var DRY_BACKWARD_MAX_YEARS = 5;

// -- Permanent water core options (v1.4e+)
var USE_PRECOMPUTED_PERM_CORE = true;
var PERM_CORE_ASSET_ID = 'projects/hardy-tenure-383607/assets/Tanganyika/PermanentWater_core';

// If recomputing the core (set USE_PRECOMPUTED_PERM_CORE=false):
var PERM_THRESHOLD = 0.8;
var PERM_EXPORT_ENABLE = false;
var PERM_EXPORT_ASSET_ID = 'projects/hardy-tenure-383607/assets/Tanganyika/PermanentWater_core_thr80_20152025';

// -- DW-NoData veto (v1.4d)
var USE_DW_NODATA_VETO = true;            // master toggle

// -- Visualization
var PALETTE_WATER = ['white', 'blue'];

// -- Debug toggles
var DEBUG = false;
var DEBUG_POL_DIAG = false;
var DEBUG_BUILT_BARE = false;

// Built/bare (seasonal) debug for CHECK month
var DEBUG_BB_SHOW = false;
var DEBUG_BB_SHOW_RAW = false;

// DW-NoData veto debug
var DEBUG_NODATA_VETO  = false;
var NODATA_DEBUG_SCALE = 30;

// DW classes viz/export helpers
var DEBUG_DWCLASS = false;
var EXPORT_SEASONAL_DWMODE_ENABLE = false;

// -- Visual check target
var CHECK_YEAR  = '2024';
var CHECK_MONTH = '01';

// -- Optional exports (master toggle)
var EXPORT_ENABLE = true;

// Product-level export toggles
var EXPORT_WATER_MONTHLY_ENABLE   = false;  // monthly corrected water (final)
var EXPORT_TREES_MONTHLY_ENABLE   = false;  // monthly Trees ∩ Water (pre-DW water)
var EXPORT_TREES_SEASONAL_ENABLE  = false;  // season-used centric (kept as before)

// Multi-class under-canopy products (UC)
var EXPORT_CLASS_FLOODED_MONTHLY_ENABLE = true; // monthly categorical (single band, codes) from pre-DW water
var EXPORT_UCCLASS_SEASONAL_ENABLE = false;       // **now: target-season UC (one-hot multiband)**

// Export paths & params
var EXPORT_WATER_IC_PATH = 'projects/hardy-tenure-383607/assets/Tanganyika/PostProc/PostProc_SW';
var EXPORT_CLASS_FLOODED_IC_PATH = 'projects/hardy-tenure-383607/assets/Tanganyika/PostProc/ClassFlooded';
var EXPORT_SEASONAL_DWMODE_PATH = 'projects/hardy-tenure-383607/assets/Tanganyika/PostProc/DWModeSeasons';

var EXPORT_SCALE = 10;                    // meters
var EXPORT_REGION = null;                 // null → uses aoi
var EXPORT_MAX_PIXELS = 1e13;

// Permanent core + built/bare crossing toggle
var APPLY_BUILT_BARE_OUTSIDE_CORE = true;

// ---------------------------------------------------------------------
// Fast Queue settings (silent by default; tasks queued but not started)
// ---------------------------------------------------------------------
var FASTQUEUE_ENABLE = false;     // false ⇒ create tasks only; you start them manually
var FASTQUEUE_STAGGER_MS = 200;
var FASTQUEUE_LOG = false;

// =====================================================================
// AOI for testing purposes (rectangle)
// =====================================================================
var testing_geom =
    ee.Geometry.Polygon(
        [[[28.93002129912434, -3.663729479118898],
          [28.93002129912434, -4.354170367124604],
          [29.68807793974934, -4.354170367124604],
          [29.68807793974934, -3.663729479118898]]], null, false);

// =====================================================================
// 1) AOI
// =====================================================================
var hydrobasins = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_4')
  .filter(ee.Filter.eq('HYBAS_ID', HYDROBASINS_ID));
var aoiFull = hydrobasins.geometry();
var aoi = ee.Geometry(ee.Algorithms.If(USE_TESTING_GEOM, testing_geom, aoiFull));

if (DEBUG) {
  print('Hydrobasins matched (should be 1):', hydrobasins.size());
  print('AOI geometry:', aoi);
}

// =====================================================================
// 2) Input ImageCollection of water masks  (memory-safe per-image clipping)
// =====================================================================
var waterCol = ee.ImageCollection(WATER_IC_PATH)
  .map(function(img) {
    var parts = ee.String(img.get('system:index')).split('_'); // ["water","VH","MM","YYYY"]
    var month = ee.Number.parse(parts.get(2));
    var year  = ee.Number.parse(parts.get(3));
    var date  = ee.Date.fromYMD(year, month, 1);
    return img.set({
      'year': year,
      'month': month,
      'system:time_start': date.millis(),
      'ym': ee.String(year).cat('_').cat(parts.get(2))
    });
  })
  .filterDate(WATER_DATE_START, WATER_DATE_END);

// Only clip inputs when testing small rectangle; for full AOI keep un-clipped here
if (USE_TESTING_GEOM) {
  waterCol = waterCol.map(function(img) { return img.clip(testing_geom); });
}

if (DEBUG) {
  print('Water collection (parsed ' + (USE_TESTING_GEOM ? '& clipped to testing_geom' : '(no per-image clip)') + '):', waterCol);
}

// =====================================================================
// 3) External masks: HAND and Lava flows
// =====================================================================
var hand_merit = ee.Image("MERIT/Hydro/v1_0_1").select("hnd");
var handMask = ee.Image(1);
if (APPLY_HAND_MASK) {
  handMask = hand_merit.lte(HAND_HND_MAX);
}

var lavaMask = ee.Image(1);
if (APPLY_LAVA_MASK) {
  var lava_flow_embedd = ee.Image(LAVA_MASK_ASSET);
  var canvas = ee.Image(2).clip(aoi); // constant canvas over AOI
  lava_flow_embedd = canvas.where(lava_flow_embedd.mask(), lava_flow_embedd);
  lava_flow_embedd = lava_flow_embedd.eq(1).unmask(); // 1 = lava
  lavaMask = lava_flow_embedd.neq(1);                 // keep where NOT lava
}

// Combined commission mask (clip to AOI)
var commissionMask = handMask.and(lavaMask).clip(aoi);

// =====================================================================
// 4) Helper: extract YYYY, MM, POL from image name (also ensures ym present)
// =====================================================================
function parseName(img) {
  var name = ee.String(img.get('system:index'));
  var parts = name.split('_');  // ["water", "VH", "MM", "YYYY"]
  var pol = parts.get(1);
  var month = parts.get(2);
  var year = parts.get(3);
  return img.set({
    'pol': pol,
    'month': month,
    'year': year,
    'ym': ee.String(year).cat('_').cat(month)
  });
}
var waterColParsed = waterCol.map(parseName);

// =====================================================================
// 5) Get distinct YYYY_MM keys
// =====================================================================
var monthKeys = ee.List(waterColParsed.aggregate_array('ym')).distinct();
if (DEBUG) {
  print('Distinct ym keys:', monthKeys);
}

// =====================================================================
// 6) Combine VH/VV per month with POL_MODE and apply HAND+lava commission mask
// =====================================================================
function combineMonth(ym) {
  ym = ee.String(ym);
  var parts = ym.split('_');
  var year = parts.get(0);
  var month = parts.get(1);

  var subset = waterColParsed.filter(ee.Filter.and(
    ee.Filter.eq('year', year),
    ee.Filter.eq('month', month)
  ));

  // Get first VH/VV candidates and presence flags (server-side)
  var vh = subset.filter(ee.Filter.eq('pol', 'VH')).first();
  var vv = subset.filter(ee.Filter.eq('pol', 'VV')).first();
  var hasVH = subset.filter(ee.Filter.eq('pol', 'VH')).size().gt(0);
  var hasVV = subset.filter(ee.Filter.eq('pol', 'VV')).size().gt(0);

  // Safe images (if missing → zero image)
  var vhImg = ee.Image(ee.Algorithms.If(hasVH, ee.Image(vh).unmask(0), ee.Image(0))).rename('VH');
  var vvImg = ee.Image(ee.Algorithms.If(hasVV, ee.Image(vv).unmask(0), ee.Image(0))).rename('VV');

  // Combine by POL_MODE
  var combinedMask;
  if (POL_MODE === 'VV_ONLY') {
    combinedMask = vvImg;
  } else if (POL_MODE === 'VH_ONLY') {
    combinedMask = vhImg;
  } else if (POL_MODE === 'INTERSECTION') {
    combinedMask = vhImg.and(vvImg);
  } else { // 'UNION' (default)
    combinedMask = vhImg.or(vvImg);
  }

  combinedMask = combinedMask.rename('water').clip(aoi);

  // Apply commission error mask
  var masked = combinedMask.updateMask(commissionMask);

  var dateStr = ee.Date.fromYMD(ee.Number.parse(year), ee.Number.parse(month), 1);
  return masked.set({
    'year': year,
    'month': month,
    'system:time_start': dateStr.millis(),
    'ym': ym,
    'pol_mode': POL_MODE
  });
}

var combinedCol = ee.ImageCollection.fromImages(monthKeys.map(combineMonth));

// Optional pre-DW preview
var preDWcheck = combinedCol
  .filter(ee.Filter.eq('year', CHECK_YEAR))
  .filter(ee.Filter.eq('month', CHECK_MONTH))
  .first();
if (DEBUG) {
  print('Combined + HAND+lava (' + POL_MODE + ') for ' + CHECK_MONTH + '/' + CHECK_YEAR, preDWcheck);
}

// =====================================================================
// 6b) Polarization availability diagnostics (toggle with DEBUG_POL_DIAG)
// =====================================================================
if (DEBUG_POL_DIAG) {
  function polDiagFeature(ym) {
    ym = ee.String(ym);
    var parts = ym.split('_');
    var year = parts.get(0);
    var month = parts.get(1);

    var subset = waterColParsed.filter(ee.Filter.and(
      ee.Filter.eq('year', year),
      ee.Filter.eq('month', month)
    ));
    var hasVH = subset.filter(ee.Filter.eq('pol', 'VH')).size().gt(0);
    var hasVV = subset.filter(ee.Filter.eq('pol', 'VV')).size().gt(0);

    function b2n(b) { return ee.Number(ee.Algorithms.If(b, 1, 0)); }

    return ee.Feature(null, {
      ym: ym,
      hasVH: b2n(hasVH),
      hasVV: b2n(hasVV),
      cat_both: b2n(hasVH.and(hasVV)),
      cat_vv_only: b2n(hasVV.and(hasVH.not())),
      cat_vh_only: b2n(hasVH.and(hasVV.not())),
      cat_none: b2n(hasVH.not().and(hasVV.not()))
    });
  }
  var polDiagFC = ee.FeatureCollection(monthKeys.map(polDiagFeature));
  print('POL diagnostics — per-month VH/VV presence:', polDiagFC);
}

// =====================================================================
// 7) Map view
// =====================================================================
Map.centerObject(aoi, MAP_ZOOM);
Map.setOptions("SATELLITE");
Map.addLayer(preDWcheck.selfMask(), {min: 0, max: 1, palette: PALETTE_WATER},
             'Water after HAND+lava mask', false);

// =====================================================================
// 8) Dynamic World (DW) seasonal vegetation masking (+ optional trees)
// Build per-season masks once and reuse everywhere
// =====================================================================
var combinedColVeg = combinedCol; // default passthrough if APPLY_DW_VEG_MASK = false
var seasonalTreesFloodCol = ee.ImageCollection([]); // season-used centric (legacy)

// Per-season dictionaries
var seasonKeyToBuiltBareDict;
var seasonKeyToDwNoDataDict;
var seasonKeyToDWModeDict;

if (APPLY_DW_VEG_MASK) {
  var DW = ee.ImageCollection(DYNAMIC_WORLD_ID).filterBounds(aoi);
  var DW_MIN = ee.Date(DW_MIN_DATE);
  var DW_MAX = ee.Date(DW_MAX_DATE);

  // Helpers
  function ymd(y, m, d) { return ee.Date.fromYMD(ee.Number(y), ee.Number(m), ee.Number(d)); }
  function clampStart(date) {
    date = ee.Date(date);
    return ee.Date(ee.Algorithms.If(date.millis().lt(DW_MIN.millis()), DW_MIN, date));
  }
  function clampEnd(date) {
    date = ee.Date(date);
    return ee.Date(ee.Algorithms.If(date.millis().gt(DW_MAX.millis()), DW_MAX, date));
  }
  function filterDWSeason(start, end) {
    var s = ee.Date(start);
    var e = ee.Date(end).advance(1, 'day');   // end exclusive
    return DW.filterDate(s, e).filterBounds(aoi);
  }

  // Month grouping helpers
  function isInExtraDry(m) { return ee.List(EXTRA_DRY_MONTHS).contains(m); }
  function isInExtraWet(m) { return ee.List(EXTRA_WET_MONTHS).contains(m); }
  function isWetMonth(m) {
    var mNum = ee.Number(m);
    var wetSpanA = mNum.gte(WET_START_MONTH);
    var wetSpanB = mNum.lte(WET_END_MONTH);
    return wetSpanA.or(wetSpanB);
  }

  // Base seasons
  function getWetBaseSeason(year, month) {
    year = ee.Number.parse(year);
    month = ee.Number.parse(month);
    var startYear = ee.Number(ee.Algorithms.If(month.gte(WET_START_MONTH), year, year.subtract(1)));
    var endYear = ee.Number(ee.Algorithms.If(WET_END_MONTH >= WET_START_MONTH, startYear, startYear.add(1)));
    var start = ymd(startYear, WET_START_MONTH, 1);
    var endLastDay = ymd(endYear, WET_END_MONTH, 1).advance(1, 'month').advance(-1, 'day');
    return ee.Dictionary({start: start, end: endLastDay});
  }
  function getDryBaseSeason(year, month) {
    year = ee.Number.parse(year);
    var start = ymd(year, DRY_START_MONTH, 1);
    var endLastDay = ymd(year, DRY_END_MONTH, 1).advance(1, 'month').advance(-1, 'day');
    return ee.Dictionary({start: start, end: endLastDay});
  }

  // Fallback candidate generators (anchored)
  function wetForwardCandidates(base) {
    base = ee.Dictionary(base);
    var start0 = ee.Date(base.get('start'));
    var end0   = ee.Date(base.get('end'));
    return ee.List.sequence(0, WET_FORWARD_MAX_YEARS).map(function(shift) {
      shift = ee.Number(shift);
      return ee.Dictionary({
        start: start0.advance(shift, 'year'),
        end:   end0.advance(shift, 'year'),
        shift: shift
      });
    });
  }
  function dryBackwardCandidates(base) {
    base = ee.Dictionary(base);
    var start0 = ee.Date(base.get('start'));
    var end0   = ee.Date(base.get('end'));
    return ee.List.sequence(0, DRY_BACKWARD_MAX_YEARS).map(function(shift) {
      shift = ee.Number(shift);
      return ee.Dictionary({
        start: start0.advance(shift.multiply(-1), 'year'),
        end:   end0.advance(shift.multiply(-1), 'year'),
        shift: shift
      });
    });
  }

  function selectSeasonWithData(candidates) {
    candidates = ee.List(candidates);
    var init = ee.Dictionary({
      found: false, chosen: ee.Dictionary(),
      fallbackUsed: false, emptyMaskUsed: false
    });
    var reduced = ee.List(candidates).iterate(function(cand, state) {
      state = ee.Dictionary(state);
      var already = ee.Algorithms.IsEqual(state.get('found'), true);
      return ee.Algorithms.If(already, state, (function() {
        cand = ee.Dictionary(cand);
        var s = ee.Date(cand.get('start'));
        var e = ee.Date(cand.get('end'));
        var sClamped = clampStart(s);
        var eClamped = clampEnd(e);
        var invalid = sClamped.millis().gt(eClamped.millis());
        var dwCount = ee.Number(ee.Algorithms.If(invalid, 0, filterDWSeason(sClamped, eClamped).size()));
        var has = dwCount.gt(0);
        return ee.Algorithms.If(has,
          ee.Dictionary({
            found: true,
            chosen: ee.Dictionary(cand)
              .set('startClamped', sClamped)
              .set('endClamped', eClamped),
            fallbackUsed: ee.Number(cand.get('shift')).gt(0),
            emptyMaskUsed: false
          }),
          state
        );
      })());
    }, init);
    reduced = ee.Dictionary(reduced);
    var found = ee.Algorithms.IsEqual(reduced.get('found'), true);
    return ee.Algorithms.If(found, reduced, ee.Dictionary({
      found: false, chosen: ee.Dictionary(),
      fallbackUsed: true, emptyMaskUsed: true
    }));
  }

  function monthToSeasonFeature(ym) {
    ym = ee.String(ym);
    var parts = ym.split('_');
    var year = parts.get(0);
    var month = parts.get(1);
    var mNum = ee.Number.parse(month);

    var defaultWet = isWetMonth(mNum);
    var forceDry = isInExtraDry(mNum);
    var forceWet = isInExtraWet(mNum);
    var isWet = ee.Algorithms.If(forceWet, true, ee.Algorithms.If(forceDry, false, defaultWet));
    isWet = ee.Number(ee.Algorithms.If(isWet, 1, 0)); // 1 wet, 0 dry

    var base = ee.Dictionary(ee.Algorithms.If(isWet.eq(1),
      getWetBaseSeason(year, month),
      getDryBaseSeason(year, month)
    ));

    var baseStart = ee.Date(base.get('start'));
    var baseEnd   = ee.Date(base.get('end'));
    var baseStartClamped = clampStart(baseStart);
    var baseEndClamped   = clampEnd(baseEnd);
    var baseInvalid      = baseStartClamped.millis().gt(baseEndClamped.millis());

    var baseCount = ee.Number(ee.Algorithms.If(
      baseInvalid, 0, filterDWSeason(baseStartClamped, baseEndClamped).size()
    ));

    var needWetForward = isWet.eq(1).and(
      baseCount.eq(0).and(baseStart.millis().lt(DW_MIN.millis()))
    );
    var needDryBackward = isWet.eq(0).and(
      baseCount.eq(0).and(baseEnd.millis().gt(DW_MAX.millis()))
    );

    var resultDict = ee.Dictionary(ee.Algorithms.If(
      needWetForward,
      selectSeasonWithData(wetForwardCandidates(base)),
      ee.Algorithms.If(
        needDryBackward,
        selectSeasonWithData(dryBackwardCandidates(base)),
        (function() {
          var hasData = baseCount.gt(0);
          return ee.Dictionary({
            found: hasData,
            chosen: ee.Dictionary({
              start: baseStart,
              end: baseEnd,
              startClamped: baseStartClamped,
              endClamped: baseEndClamped,
              shift: 0
            }),
            fallbackUsed: false,
            emptyMaskUsed: hasData.not()
          });
        })()
      )
    ));

    var chosen = ee.Dictionary(resultDict.get('chosen'));
    var sC = ee.Date(chosen.get('startClamped'));
    var eC = ee.Date(chosen.get('endClamped'));

    var isEmpty = ee.Algorithms.IsEqual(resultDict.get('emptyMaskUsed'), true);
    var seasonKey = ee.Algorithms.If(
      isEmpty,
      ee.String('EMPTY_').cat(ym),
      ee.String(sC.format('YYYYMMdd')).cat('_').cat(eC.format('YYYYMMdd'))
    );

    var seasonLabel = ee.String(ee.Algorithms.If(
      isWet.eq(1), ee.String('wet_').cat(eC.format('YYYY')),
                   ee.String('dry_').cat(sC.format('YYYY'))
    ));

    // **Add base (target) key for seasonal target exports**
    var baseKey = ee.String(baseStart.format('YYYYMMdd')).cat('_').cat(baseEnd.format('YYYYMMdd'));

    return ee.Feature(null, {
      ym: ym,
      year: year,
      month: month,
      seasonType: ee.String(ee.Algorithms.If(isWet.eq(1), 'wet', 'dry')),
      baseStart: baseStart.format('YYYY-MM-dd'),
      baseEnd: baseEnd.format('YYYY-MM-dd'),
      baseKey: baseKey,                                 // NEW: target-season key
      startClamped: ee.Algorithms.If(sC, sC.format('YYYY-MM-dd'), null),
      endClamped: ee.Algorithms.If(eC, eC.format('YYYY-MM-dd'), null),
      fallbackUsed: resultDict.get('fallbackUsed'),
      emptyMaskUsed: resultDict.get('emptyMaskUsed'),
      seasonKey: ee.String(seasonKey),
      seasonLabel: seasonLabel
    });
  }

  var monthSeasonFC = ee.FeatureCollection(ee.List(monthKeys).map(monthToSeasonFeature));
  var distinctSeasonKeys = ee.List(monthSeasonFC.aggregate_array('seasonKey')).distinct();

  // Build per-season images once (season-used centric dictionaries)
  var seasonKeyToNonVegDict;
  var seasonKeyToTreesDict;
  (function buildSeasonMasks() {
    var keys = distinctSeasonKeys;

    var modeImgs = keys.map(function(k) {
      k = ee.String(k);
      var isEmpty = ee.Algorithms.IsEqual(ee.String(k).split('_').get(0), 'EMPTY');
      return ee.Image(ee.Algorithms.If(
        isEmpty,
        ee.Image(0).rename('label_mode').clip(aoi).updateMask(ee.Image(0)),
        (function() {
          var parts = k.split('_');
          var s = ee.Date.parse('YYYYMMdd', parts.get(0));
          var e = ee.Date.parse('YYYYMMdd', parts.get(1));
          var col = filterDWSeason(s, e).select('label');
          var mode = col.reduce(ee.Reducer.mode()).rename('label_mode').clip(aoi);
          return mode;
        })()
      ));
    });
    seasonKeyToDWModeDict = ee.Dictionary.fromLists(keys, modeImgs);

    var nonVegMasks = keys.map(function(k) {
      k = ee.String(k);
      var mode = ee.Image(seasonKeyToDWModeDict.get(k));
      var vegBase = mode.eq(2).or(mode.eq(4)).or(mode.eq(5)); // grass(2), crops(4), shrub(5)
      var vegAll  = ee.Algorithms.If(INCLUDE_TREES_IN_DW_MASK, vegBase.or(mode.eq(1)), vegBase);
      var nonVeg = ee.Image(vegAll).eq(0).rename('nonVeg').unmask(1).clip(aoi);
      return nonVeg;
    });

    var treesMasks = keys.map(function(k) {
      k = ee.String(k);
      var mode = ee.Image(seasonKeyToDWModeDict.get(k));
      return mode.eq(1).rename('trees').clip(aoi);
    });

    var builtBareMasks = keys.map(function(k) {
      k = ee.String(k);
      var mode = ee.Image(seasonKeyToDWModeDict.get(k));
      return mode.eq(6).or(mode.eq(7)).rename('builtbare').unmask(0).clip(aoi);
    });

    var dwNoDataMasks = keys.map(function(k) {
      k = ee.String(k);
      var mode = ee.Image(seasonKeyToDWModeDict.get(k));
      var hasObs = mode.mask().gt(0);
      return hasObs.not().rename('dwNoData').clip(aoi);
    });

    seasonKeyToNonVegDict     = ee.Dictionary.fromLists(keys, nonVegMasks);
    seasonKeyToTreesDict      = ee.Dictionary.fromLists(keys, treesMasks);
    seasonKeyToBuiltBareDict  = ee.Dictionary.fromLists(keys, builtBareMasks);
    seasonKeyToDwNoDataDict   = ee.Dictionary.fromLists(keys, dwNoDataMasks);
  })();

  // Lookups (for monthly names & properties)
  var dictYmToSeasonKey = ee.Dictionary.fromLists(
    monthSeasonFC.aggregate_array('ym'),
    monthSeasonFC.aggregate_array('seasonKey')
  );
  var dictYmToFallback = ee.Dictionary.fromLists(
    monthSeasonFC.aggregate_array('ym'),
    monthSeasonFC.aggregate_array('fallbackUsed')
  );
  var dictYmToEmpty = ee.Dictionary.fromLists(
    monthSeasonFC.aggregate_array('ym'),
    monthSeasonFC.aggregate_array('emptyMaskUsed')
  );

  // Unique season labels
  var uniqueKeys = distinctSeasonKeys;
  var labelsForKeys = uniqueKeys.map(function(k) {
    return monthSeasonFC.filter(ee.Filter.eq('seasonKey', k)).first().get('seasonLabel');
  });
  var dictSeasonKeyToLabel = ee.Dictionary.fromLists(uniqueKeys, labelsForKeys);

  // Apply DW non-vegetation mask to each combined monthly water image
  combinedColVeg = combinedCol.map(function(img) {
    var y = ee.String(img.get('year'));
    var m = ee.String(img.get('month'));
    var ym = y.cat('_').cat(m);

    var seasonKey = ee.String(dictYmToSeasonKey.get(ym));
    var nonVeg = ee.Image(seasonKeyToNonVegDict.get(seasonKey));
    var waterMasked = img.updateMask(nonVeg);

    var out = waterMasked;
    if (INCLUDE_TREES_IN_DW_MASK) {
      var treesMask = ee.Image(seasonKeyToTreesDict.get(seasonKey));
      var treesFlooded = img.selfMask().and(treesMask).rename('trees_flooded');
      out = waterMasked.addBands(treesFlooded);
    }

    return out
      .set('seasonKey', seasonKey)
      .set('seasonLabel', dictSeasonKeyToLabel.get(seasonKey))
      .set('dw_fallback_used', dictYmToFallback.get(ym))
      .set('dw_empty_mask', dictYmToEmpty.get(ym));
  });

  if (DEBUG) {
    print('DW month→season table (first 25):', monthSeasonFC.limit(25));
    print('Distinct season keys used:', distinctSeasonKeys);
  }

  // ---- (Legacy) Season-used centric Trees∩Water collection
  if (INCLUDE_TREES_IN_DW_MASK) {
    seasonalTreesFloodCol = ee.ImageCollection.fromImages(
      uniqueKeys.map(function(k) {
        k = ee.String(k);
        var seasonLabel = ee.String(dictSeasonKeyToLabel.get(k));
        var monthsInSeason = combinedColVeg.filter(ee.Filter.eq('seasonKey', k));
        var treesFloodSeason = monthsInSeason
          .map(function(im) { return ee.Image(im).select('trees_flooded').unmask(0); })
          .reduce(ee.Reducer.max())
          .rename('trees_flooded')
          .set('seasonKey', k)
          .set('seasonLabel', seasonLabel);
        return treesFloodSeason;
      })
    );
  }
}

// =====================================================================
// 9) Visual check (after DW vegetation masking, if applied)
// =====================================================================
var checkImgDW = combinedColVeg.filter(ee.Filter.and(
  ee.Filter.eq('year', CHECK_YEAR),
  ee.Filter.eq('month', CHECK_MONTH)
)).first();

print('Water after HAND+lava ' + (APPLY_DW_VEG_MASK ? '+ DW vegetation ' : '') +
      '(' + CHECK_MONTH + '/' + CHECK_YEAR + '), POL_MODE=' + POL_MODE +
      ', INCLUDE_TREES_IN_DW_MASK=' + INCLUDE_TREES_IN_DW_MASK + ':', checkImgDW);

Map.addLayer(checkImgDW.selfMask().select('water'), {min: 0, max: 1, palette: PALETTE_WATER},
             'Water after HAND+lava ' + (APPLY_DW_VEG_MASK ? '+ DW vegetation' : '(no DW)'), false);

if (APPLY_DW_VEG_MASK && INCLUDE_TREES_IN_DW_MASK) {
  Map.addLayer(checkImgDW.select('trees_flooded').selfMask(),
    {min: 0, max: 1, palette: ['yellow']}, 'Trees ∩ Water (monthly)', false);
}

// =====================================================================
// 10) Permanent Water Core (post-DW) + Built/Bare outside core + DW-NoData veto
// =====================================================================
var finalCol = combinedColVeg;  // monthly, after DW veg mask
var permanentCore = ee.Image(0).rename('core').clip(aoi);

if (APPLY_BUILT_BARE_OUTSIDE_CORE && APPLY_DW_VEG_MASK) {

  // ---- 10a) Permanent core
  if (USE_PRECOMPUTED_PERM_CORE) {
    permanentCore = ee.Image(PERM_CORE_ASSET_ID).rename('core').clip(aoi);
  } else {
    var perBandCol = combinedColVeg.map(function(img) {
      var water = img.select('water').unmask(0);
      var valid = img.select('water').mask().gt(0).rename('valid');
      return water.addBands(valid);
    });

    var sums = perBandCol.reduce(ee.Reducer.sum());
    var waterSum = sums.select('water_sum');
    var validSum = sums.select('valid_sum');

    var freq = waterSum.divide(validSum).updateMask(validSum.gt(0));
    permanentCore = freq.gte(PERM_THRESHOLD).rename('core').clip(aoi);
  }

  if (DEBUG_BUILT_BARE) {
    Map.addLayer(permanentCore.selfMask(), {min: 0, max: 1, palette: ['cyan']}, 'Permanent core (post-DW)', false);
  }

  // ---- 10b) Apply built/bare (seasonal) ONLY outside the permanent core + optional veto
  finalCol = combinedColVeg.map(function(img) {
    var seasonKey = ee.String(img.get('seasonKey'));
    var bb = ee.Image(seasonKeyToBuiltBareDict.get(seasonKey)).unmask(0);
    var keepBase = permanentCore.or(bb.not());

    var keepVeto = ee.Image(1);
    if (USE_DW_NODATA_VETO) {
      var dwNoData = ee.Image(seasonKeyToDwNoDataDict.get(seasonKey)).unmask(0);
      keepVeto = dwNoData.not().or(permanentCore);
    }

    var keep = keepBase.and(keepVeto);
    var outWater = img.select('water').updateMask(keep);

    var out = outWater;
    var bandNames = img.bandNames();
    var hasTrees = bandNames.contains('trees_flooded');
    out = ee.Image(ee.Algorithms.If(hasTrees, out.addBands(img.select('trees_flooded')), out));

    return out.copyProperties(img, img.propertyNames());
  });

  // ---- 10c) DEBUG helpers
  if (DEBUG_BUILT_BARE || DEBUG_NODATA_VETO) {
    var checkImgKey = ee.String(checkImgDW.get('seasonKey'));
    var bbCheck = ee.Image(seasonKeyToBuiltBareDict.get(checkImgKey)).unmask(0);
    var holesPrevented = permanentCore.and(bbCheck).and(checkImgDW.select('water').unmask(0));
    if (DEBUG_BUILT_BARE) {
      Map.addLayer(bbCheck.selfMask(), {min: 0, max: 1, palette: ['red']}, 'Built/Bare (seasonal) — check', false);
      Map.addLayer(holesPrevented.selfMask(), {min: 0, max: 1, palette: ['magenta']}, 'Core ∧ Built/Bare ∧ Water (prevented holes)', false);
    }

    if (DEBUG_NODATA_VETO && USE_DW_NODATA_VETO) {
      var dwNoDataCheck = ee.Image(seasonKeyToDwNoDataDict.get(checkImgKey)).unmask(0);
      var vetoOutsideCore = dwNoDataCheck.and(permanentCore.not());
      var suppressed = vetoOutsideCore.and(checkImgDW.select('water').unmask(0).eq(1));
      Map.addLayer(dwNoDataCheck.selfMask(), {min:0, max:1}, 'DW NoData (season MODE masked) — check', false);
      Map.addLayer(vetoOutsideCore.selfMask(), {min:0, max:1, palette:['#00ffff']}, 'DW NoData outside core — check', false);
      Map.addLayer(suppressed.selfMask(), {min:0, max:1, palette:['#ff8800']}, 'Suppressed by DW NoData veto — check', false);
      var statsImg = ee.Image.cat([
        checkImgDW.select('water').unmask(0).rename('waterCand'),
        dwNoDataCheck.rename('dwNoData'),
        vetoOutsideCore.rename('vetoOutCore'),
        suppressed.rename('suppressed')
      ]);
      var stats = statsImg.reduceRegion({
        reducer: ee.Reducer.sum(), geometry: aoi, scale: NODATA_DEBUG_SCALE, maxPixels: 1e13
      });
      print('v1.4h4 DEBUG (DW-NoData veto from MODE mask) counts:', stats);
    }
  }
}

// =====================================================================
// 11) Visual check of final result (post built/bare + optional NoData veto)
// =====================================================================
var checkImgFinal = finalCol.filter(ee.Filter.and(
  ee.Filter.eq('year', CHECK_YEAR),
  ee.Filter.eq('month', CHECK_MONTH)
)).first();

print('FINAL water (built/bare outside core' + (USE_DW_NODATA_VETO ? ' + DW-NoData veto' : '') + ') — ' +
      CHECK_MONTH + '/' + CHECK_YEAR + ':', checkImgFinal);

Map.addLayer(checkImgFinal.selfMask().select('water'), {min: 0, max: 1, palette: PALETTE_WATER},
             'FINAL Water (post built/bare' + (USE_DW_NODATA_VETO ? ' + NoData veto' : '') + ')', false);

// =====================================================================
// 12) Multi-class under-canopy products (from pre-DW water)
// Codes for monthly categorical: Trees=1, Shrub=2, Grass=3, Crops=4, Built/Bare=6
// =====================================================================

// Monthly categorical (single-band) using PRE-DW water:
var ucMonthlyCol = combinedCol.map(function(img) {
  var y = ee.String(img.get('year'));
  var m = ee.String(img.get('month'));
  var ym = y.cat('_').cat(m);

  var seasonK = ee.String(
    ee.Algorithms.If(
      APPLY_DW_VEG_MASK,
      ee.String(dictYmToSeasonKey.get(ym)),
      ee.String('EMPTY_').cat(ym)
    )
  );

  var mode = ee.Image(
    ee.Algorithms.If(
      APPLY_DW_VEG_MASK,
      seasonKeyToDWModeDict.get(seasonK), // DW seasonal mode image
      ee.Image(0).updateMask(0)           // fully masked if DW veg disabled
    )
  );

  var water = img.select('water').unmask(0).eq(1);

  var trees  = water.and(mode.eq(1));
  var grass  = water.and(mode.eq(2));
  var shrub  = water.and(mode.eq(5));
  var crops  = water.and(mode.eq(4));
  var bb     = water.and(mode.eq(6).or(mode.eq(7)));

  var cls = ee.Image(0)
    .where(trees, 1)
    .where(shrub, 2)
    .where(grass, 3)
    .where(crops, 4)
    .where(bb,    6)
    .rename('class_flooded')
    .clip(aoi)
    .toByte();

  var seasonLabel = ee.Algorithms.If(
    APPLY_DW_VEG_MASK,
    ee.Feature(monthSeasonFC.filter(ee.Filter.eq('ym', ym)).first()).get('seasonLabel'),
    null
  );

  return cls
    .set('year', img.get('year'))
    .set('month', img.get('month'))
    .set('ym', img.get('ym'))
    .set('seasonKey', seasonK)
    .set('seasonLabel', seasonLabel);
});

// Season-used centric (legacy) one-hot (kept for SEASDW/legacy exports)
var ucSeasonalCol = ee.ImageCollection([]);
if (APPLY_DW_VEG_MASK) {
  ucSeasonalCol = ee.ImageCollection.fromImages(
    distinctSeasonKeys.map(function(k) {
      k = ee.String(k);
      var monthsInSeason = ucMonthlyCol.filter(ee.Filter.eq('seasonKey', k));
      var trees = monthsInSeason.map(function(im){ return ee.Image(im).select('class_flooded').eq(1).toByte(); }).reduce(ee.Reducer.max()).rename('UC_Trees');
      var shrub = monthsInSeason.map(function(im){ return ee.Image(im).select('class_flooded').eq(2).toByte(); }).reduce(ee.Reducer.max()).rename('UC_Shrub');
      var grass = monthsInSeason.map(function(im){ return ee.Image(im).select('class_flooded').eq(3).toByte(); }).reduce(ee.Reducer.max()).rename('UC_Grass');
      var crops = monthsInSeason.map(function(im){ return ee.Image(im).select('class_flooded').eq(4).toByte(); }).reduce(ee.Reducer.max()).rename('UC_Crops');
      var bb    = monthsInSeason.map(function(im){ return ee.Image(im).select('class_flooded').eq(6).toByte(); }).reduce(ee.Reducer.max()).rename('UC_BuiltBare');
      return ee.Image.cat([trees, shrub, grass, crops, bb])
        .set('seasonKey', k);
    })
  );
}

// =====================================================================
// 13) Exports — queue-silent, simple names
// =====================================================================

// Helpers to enumerate months client-side
function enumerateMonths(startStr, endStrExclusive) {
  var out = [];
  var d = new Date(startStr + 'T00:00:00Z');
  var end = new Date(endStrExclusive + 'T00:00:00Z');
  while (d < end) {
    var y = d.getUTCFullYear();
    var m = d.getUTCMonth() + 1;
    var mm = (m < 10 ? '0' + m : '' + m);
    out.push({ y: '' + y, mm: mm, ym: y + '_' + mm });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

// Fast queue starter (silent)
function fastStart(task, desc, idx) {
  if (!FASTQUEUE_ENABLE) return;
  var delay = (idx || 0) * FASTQUEUE_STAGGER_MS;
  ui.util.setTimeout(function() {
    try { task.start(); if (FASTQUEUE_LOG) print('▶ start', desc); } catch (e) {}
  }, delay);
}

// --------- Safe fallback builders (server-side) ----------
function emptyByte(bandName) {
  return ee.Image(0).rename(bandName).updateMask(ee.Image(0)).clip(aoi).toByte();
}
function emptyUCSeason() {
  return ee.Image.cat([
    emptyByte('UC_Trees'),
    emptyByte('UC_Shrub'),
    emptyByte('UC_Grass'),
    emptyByte('UC_Crops'),
    emptyByte('UC_BuiltBare')
  ]);
}
function emptyDWMode() { return emptyByte('label_mode'); }

// ---- Client-side copies for NAMING ONLY (small getInfo; outside loops)
var YM_TO_SEASONKEY = {};
var YM_TO_FALLBACK  = {};
if (APPLY_DW_VEG_MASK) {
  try { YM_TO_SEASONKEY = dictYmToSeasonKey.getInfo() || {}; } catch (e) { YM_TO_SEASONKEY = {}; }
  try { YM_TO_FALLBACK  = dictYmToFallback.getInfo()  || {}; } catch (e) { YM_TO_FALLBACK  = {}; }
}

// (A) MONTHLY WATER — names: YYYY_MM__SEASON[__FB]
if (EXPORT_ENABLE && EXPORT_WATER_MONTHLY_ENABLE) {
  var region = EXPORT_REGION || aoi;
  var months = enumerateMonths(WATER_DATE_START, WATER_DATE_END);

  months.forEach(function(rec, idx) {
    var filtered = finalCol
      .filter(ee.Filter.eq('year', rec.y))
      .filter(ee.Filter.eq('month', rec.mm));

    var img = ee.Image(ee.Algorithms.If(
      filtered.size().gt(0),
      filtered.first().select('water').toByte(),
      emptyByte('water')
    ));

    var usedSeason = (APPLY_DW_VEG_MASK && YM_TO_SEASONKEY[rec.ym]) ? YM_TO_SEASONKEY[rec.ym] : 'NA';
    var fb = (APPLY_DW_VEG_MASK && YM_TO_FALLBACK[rec.ym]) ? '__FB' : '';
    var desc = rec.ym + '__' + usedSeason + fb;

    var assetId = EXPORT_WATER_IC_PATH + '/' + desc;
    var task = Export.image.toAsset({
      image: img, description: desc, assetId: assetId,
      region: region, scale: EXPORT_SCALE, maxPixels: EXPORT_MAX_PIXELS,
      crs: 'EPSG:4326', pyramidingPolicy: 'mode'
    });
    fastStart(task, desc, idx);
  });
}

// (A2) MONTHLY Trees ∩ Water — names: YYYY_MM__SEASON[__FB]__TREES
if (EXPORT_ENABLE && EXPORT_TREES_MONTHLY_ENABLE && APPLY_DW_VEG_MASK && INCLUDE_TREES_IN_DW_MASK) {
  var regionT = EXPORT_REGION || aoi;
  var monthsT = enumerateMonths(WATER_DATE_START, WATER_DATE_END);

  monthsT.forEach(function(rec, idx) {
    var filtered = combinedColVeg
      .filter(ee.Filter.eq('year', rec.y))
      .filter(ee.Filter.eq('month', rec.mm));

    var img = ee.Image(ee.Algorithms.If(
      filtered.size().gt(0),
      filtered.first().select('trees_flooded').toByte(),
      emptyByte('trees_flooded')
    ));

    var usedSeason = (APPLY_DW_VEG_MASK && YM_TO_SEASONKEY[rec.ym]) ? YM_TO_SEASONKEY[rec.ym] : 'NA';
    var fb = (APPLY_DW_VEG_MASK && YM_TO_FALLBACK[rec.ym]) ? '__FB' : '';
    var desc = rec.ym + '__' + usedSeason + fb + '__TREES';

    var assetId = EXPORT_CLASS_FLOODED_IC_PATH + '/' + desc;
    var task = Export.image.toAsset({
      image: img, description: desc, assetId: assetId,
      region: regionT, scale: EXPORT_SCALE, maxPixels: EXPORT_MAX_PIXELS,
      crs: 'EPSG:4326', pyramidingPolicy: 'mode'
    });
    fastStart(task, desc, idx);
  });
}

// (A3) MONTHLY UCClass categorical — names: YYYY_MM__SEASON[__FB]
if (EXPORT_ENABLE && EXPORT_CLASS_FLOODED_MONTHLY_ENABLE) {
  var regionC = EXPORT_REGION || aoi;
  var monthsC = enumerateMonths(WATER_DATE_START, WATER_DATE_END);

  monthsC.forEach(function(rec, idx) {
    var filtered = ucMonthlyCol
      .filter(ee.Filter.eq('year', rec.y))
      .filter(ee.Filter.eq('month', rec.mm));

    var img = ee.Image(ee.Algorithms.If(
      filtered.size().gt(0),
      filtered.first().select('class_flooded').toByte(),
      emptyByte('class_flooded')
    ));

    var usedSeason = (APPLY_DW_VEG_MASK && YM_TO_SEASONKEY[rec.ym]) ? YM_TO_SEASONKEY[rec.ym] : 'NA';
    var fb = (APPLY_DW_VEG_MASK && YM_TO_FALLBACK[rec.ym]) ? '__FB' : '';
    var desc = rec.ym + '__' + usedSeason + fb;

    var assetId = EXPORT_CLASS_FLOODED_IC_PATH + '/' + desc;
    var task = Export.image.toAsset({
      image: img, description: desc, assetId: assetId,
      region: regionC, scale: EXPORT_SCALE, maxPixels: EXPORT_MAX_PIXELS,
      crs: 'EPSG:4326', pyramidingPolicy: 'mode'
    });
    fastStart(task, desc, idx);
  });
}

// =====================================================================
// (B) NEW: SEASONAL UC (TARGET-SEASON) — one-hot multiband
//         names: SEAS__<targetKey>__<seasonUsedKey>[__FB]
//         where targetKey = baseStart_baseEnd (calendar season of target)
//               seasonUsedKey = DW season window actually used
// =====================================================================
if (EXPORT_ENABLE && EXPORT_UCCLASS_SEASONAL_ENABLE && APPLY_DW_VEG_MASK) {

  // Helper: DW mode image for a seasonKey string (or empty if "EMPTY_*")
  function modeForSeasonKey(kStr) {
    var parts = ee.String(kStr).split('_');
    var isEmpty = ee.Algorithms.IsEqual(parts.get(0), 'EMPTY');
    return ee.Image(ee.Algorithms.If(
      isEmpty,
      ee.Image(0).rename('label_mode').updateMask(ee.Image(0)).clip(aoi),
      (function() {
        var s = ee.Date.parse('YYYYMMdd', parts.get(0));
        var e = ee.Date.parse('YYYYMMdd', parts.get(1));
        var col = ee.ImageCollection(DYNAMIC_WORLD_ID)
                    .filterBounds(aoi)
                    .filterDate(s, ee.Date(e).advance(1,'day'))
                    .select('label');
        var mode = col.reduce(ee.Reducer.mode()).rename('label_mode').clip(aoi);
        return mode;
      })()
    ));
  }

  // Build list of distinct TARGET seasons (calendar base windows)
  var distinctTargetKeys = ee.List(monthSeasonFC.aggregate_array('baseKey')).distinct();

  // Server-side: resolve season-used per target baseKey; return FC
  var targetMetaFC = ee.FeatureCollection(distinctTargetKeys.map(function(k) {
    k = ee.String(k);
    var parts = k.split('_');
    var s = ee.Date.parse('YYYYMMdd', parts.get(0));
    var e = ee.Date.parse('YYYYMMdd', parts.get(1));

    var anyFeat = ee.Feature(monthSeasonFC.filter(ee.Filter.eq('baseKey', k)).first());
    var seasonType = ee.String(anyFeat.get('seasonType')); // 'wet' or 'dry'

    function baseHasData(ss, ee_) {
      var sC = clampStart(ss);
      var eC = clampEnd(ee_);
      var invalid = sC.millis().gt(eC.millis());
      var cnt = ee.Number(ee.Algorithms.If(invalid, 0, filterDWSeason(sC, eC).size()));
      return cnt.gt(0);
    }

    var hasBase = baseHasData(s, e);
    var baseDict = ee.Dictionary({start: s, end: e});

    var result = ee.Dictionary(ee.Algorithms.If(
      seasonType.compareTo('wet').eq(0),
      ee.Algorithms.If(hasBase,
        {found:true, chosen:{start:s, end:e, startClamped:clampStart(s), endClamped:clampEnd(e)}, fallbackUsed:false},
        selectSeasonWithData(wetForwardCandidates(baseDict))
      ),
      ee.Algorithms.If(hasBase,
        {found:true, chosen:{start:s, end:e, startClamped:clampStart(s), endClamped:clampEnd(e)}, fallbackUsed:false},
        selectSeasonWithData(dryBackwardCandidates(baseDict))
      )
    ));

    var chosen = ee.Dictionary(result.get('chosen'));
    var sC = ee.Date(chosen.get('startClamped'));
    var eC = ee.Date(chosen.get('endClamped'));
    var found = ee.Algorithms.IsEqual(result.get('found'), true);

    var usedKey = ee.String(ee.Algorithms.If(
      found,
      ee.String(sC.format('YYYYMMdd')).cat('_').cat(eC.format('YYYYMMdd')),
      ee.String('EMPTY_').cat(k)
    ));

    var fb = ee.Algorithms.IsEqual(result.get('fallbackUsed'), true);

    return ee.Feature(null, { baseKey: k, seasonUsedKey: usedKey, fallbackUsed: fb });
  }));

  // Small client pull ONCE: list of meta records {baseKey, seasonUsedKey, fallbackUsed}
  var TARGET_META = [];
  try {
    var listFeat = targetMetaFC.toList(targetMetaFC.size());
    TARGET_META = listFeat.map(function(f){ return ee.Feature(f).toDictionary(['baseKey','seasonUsedKey','fallbackUsed']); }).getInfo();
  } catch (e) { TARGET_META = []; }

  // Export loop over TARGET seasons (uses client strings; server work is inside each task)
  var regionU = EXPORT_REGION || aoi;

  TARGET_META.forEach(function(rec, idx) {
    var baseKeyStr = rec.baseKey;
    var usedKeyStr = rec.seasonUsedKey;
    var fbUsed = rec.fallbackUsed === true;

    // Months belonging to this target season (server-side)
    var ymList = ee.List(monthSeasonFC.filter(ee.Filter.eq('baseKey', baseKeyStr)).aggregate_array('ym'));
    var monthsCol = combinedCol.filter(ee.Filter.inList('ym', ymList));

    // Pre-DW seasonal water aggregate (OR across months)
    var waterAgg = ee.Image(ee.Algorithms.If(
      monthsCol.size().gt(0),
      monthsCol.map(function(im){ return ee.Image(im).select('water').unmask(0); })
               .reduce(ee.Reducer.max())
               .rename('waterAgg'),
      ee.Image(0).rename('waterAgg').updateMask(ee.Image(0))
    )).clip(aoi);

    // Mode image for the chosen season-used
    var modeImg = modeForSeasonKey(usedKeyStr);

    // One-hot UC bands from waterAgg × DW mode (PRE-DW logic)
    var trees = waterAgg.eq(1).and(modeImg.eq(1)).toByte().rename('UC_Trees');
    var shrub = waterAgg.eq(1).and(modeImg.eq(5)).toByte().rename('UC_Shrub');
    var grass = waterAgg.eq(1).and(modeImg.eq(2)).toByte().rename('UC_Grass');
    var crops = waterAgg.eq(1).and(modeImg.eq(4)).toByte().rename('UC_Crops');
    var bb    = waterAgg.eq(1).and(modeImg.eq(6).or(modeImg.eq(7))).toByte().rename('UC_BuiltBare');

    var out = ee.Image.cat([trees, shrub, grass, crops, bb])
              .set('targetKey', baseKeyStr)
              .set('seasonUsedKey', usedKeyStr)
              .set('fallbackUsed', fbUsed);

    // Name: SEAS__<target>__<used>[__FB]
    var desc = 'SEAS__' + baseKeyStr + '__' + usedKeyStr + (fbUsed ? '__FB' : '');
    var assetId = EXPORT_CLASS_FLOODED_IC_PATH + '/' + desc;

    var task = Export.image.toAsset({
      image: out, description: desc, assetId: assetId,
      region: regionU, scale: EXPORT_SCALE, maxPixels: EXPORT_MAX_PIXELS,
      crs: 'EPSG:4326', pyramidingPolicy: 'mode'
    });
    fastStart(task, desc, idx);
  });
}

// (C) Seasonal DW Mode rasters — names: SEASDW__YYYYMMDD_YYYYMMDD
if (EXPORT_ENABLE && EXPORT_SEASONAL_DWMODE_ENABLE && APPLY_DW_VEG_MASK) {
  var keys3 = (function(){ try { return distinctSeasonKeys.getInfo(); } catch (e) { return []; } })();
  keys3.forEach(function(kStr, idx) {
    var modeImg = ee.Image(seasonKeyToDWModeDict.get(kStr));
    var img = ee.Image(ee.Algorithms.If(modeImg, modeImg.rename('label_mode').toByte(), emptyDWMode()));
    var desc = 'SEASDW__' + kStr;
    var assetId = EXPORT_SEASONAL_DWMODE_PATH + '/' + desc;
    var task = Export.image.toAsset({
      image: img, description: desc, assetId: assetId,
      region: aoi, scale: EXPORT_SCALE, maxPixels: EXPORT_MAX_PIXELS,
      crs: 'EPSG:4326', pyramidingPolicy: 'mode'
    });
    fastStart(task, desc, idx);
  });
}

// (D) Permanent Water Core (optional) — non-blocking
if (!USE_PRECOMPUTED_PERM_CORE && PERM_EXPORT_ENABLE && APPLY_BUILT_BARE_OUTSIDE_CORE && APPLY_DW_VEG_MASK) {
  var descCore = 'PermanentWater_core_thr' + Math.round(PERM_THRESHOLD * 100);
  var taskCore = Export.image.toAsset({
    image: permanentCore.selfMask().toByte(),
    description: descCore, assetId: PERM_EXPORT_ASSET_ID,
    region: aoi, scale: EXPORT_SCALE, maxPixels: EXPORT_MAX_PIXELS,
    crs: 'EPSG:4326', pyramidingPolicy: 'mode'
  });
  fastStart(taskCore, descCore, 0);
}

