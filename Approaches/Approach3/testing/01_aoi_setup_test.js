// ********************************************
// Approach3 testing script
// AOI setup, optional tile-grid preview, and Dynamic World preview
//
// Run this file in the Earth Engine Code Editor.
// Default AOI mode is "drawn": draw one polygon/rectangle on the map, then set
// the AOI. Switch to "basin" to use the HydroBASINS filter below.
// ********************************************

// =====================================================================
// 0) AOI PARAMETERS
// =====================================================================

var AOI_MODE = 'drawn';
// Options: 'drawn' | 'basin'

var HYDROBASINS_LEVEL = 4;
var HYBAS_ID = 1041259950;

var TILE_CRS = 'EPSG:3857';
var TILE_SCALE_M = 50000;

var DEFAULT_METHOD = 'individual';
// Options: 'individual' | 'aggregate'

var DEFAULT_TARGET_DATE = '2025-01-03';
var DEFAULT_SEARCH_DAYS = 15;
var DEFAULT_START_DATE = '2025-01-01';
var DEFAULT_END_DATE = '2025-02-01';

var water_thr = 0.5;
var water_low_thr = 0.05;
var floodedveg_thr = 0.3;

var MAP_CENTER_LON = 29.5;
var MAP_CENTER_LAT = -6.5;
var MAP_ZOOM = 6;

// These globals are intentionally kept for the next testing steps.
// If tileGrid is set, later processing/export steps should run per tile.
// If tileGrid is null, later processing/export steps should run over the AOI.
var aoi = null;
var tileGrid = null;
var dwBundle = null;

// =====================================================================
// 1) REFERENCE BASIN
// =====================================================================

function hydrobasinsCollectionId(level) {
  return 'WWF/HydroSHEDS/v1/Basins/hybas_' + level;
}

var hydrobasins = ee.FeatureCollection(hydrobasinsCollectionId(HYDROBASINS_LEVEL))
  .filter(ee.Filter.eq('HYBAS_ID', HYBAS_ID));

var basinAoi = hydrobasins.geometry();

print('HydroBASINS collection:', hydrobasinsCollectionId(HYDROBASINS_LEVEL));
print('HYBAS_ID:', HYBAS_ID);
print('HydroBASINS features matched - should be 1:', hydrobasins.size());

// =====================================================================
// 2) DRAWN AOI SUPPORT
// =====================================================================

Map.setOptions('SATELLITE');
Map.setCenter(MAP_CENTER_LON, MAP_CENTER_LAT, MAP_ZOOM);

var drawingTools = Map.drawingTools();
drawingTools.setShown(true);
drawingTools.setLinked(false);
drawingTools.setDrawModes(['polygon', 'rectangle']);

function flattenGeometry(geometry) {
  var type = geometry.type().getInfo();
  if (type === 'GeometryCollection') {
    var output = [];
    geometry.geometries().getInfo().forEach(function(geometryDict) {
      output = output.concat(flattenGeometry(ee.Geometry(geometryDict)));
    });
    return output;
  }
  return [geometry];
}

function collectFirstDrawnAoi() {
  var drawnAoi = null;

  drawingTools.layers().forEach(function(layer) {
    if (drawnAoi) {
      return;
    }

    var eeObject = layer.getEeObject();
    if (!eeObject) {
      return;
    }

    flattenGeometry(ee.Geometry(eeObject)).forEach(function(geometry) {
      if (drawnAoi) {
        return;
      }

      var type = geometry.type().getInfo();
      if (type === 'Polygon' || type === 'Rectangle' || type === 'MultiPolygon') {
        drawnAoi = geometry;
      }
    });
  });

  return drawnAoi;
}

function resolveAoi(mode) {
  if (mode === 'basin') {
    return basinAoi;
  }

  if (mode === 'drawn') {
    return collectFirstDrawnAoi();
  }

  throw new Error('Unsupported AOI_MODE: ' + mode);
}

// =====================================================================
// 3) AOI AND TILE-GRID DISPLAY
// =====================================================================

Map.addLayer(
  hydrobasins.style({
    color: '2b83ba',
    fillColor: '00000000',
    width: 2
  }),
  {},
  'Reference HydroBASINS basin',
  false
);

var activeAoiLayer = null;
var tileGridLayer = null;
var dwLayers = [];

function featureCollectionFromGeometry(geometry) {
  return ee.FeatureCollection([ee.Feature(geometry)]);
}

function removeLayer(layer) {
  if (layer) {
    Map.remove(layer);
  }
}

function clearDwLayers() {
  dwLayers.forEach(function(layer) {
    removeLayer(layer);
  });
  dwLayers = [];
  dwBundle = null;
}

function addDwLayer(image, visParams, name, shown) {
  var layer = Map.addLayer(image, visParams, name, shown);
  dwLayers.push(layer);
  return layer;
}

function clearDrawnGeometries() {
  var layers = drawingTools.layers();
  try {
    layers.reset([]);
  } catch (error) {
    while (layers.length() > 0) {
      layers.remove(layers.get(0));
    }
  }
}

function clearActiveState(clearDrawings) {
  aoi = null;
  tileGrid = null;
  clearDwLayers();

  removeLayer(activeAoiLayer);
  removeLayer(tileGridLayer);
  activeAoiLayer = null;
  tileGridLayer = null;

  if (clearDrawings) {
    clearDrawnGeometries();
  }
}

function showActiveAoi(selectedAoi, label) {
  aoi = selectedAoi;
  tileGrid = null;
  clearDwLayers();

  removeLayer(activeAoiLayer);
  removeLayer(tileGridLayer);
  tileGridLayer = null;

  activeAoiLayer = Map.addLayer(
    featureCollectionFromGeometry(aoi).style({
      color: '00ffff',
      fillColor: '33ffff22',
      width: 3
    }),
    {},
    'ACTIVE AOI - ' + label,
    true
  );

  Map.centerObject(aoi, label === 'basin' ? 6 : 11);

  print('Active AOI mode:', label);
  print('Active AOI geometry:', aoi);
  print('Active AOI area km2:', ee.Number(aoi.area(1)).divide(1e6));
  print('Active AOI bounds:', aoi.bounds(1));
}

function buildTileGrid(selectedAoi, tileScaleM) {
  var projection = ee.Projection(TILE_CRS);
  return ee.FeatureCollection(selectedAoi.coveringGrid(projection, tileScaleM))
    .filterBounds(selectedAoi);
}

function showTileGrid(tileScaleM) {
  tileGrid = buildTileGrid(aoi, tileScaleM);

  removeLayer(tileGridLayer);

  tileGridLayer = Map.addLayer(
    tileGrid.style({
      color: 'ffcc00',
      fillColor: '00000000',
      width: 1
    }),
    {},
    'Tile grid - ' + tileScaleM + ' m',
    true
  );

  print('Tile CRS:', TILE_CRS);
  print('Tile scale m:', tileScaleM);
  print('Tile count:', tileGrid.size());
  print('Tile grid:', tileGrid);
  print('Processing/export unit:', 'tileGrid features; later exports should create one image per tile in the target image collection.');
}

// =====================================================================
// 4) DYNAMIC WORLD HELPERS
// =====================================================================

var DW_PROBABILITY_BANDS = [
  'water', 'trees', 'grass', 'flooded_vegetation', 'crops',
  'shrub_and_scrub', 'built', 'bare', 'snow_and_ice'
];

var DW_LABEL_PALETTE = [
  '419bdf', // water
  '397d49', // trees
  '88b053', // grass
  '7a87c6', // flooded vegetation
  'e49635', // crops
  'dfc35a', // shrub and scrub
  'c4281b', // built
  'a59b8f', // bare
  'b39fe1'  // snow and ice
];

function isValidDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !isNaN(Date.parse(value + 'T00:00:00Z'));
}

function processWaterMask(image) {
  var water = image.select('water');
  var waterMasked = water
    .where(water.lte(water_low_thr), 0)
    .updateMask(water.gt(water_thr).or(water.lte(water_low_thr)))
    .where(water.gt(water_thr), 1);

  return ee.Image(
    waterMasked.rename('water')
      .copyProperties(image, image.propertyNames())
  );
}

function buildDwThresholdClass(probabilityImage) {
  var water = probabilityImage.select('water');
  return ee.Image(0)
    .where(water.gt(water_low_thr).and(water.lte(water_thr)), 1)
    .where(water.gt(water_thr), 2)
    .updateMask(water.mask())
    .rename('dw_water_threshold_class')
    .clip(aoi)
    .toByte();
}

function buildDwSource(dwWaterComponent, dwFloodedVegComponent) {
  var dwOpen = dwWaterComponent.unmask(0).eq(1);
  var dwFlooded = dwFloodedVegComponent.unmask(0).eq(1);

  var source = ee.Image(0)
    .where(dwOpen, 1)
    .where(dwFlooded, 2)
    .where(dwOpen.and(dwFlooded), 3)
    .rename('dw_source_component')
    .clip(aoi)
    .toByte();

  return source.updateMask(source.gt(0));
}

function buildDwWaterFloodedClass(dwWaterComponent, dwFloodedVegComponent) {
  var dwOpen = dwWaterComponent.unmask(0).eq(1);
  var dwFlooded = dwFloodedVegComponent.unmask(0).eq(1);

  var classes = ee.Image(0)
    .where(dwOpen, 1)
    .where(dwFlooded, 2)
    .rename('dw_water_floodedveg_class')
    .clip(aoi)
    .toByte();

  return classes.updateMask(classes.gt(0));
}

function buildDwBundleFromImage(image) {
  var probabilityImage = image.select(DW_PROBABILITY_BANDS).clip(aoi);
  var waterMask = processWaterMask(image).clip(aoi);
  var dwWaterComponent = waterMask.eq(1).rename('dw_water_component');
  var dwFloodedVegComponent = probabilityImage
    .select('flooded_vegetation')
    .gt(floodedveg_thr)
    .rename('dw_floodedveg_component');
  var waterDw = dwWaterComponent.unmask(0)
    .or(dwFloodedVegComponent.unmask(0))
    .rename('water')
    .clip(aoi)
    .toByte();

  return {
    labelImage: image.select('label').clip(aoi),
    probabilityImage: probabilityImage,
    waterThresholdClass: buildDwThresholdClass(probabilityImage),
    dwWaterComponent: dwWaterComponent.selfMask(),
    dwFloodedVegComponent: dwFloodedVegComponent.selfMask(),
    waterFloodedClass: buildDwWaterFloodedClass(dwWaterComponent, dwFloodedVegComponent),
    waterDw: waterDw.selfMask(),
    source: buildDwSource(dwWaterComponent, dwFloodedVegComponent)
  };
}

function addClosestPixelBands(image, targetDate) {
  image = ee.Image(image);
  var imageDate = ee.Date(image.get('system:time_start'));
  var signedDeltaDays = imageDate.difference(targetDate, 'day');
  var absDeltaDays = signedDeltaDays.abs();
  var selectedDate = ee.Number.parse(imageDate.format('YYYYMMdd'));

  var validMask = image.select('water').mask();
  var quality = ee.Image.constant(absDeltaDays.multiply(-1))
    .rename('dw_closest_quality')
    .toFloat()
    .updateMask(validMask);

  return image.addBands(ee.Image.cat([
    quality,
    ee.Image.constant(selectedDate)
      .rename('dw_selected_date_yyyymmdd')
      .toInt32()
      .updateMask(validMask),
    ee.Image.constant(absDeltaDays)
      .rename('dw_abs_delta_days')
      .toFloat()
      .updateMask(validMask),
    ee.Image.constant(signedDeltaDays)
      .rename('dw_signed_delta_days')
      .toFloat()
      .updateMask(validMask)
  ]));
}

function buildClosestPixelMosaic(collection, targetDate) {
  return ee.ImageCollection(collection.map(function(image) {
    return addClosestPixelBands(image, targetDate);
  }))
    .qualityMosaic('dw_closest_quality')
    .clip(aoi);
}

function addClosestPixelDiagnostics(bundle, closestMosaic) {
  bundle.selectedDate = closestMosaic.select('dw_selected_date_yyyymmdd');
  bundle.absDeltaDays = closestMosaic.select('dw_abs_delta_days');
  bundle.signedDeltaDays = closestMosaic.select('dw_signed_delta_days');
  return bundle;
}

function buildDwBundleFromCollection(collection) {
  var probabilityImage = collection.select(DW_PROBABILITY_BANDS).mean().clip(aoi);
  var waterMaskCollection = collection.map(processWaterMask);
  var waterOccurrence = waterMaskCollection.sum().rename('water_occurrence');
  var dwWaterComponent = waterOccurrence.gt(0).rename('dw_water_component');
  var dwFloodedVegComponent = probabilityImage
    .select('flooded_vegetation')
    .gt(floodedveg_thr)
    .rename('dw_floodedveg_component');
  var waterDw = dwWaterComponent.unmask(0)
    .or(dwFloodedVegComponent.unmask(0))
    .rename('water')
    .clip(aoi)
    .toByte();

  return {
    labelImage: null,
    probabilityImage: probabilityImage,
    waterThresholdClass: buildDwThresholdClass(probabilityImage),
    dwWaterComponent: dwWaterComponent.selfMask().clip(aoi),
    dwFloodedVegComponent: dwFloodedVegComponent.selfMask().clip(aoi),
    waterFloodedClass: buildDwWaterFloodedClass(dwWaterComponent, dwFloodedVegComponent),
    waterDw: waterDw.selfMask(),
    source: buildDwSource(dwWaterComponent, dwFloodedVegComponent),
    waterOccurrence: waterOccurrence.clip(aoi)
  };
}

function showDwBundle(bundle, labelPrefix, showRawLabel) {
  clearDwLayers();
  dwBundle = bundle;

  if (showRawLabel && bundle.labelImage) {
    addDwLayer(
      bundle.labelImage,
      {min: 0, max: 8, palette: DW_LABEL_PALETTE},
      labelPrefix + ' - DW label',
      true
    );
  }

  addDwLayer(
    bundle.probabilityImage.select('water'),
    {min: 0, max: 1, palette: ['ffffff', 'a6cee3', '1f78b4', '08306b']},
    labelPrefix + ' - water probability',
    false
  );

  addDwLayer(
    bundle.waterFloodedClass,
    {min: 1, max: 2, palette: ['1f78b4', '7a87c6']},
    labelPrefix + ' - class 1 water, 2 inundated vegetation',
    true
  );

  if (bundle.absDeltaDays) {
    addDwLayer(
      bundle.absDeltaDays,
      {min: 0, max: bundle.dateDeltaMax || DEFAULT_SEARCH_DAYS, palette: ['1a9850', 'fee08b', 'd73027']},
      labelPrefix + ' - selected date distance days',
      true
    );
  }

  if (bundle.selectedDate) {
    addDwLayer(
      bundle.selectedDate,
      {},
      labelPrefix + ' - selected date YYYYMMDD',
      false
    );
  }
}

function dynamicWorldCollection(startDate, endDate) {
  return ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
    .filterBounds(aoi)
    .filterDate(startDate, endDate);
}

function runDynamicWorldIndividual() {
  if (!aoi) {
    status.setValue('Set the AOI before loading Dynamic World.');
    return;
  }

  var targetDateText = targetDateBox.getValue();
  if (!isValidDateString(targetDateText)) {
    status.setValue('Enter target date as YYYY-MM-DD.');
    return;
  }

  var searchDays = parseInt(searchDaysBox.getValue(), 10);
  if (!isFinite(searchDays) || searchDays < 0) {
    status.setValue('Enter a search window of 0 or more days.');
    return;
  }

  var targetDate = ee.Date(targetDateText);
  var startDate = targetDate.advance(-searchDays, 'day');
  var endDate = targetDate.advance(searchDays + 1, 'day');

  var collection = dynamicWorldCollection(startDate, endDate);

  status.setValue('Searching Dynamic World around ' + targetDateText + '...');

  collection.size().evaluate(function(count, error) {
    if (error) {
      status.setValue('Dynamic World search failed. See Console.');
      print('Dynamic World search error:', error);
      return;
    }

    if (!count) {
      clearDwLayers();
      status.setValue('No Dynamic World image found in the selected search window.');
      print('Dynamic World search window:', startDate, endDate);
      return;
    }

    var closestMosaic = buildClosestPixelMosaic(collection, targetDate);
    var bundle = addClosestPixelDiagnostics(
      buildDwBundleFromImage(closestMosaic),
      closestMosaic
    );
    bundle.dateDeltaMax = searchDays;

    showDwBundle(bundle, 'DW closest-pixel ' + targetDateText, false);
    status.setValue('Dynamic World closest-pixel preview added for ' + targetDateText + '.');

    print('Dynamic World individual target date:', targetDateText);
    print('Dynamic World individual method:', 'per-pixel closest observation within the selected search window');
    print('Dynamic World search window:', startDate, endDate);
    print('Dynamic World candidate count in search window:', count);
    print('Dynamic World thresholds:', {
      water_thr: water_thr,
      water_low_thr: water_low_thr,
      floodedveg_thr: floodedveg_thr
    });
    print('Dynamic World class preview codes:', '1=open water; 2=inundated/flooded vegetation; flooded vegetation has priority if both thresholds are true.');
    print('Dynamic World selected date layer:', bundle.selectedDate);
    print('Dynamic World selected date distance layer:', bundle.absDeltaDays);
    if (tileGrid) {
      print('Tile grid is available for later per-tile processing/export:', tileGrid.size());
    }
  });
}

function runDynamicWorldAggregate() {
  if (!aoi) {
    status.setValue('Set the AOI before loading Dynamic World.');
    return;
  }

  var startDateText = startDateBox.getValue();
  var endDateText = endDateBox.getValue();
  if (!isValidDateString(startDateText) || !isValidDateString(endDateText)) {
    status.setValue('Enter start and end dates as YYYY-MM-DD.');
    return;
  }

  if (Date.parse(startDateText + 'T00:00:00Z') >= Date.parse(endDateText + 'T00:00:00Z')) {
    status.setValue('End date must be after start date.');
    return;
  }

  var startDate = ee.Date(startDateText);
  var endDate = ee.Date(endDateText);
  var collection = dynamicWorldCollection(startDate, endDate);

  status.setValue('Loading Dynamic World aggregate for the selected date range...');

  collection.size().evaluate(function(count, error) {
    if (error) {
      status.setValue('Dynamic World aggregate failed. See Console.');
      print('Dynamic World aggregate error:', error);
      return;
    }

    if (!count) {
      clearDwLayers();
      status.setValue('No Dynamic World images found in the selected date range.');
      print('Dynamic World aggregate date range:', startDate, endDate);
      return;
    }

    var bundle = buildDwBundleFromCollection(collection);
    showDwBundle(bundle, 'DW aggregate', false);

    if (bundle.waterOccurrence) {
      addDwLayer(
        bundle.waterOccurrence,
        {min: 0, max: Math.max(1, count), palette: ['ffffff', '9ecae1', '3182bd', '08519c']},
        'DW aggregate - water occurrence count',
        false
      );
    }

    status.setValue('Dynamic World aggregate preview added for ' + count + ' images.');
    print('Dynamic World aggregate date range:', startDateText, endDateText);
    print('Dynamic World aggregate image count:', count);
    print('Dynamic World aggregate uses the same water/flooded-vegetation thresholds as the individual preview.');
    print('Dynamic World class preview codes:', '1=open water; 2=inundated/flooded vegetation; flooded vegetation has priority if both thresholds are true.');
    if (tileGrid) {
      print('Tile grid is available for later per-tile processing/export:', tileGrid.size());
    }
  });
}

function runDynamicWorldPreview() {
  var method = methodSelect.getValue();
  if (method === 'individual') {
    runDynamicWorldIndividual();
    return;
  }
  if (method === 'aggregate') {
    runDynamicWorldAggregate();
    return;
  }
  status.setValue('Unsupported Dynamic World method: ' + method);
}

// =====================================================================
// 5) CONTROL PANEL
// =====================================================================

var panel = ui.Panel({
  style: {
    position: 'top-left',
    width: '320px',
    padding: '8px',
    backgroundColor: 'rgba(255,255,255,0.92)'
  }
});

panel.add(ui.Label({
  value: 'Approach3 AOI setup test',
  style: {
    fontSize: '16px',
    fontWeight: 'bold'
  }
}));

panel.add(ui.Label(
  'Draw one polygon or rectangle, then set the AOI. Use basin mode to test the HydroBASINS filter.'
));

var status = ui.Label('', {
  color: '444444',
  padding: '4px 0'
});

var modeSelect = ui.Select({
  items: ['drawn', 'basin'],
  value: AOI_MODE,
  style: {
    width: '120px'
  }
});

panel.add(ui.Panel([
  ui.Label('AOI mode:'),
  modeSelect
], ui.Panel.Layout.Flow('horizontal')));

panel.add(ui.Button({
  label: 'Set AOI',
  onClick: function() {
    var selectedMode = modeSelect.getValue();
    var selectedAoi = resolveAoi(selectedMode);

    if (!selectedAoi) {
      status.setValue('Draw one polygon or rectangle first, then set the AOI again.');
      return;
    }

    showActiveAoi(selectedAoi, selectedMode);
    status.setValue('AOI set. Adjust the tile scale and add the grid if needed.');
  }
}));

panel.add(ui.Label({
  value: 'Tile grid',
  style: {
    fontWeight: 'bold',
    margin: '10px 0 2px 0'
  }
}));

var gridEnabled = ui.Checkbox({
  label: 'Show tile grid',
  value: false
});

var tileScaleBox = ui.Textbox({
  value: String(TILE_SCALE_M),
  placeholder: 'Tile size in meters',
  style: {
    width: '120px'
  }
});

panel.add(gridEnabled);
panel.add(ui.Panel([
  ui.Label('Scale m:'),
  tileScaleBox
], ui.Panel.Layout.Flow('horizontal')));

panel.add(ui.Button({
  label: 'Add grid',
  onClick: function() {
    if (!aoi) {
      status.setValue('Set the AOI before adding the grid.');
      return;
    }

    if (!gridEnabled.getValue()) {
      removeLayer(tileGridLayer);
      tileGridLayer = null;
      tileGrid = null;
      status.setValue('Tile grid is off.');
      return;
    }

    var tileScaleM = parseInt(tileScaleBox.getValue(), 10);
    if (!isFinite(tileScaleM) || tileScaleM <= 0) {
      status.setValue('Enter a positive tile scale in meters.');
      return;
    }

    showTileGrid(tileScaleM);
    status.setValue('Tile grid added using ' + tileScaleM + ' m cells.');
  }
}));

panel.add(ui.Label({
  value: 'Dynamic World',
  style: {
    fontWeight: 'bold',
    margin: '10px 0 2px 0'
  }
}));

var methodSelect = ui.Select({
  items: ['individual', 'aggregate'],
  value: DEFAULT_METHOD,
  style: {
    width: '130px'
  }
});

var targetDateBox = ui.Textbox({
  value: DEFAULT_TARGET_DATE,
  placeholder: 'YYYY-MM-DD',
  style: {
    width: '120px'
  }
});

var searchDaysBox = ui.Textbox({
  value: String(DEFAULT_SEARCH_DAYS),
  placeholder: 'days',
  style: {
    width: '60px'
  }
});

var startDateBox = ui.Textbox({
  value: DEFAULT_START_DATE,
  placeholder: 'YYYY-MM-DD',
  style: {
    width: '120px'
  }
});

var endDateBox = ui.Textbox({
  value: DEFAULT_END_DATE,
  placeholder: 'YYYY-MM-DD',
  style: {
    width: '120px'
  }
});

panel.add(ui.Panel([
  ui.Label('Method:'),
  methodSelect
], ui.Panel.Layout.Flow('horizontal')));

panel.add(ui.Panel([
  ui.Label('Date:'),
  targetDateBox,
  ui.Label('+- days:'),
  searchDaysBox
], ui.Panel.Layout.Flow('horizontal')));

panel.add(ui.Panel([
  ui.Label('Start:'),
  startDateBox
], ui.Panel.Layout.Flow('horizontal')));

panel.add(ui.Panel([
  ui.Label('End:'),
  endDateBox
], ui.Panel.Layout.Flow('horizontal')));

panel.add(ui.Button({
  label: 'Add Dynamic World',
  onClick: runDynamicWorldPreview
}));

panel.add(ui.Button({
  label: 'Clear all test layers',
  onClick: function() {
    clearActiveState(true);
    gridEnabled.setValue(false);
    tileScaleBox.setValue(String(TILE_SCALE_M));
    status.setValue('AOI, grid, Dynamic World layers, and drawn geometries cleared. Start with a new AOI.');
  },
  style: {
    margin: '10px 0 0 0'
  }
}));

panel.add(status);
Map.add(panel);

status.setValue('Draw an AOI or switch to basin mode, then set the AOI.');
