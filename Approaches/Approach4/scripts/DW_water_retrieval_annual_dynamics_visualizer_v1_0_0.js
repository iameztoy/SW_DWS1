/**** Exported hydrological water-dynamics visualizer v1.0.0 ****/
/**** Standalone Google Earth Engine Code Editor application. ****/

/*
Purpose
-------
Load a multiband image exported by
DW_water_retrieval_annual_dynamics_tabs_v6_10.js and add every available band
to the map with the same metric-specific colour schemes used by that script.

The loader discovers band names at run time. It therefore supports the seven
bands in the default test image and additional annual-dynamics bands exported
in the future. Known suffixes and names determine the visualization family;
an unfamiliar future band receives a clearly identified generic display.

Important
---------
- This script changes visualization only. It never modifies pixel values.
- The default asset ID is an individual multiband image inside the user's
  Okavango asset hierarchy, not the parent folder or collection ID.
- Timing values are ordinal analysis days. Day 1 is the first day of the
  selected hydrological period, not calendar day-of-year.
*/

// -----------------------------------------------------------------------------
// Default asset and visualization constants copied from annual dynamics v6.10
// -----------------------------------------------------------------------------

var DEFAULT_IMAGE_ASSET =
  'projects/hardy-tenure-383607/assets/Okavango/' +
  'FirstObsWaterDay_Nov24Oct25/' +
  'hydrological_selected_water_dynamics_2024_11_to_2025_10_2';

var SOURCE_IMAGE = 'Single multiband image';
var SOURCE_COLLECTION_FIRST = 'ImageCollection: first image';

var TIMING_SPLIT = 'Two half-period ramps (recommended)';
var TIMING_MULTIHUE = 'Enhanced multi-hue continuous ramp';
var TIMING_VIRIDIS = 'Original Viridis continuous ramp';

var TIMING_VIRIDIS_PALETTE = [
  '440154', '3B528B', '21918C', '5EC962', 'FDE725'
];

var TIMING_FIRST_HALF_PALETTE = [
  '3F007D', '54278F', '2C7FB8', '41B6C4', '2CA25F', '99D8C9'
];

var TIMING_SECOND_HALF_PALETTE = [
  '8E0152', 'C51B7D', 'E34A33', 'FC8D59', 'FDBB84', 'FDD49E'
];

var TIMING_MULTIHUE_PALETTE = [
  '30123B', '4145AB', '4675ED', '39A2FC', '1BCFD4',
  '24ECA6', '61FC6C', 'A4FC3C', 'D1E834', 'F3C63A',
  'FE9B2D', 'F36315', 'D93806', 'A91501', '7A0403'
];

var DURATION_VIS = {
  min: 0,
  max: 366,
  palette: ['FFF7FB', 'ECE7F2', 'A6BDDB', '2B8CBE', '045A8D']
};

var FRACTION_VIS = {
  min: 0,
  max: 1,
  palette: ['FFFFFF', 'FFFFB2', 'FECC5C', 'FD8D3C', 'E31A1C']
};

var COUNT_VIS = {
  min: 0,
  max: 40,
  palette: ['FFFFFF', 'D0D1E6', 'A6BDDB', '3690C0', '034E7B']
};

var VALID_COUNT_VIS = {
  min: 0,
  max: 120,
  palette: ['FFFFFF', 'D0D1E6', 'A6BDDB', '3690C0', '034E7B']
};

var EPISODE_VIS = {
  min: 1,
  max: 6,
  palette: ['FFFFCC', 'C2E699', '78C679', '31A354', '006837', '004529']
};

var SOURCE_VIS = {
  min: 1,
  max: 15,
  palette: [
    '419BDF', 'F39C12', '8E44AD', '27AE60', '16A085',
    'D4AC0D', '7D6608', 'C0392B', '922B21', 'E67E22',
    'A04000', '1ABC9C', '117864', '9A7D0A', '2C3E50'
  ]
};

var GENERIC_PALETTE = [
  '440154', '3B528B', '21918C', '5EC962', 'FDE725'
];

var TYPE_TIMING = 'Analysis-day timing';
var TYPE_DURATION = 'Duration or lag';
var TYPE_FRACTION = 'Fraction';
var TYPE_EPISODE = 'Episode count';
var TYPE_SOURCE = 'Source bitmask';
var TYPE_VALID_COUNT = 'Coverage/valid-date count';
var TYPE_COUNT = 'Observation count';
var TYPE_GENERIC = 'Generic/unrecognized';

// -----------------------------------------------------------------------------
// Application state
// -----------------------------------------------------------------------------

var currentImage = null;
var currentMetadata = {};
var bandOrder = [];
var bandEntries = {};
var synchronizingBandSelect = false;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function cleanText(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function parseFiniteNumber(value, fallback) {
  var parsed = Number(value);
  return isFinite(parsed) ? parsed : fallback;
}

function periodDays() {
  return Math.max(1, Math.round(parseFiniteNumber(periodDaysBox.getValue(), 365)));
}

function genericRange() {
  var minValue = parseFiniteNumber(genericMinBox.getValue(), 0);
  var maxValue = parseFiniteNumber(genericMaxBox.getValue(), 1);

  if (maxValue <= minValue) {
    maxValue = minValue + 1;
  }

  return {min: minValue, max: maxValue};
}

function humanizeBandName(name) {
  var words = String(name).replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function classifyBand(name) {
  var lower = String(name).toLowerCase();

  if (/_analysis_day$/.test(lower)) {
    return TYPE_TIMING;
  }

  if (/_source$/.test(lower) || /source_mask/.test(lower)) {
    return TYPE_SOURCE;
  }

  if (/fraction/.test(lower)) {
    return TYPE_FRACTION;
  }

  if (/episode/.test(lower)) {
    return TYPE_EPISODE;
  }

  if (
    /_lag_days$/.test(lower) ||
    /_span_days$/.test(lower) ||
    /_spell_days$/.test(lower) ||
    /maximum_valid_gap_days$/.test(lower)
  ) {
    return TYPE_DURATION;
  }

  if (
    /valid.*count/.test(lower) ||
    /_date_count$/.test(lower) ||
    /footprint.*count/.test(lower) ||
    /masked.*count/.test(lower) ||
    /excluded.*count/.test(lower)
  ) {
    return TYPE_VALID_COUNT;
  }

  if (/count/.test(lower)) {
    return TYPE_COUNT;
  }

  return TYPE_GENERIC;
}

function continuousTimingVis() {
  return {
    min: 1,
    max: periodDays(),
    palette: timingPaletteSelect.getValue() === TIMING_MULTIHUE ?
      TIMING_MULTIHUE_PALETTE : TIMING_VIRIDIS_PALETTE
  };
}

function timingPreview(rawBand) {
  var totalDays = periodDays();
  var splitDay = Math.ceil(totalDays / 2);

  if (timingPaletteSelect.getValue() !== TIMING_SPLIT) {
    return {
      image: rawBand,
      vis: continuousTimingVis(),
      splitDay: splitDay
    };
  }

  var firstHalf = rawBand
    .updateMask(rawBand.lte(splitDay))
    .visualize({
      min: 1,
      max: splitDay,
      palette: TIMING_FIRST_HALF_PALETTE
    });

  var secondMin = Math.min(totalDays, splitDay + 1);
  var secondHalf = rawBand
    .updateMask(rawBand.gt(splitDay))
    .visualize({
      min: secondMin,
      max: totalDays,
      palette: TIMING_SECOND_HALF_PALETTE
    });

  return {
    image: ee.ImageCollection([firstHalf, secondHalf]).mosaic(),
    vis: {},
    splitDay: splitDay
  };
}

function displayForBand(name) {
  var rawBand = ee.Image(currentImage).select(name);
  var type = classifyBand(name);

  if (type === TYPE_TIMING) {
    var timing = timingPreview(rawBand);
    timing.type = type;
    return timing;
  }

  if (type === TYPE_DURATION) {
    return {image: rawBand, vis: DURATION_VIS, type: type};
  }

  if (type === TYPE_FRACTION) {
    return {image: rawBand, vis: FRACTION_VIS, type: type};
  }

  if (type === TYPE_EPISODE) {
    return {image: rawBand, vis: EPISODE_VIS, type: type};
  }

  if (type === TYPE_SOURCE) {
    return {image: rawBand, vis: SOURCE_VIS, type: type};
  }

  if (type === TYPE_VALID_COUNT) {
    return {image: rawBand, vis: VALID_COUNT_VIS, type: type};
  }

  if (type === TYPE_COUNT) {
    return {image: rawBand, vis: COUNT_VIS, type: type};
  }

  var range = genericRange();
  return {
    image: rawBand,
    vis: {min: range.min, max: range.max, palette: GENERIC_PALETTE},
    type: TYPE_GENERIC
  };
}

function removeVisualizationLayers() {
  map.layers().reset([]);
  bandEntries = {};
}

function registerLayers() {
  removeVisualizationLayers();

  bandOrder.forEach(function(name, index) {
    var display = displayForBand(name);
    var layer = ui.Map.Layer(
      display.image,
      display.vis,
      humanizeBandName(name),
      index === 0
    );

    map.layers().add(layer);
    bandEntries[name] = {
      name: name,
      type: display.type,
      layer: layer
    };
  });
}

function selectBand(name) {
  if (synchronizingBandSelect || !name || !bandEntries[name]) {
    return;
  }

  if (!keepVisibleCheckbox.getValue()) {
    bandOrder.forEach(function(otherName) {
      bandEntries[otherName].layer.setShown(otherName === name);
    });
  } else {
    bandEntries[name].layer.setShown(true);
  }

  renderLegend(name);
}

function refreshLayerStyles() {
  if (currentImage === null) {
    return;
  }

  bandOrder.forEach(function(name) {
    var display = displayForBand(name);
    var entry = bandEntries[name];
    entry.type = display.type;
    entry.layer.setEeObject(display.image);
    entry.layer.setVisParams(display.vis);
  });

  renderLegend(bandSelect.getValue());
  setStatus('Visualization settings updated. Exported pixel values are unchanged.');
}

function gradientThumbnail(vis) {
  var gradient = ee.Image.pixelLonLat().select('longitude');
  gradient = gradient.multiply((vis.max - vis.min) / 100).add(vis.min);

  return ui.Thumbnail({
    image: gradient.visualize(vis),
    params: {bbox: '0,0,100,10', dimensions: '280x18'},
    style: {stretch: 'horizontal', margin: '4px 0 2px 0'}
  });
}

function addRangeLegend(vis, leftLabel, middleLabel, rightLabel) {
  legendPanel.add(gradientThumbnail(vis));
  legendPanel.add(ui.Panel({
    widgets: [
      ui.Label(leftLabel, {fontSize: '10px', stretch: 'horizontal'}),
      ui.Label(middleLabel, {fontSize: '10px', textAlign: 'center', stretch: 'horizontal'}),
      ui.Label(rightLabel, {fontSize: '10px', textAlign: 'right', stretch: 'horizontal'})
    ],
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {stretch: 'horizontal'}
  }));
}

function renderTimingLegend() {
  var totalDays = periodDays();
  var splitDay = Math.ceil(totalDays / 2);
  var mode = timingPaletteSelect.getValue();

  if (mode === TIMING_SPLIT) {
    legendPanel.add(ui.Label(
      'First half of the analysis period',
      {fontSize: '10px', fontWeight: 'bold'}
    ));
    addRangeLegend(
      {min: 1, max: splitDay, palette: TIMING_FIRST_HALF_PALETTE},
      'Day 1',
      '',
      'Day ' + splitDay
    );

    var secondStart = Math.min(totalDays, splitDay + 1);
    legendPanel.add(ui.Label(
      'Second half of the analysis period',
      {fontSize: '10px', fontWeight: 'bold', margin: '7px 0 0 0'}
    ));
    addRangeLegend(
      {
        min: secondStart,
        max: totalDays,
        palette: TIMING_SECOND_HALF_PALETTE
      },
      'Day ' + secondStart,
      '',
      'Day ' + totalDays
    );
    return;
  }

  addRangeLegend(
    continuousTimingVis(),
    'Day 1',
    'Day ' + Math.round(totalDays / 2),
    'Day ' + totalDays
  );
}

function addSourceLegend() {
  var labels = [
    '1 = Dynamic World',
    '2 = HLS Landsat',
    '4 = HLS Sentinel-2',
    '8 = OPERA DSWx-S1'
  ];

  labels.forEach(function(label) {
    legendPanel.add(ui.Label(label, {fontSize: '10px', margin: '1px 0'}));
  });

  legendPanel.add(ui.Label(
    'Combined values are bitmask sums (for example, 9 = Dynamic World + S1).',
    {fontSize: '10px', color: '#555555', whiteSpace: 'normal'}
  ));
}

function renderLegend(name) {
  legendPanel.clear();

  if (!name || !bandEntries[name]) {
    legendPanel.add(ui.Label('Load an image and select a band.'));
    return;
  }

  var type = bandEntries[name].type;
  legendPanel.add(ui.Label({
    value: humanizeBandName(name),
    style: {fontWeight: 'bold', whiteSpace: 'normal'}
  }));
  legendPanel.add(ui.Label('Detected type: ' + type, {
    fontSize: '10px',
    color: type === TYPE_GENERIC ? '#B71C1C' : '#555555'
  }));

  if (type === TYPE_TIMING) {
    renderTimingLegend();
  } else if (type === TYPE_DURATION) {
    addRangeLegend(DURATION_VIS, '0 days', '183', '366 days');
  } else if (type === TYPE_FRACTION) {
    addRangeLegend(FRACTION_VIS, '0%', '50%', '100%');
  } else if (type === TYPE_EPISODE) {
    addRangeLegend(EPISODE_VIS, '1', '3', '6+');
  } else if (type === TYPE_SOURCE) {
    addSourceLegend();
  } else if (type === TYPE_VALID_COUNT) {
    addRangeLegend(VALID_COUNT_VIS, '0', '60', '120+');
  } else if (type === TYPE_COUNT) {
    addRangeLegend(COUNT_VIS, '0', '20', '40+');
  } else {
    var range = genericRange();
    addRangeLegend(
      {min: range.min, max: range.max, palette: GENERIC_PALETTE},
      String(range.min),
      String((range.min + range.max) / 2),
      String(range.max)
    );
    legendPanel.add(ui.Label(
      'This band name is not yet mapped to an annual-dynamics metric family. Adjust the generic range if needed.',
      {fontSize: '10px', color: '#B71C1C', whiteSpace: 'normal'}
    ));
  }
}

function setStatus(message, isError) {
  statusLabel.setValue(message);
  statusLabel.style().set('color', isError ? '#B71C1C' : '#1B5E20');
}

function metadataPeriodDays(metadata) {
  var storedDays = parseFiniteNumber(metadata.analysis_period_days, NaN);
  if (isFinite(storedDays) && storedDays > 0) {
    return Math.round(storedDays);
  }

  var startText = cleanText(metadata.analysis_start_date);
  var endText = cleanText(metadata.analysis_end_date);

  if (startText && endText) {
    var startDate = new Date(startText + 'T00:00:00Z');
    var endDate = new Date(endText + 'T00:00:00Z');
    var difference = Math.round((endDate - startDate) / 86400000) + 1;

    if (isFinite(difference) && difference > 0) {
      return difference;
    }
  }

  return periodDays();
}

function metadataSummary(metadata, assetId, bandCount) {
  var lines = [
    'Asset: ' + assetId,
    'Bands found: ' + bandCount,
    'Analysis period: ' + (metadata.analysis_period || 'not stored'),
    'Start: ' + (metadata.analysis_start_date || 'not stored'),
    'End: ' + (metadata.analysis_end_date || 'not stored')
  ];
  return lines.join('\n');
}

function imageFromControls(assetId) {
  if (sourceTypeSelect.getValue() === SOURCE_COLLECTION_FIRST) {
    return ee.Image(ee.ImageCollection(assetId).first());
  }
  return ee.Image(assetId);
}

function loadExportedImage() {
  var assetId = cleanText(assetBox.getValue());

  if (!assetId) {
    setStatus('Enter an Earth Engine image asset ID.', true);
    return;
  }

  setStatus('Loading band names and analysis-period metadata…');
  loadButton.setDisabled(true);
  bandSelect.setDisabled(true);

  var candidate = imageFromControls(assetId);
  var request = ee.Dictionary({
    band_names: candidate.bandNames(),
    metadata: candidate.toDictionary([
      'analysis_period',
      'analysis_start_date',
      'analysis_end_date',
      'analysis_period_days',
      'analysis_period_months',
      'timing_value_definition',
      'analysis_day_timing_visualization',
      'selected_water_classes',
      'same_day_fusion'
    ])
  });

  request.evaluate(function(result, error) {
    loadButton.setDisabled(false);

    if (error || !result || !result.band_names) {
      setStatus(
        'Could not load the asset. Confirm that the full asset ID, source type, and access permissions are correct. ' +
        (error ? String(error) : ''),
        true
      );
      return;
    }

    var names = result.band_names || [];
    if (names.length === 0) {
      setStatus('The selected image contains no bands.', true);
      return;
    }

    currentImage = candidate;
    currentMetadata = result.metadata || {};
    bandOrder = names;
    periodDaysBox.setValue(String(metadataPeriodDays(currentMetadata)), false);

    registerLayers();

    synchronizingBandSelect = true;
    bandSelect.items().reset(bandOrder);
    bandSelect.setValue(bandOrder[0], false);
    bandSelect.setDisabled(false);
    synchronizingBandSelect = false;

    metadataLabel.setValue(metadataSummary(
      currentMetadata,
      assetId,
      bandOrder.length
    ));
    renderLegend(bandOrder[0]);
    map.centerObject(currentImage, 7);

    var genericCount = bandOrder.filter(function(name) {
      return classifyBand(name) === TYPE_GENERIC;
    }).length;

    setStatus(
      'Loaded ' + bandOrder.length + ' bands. The first band is visible; use the selector or Layers panel to compare them.' +
      (genericCount > 0 ? ' ' + genericCount + ' unfamiliar band name(s) use the generic display.' : '')
    );
  });
}

// -----------------------------------------------------------------------------
// Interface
// -----------------------------------------------------------------------------

var map = ui.Map();
map.setOptions('HYBRID');
map.setControlVisibility({
  all: true,
  drawingToolsControl: false
});

var title = ui.Label({
  value: 'Exported water-dynamics visualizer v1.0.0',
  style: {fontSize: '18px', fontWeight: 'bold', margin: '0 0 8px 0'}
});

var sourceTypeSelect = ui.Select({
  items: [SOURCE_IMAGE, SOURCE_COLLECTION_FIRST],
  value: SOURCE_IMAGE,
  style: {stretch: 'horizontal'}
});

var assetBox = ui.Textbox({
  value: DEFAULT_IMAGE_ASSET,
  style: {stretch: 'horizontal'}
});

var loadButton = ui.Button({
  label: 'Load exported image',
  onClick: loadExportedImage,
  style: {stretch: 'horizontal'}
});

var bandSelect = ui.Select({
  items: [],
  disabled: true,
  placeholder: 'Load an image first',
  style: {stretch: 'horizontal'},
  onChange: selectBand
});

var keepVisibleCheckbox = ui.Checkbox({
  label: 'Keep previously enabled bands visible',
  value: false
});

var timingPaletteSelect = ui.Select({
  items: [TIMING_SPLIT, TIMING_MULTIHUE, TIMING_VIRIDIS],
  value: TIMING_SPLIT,
  style: {stretch: 'horizontal'},
  onChange: refreshLayerStyles
});

var periodDaysBox = ui.Textbox({
  value: '365',
  style: {width: '90px'},
  onChange: refreshLayerStyles
});

var genericMinBox = ui.Textbox({
  value: '0',
  style: {width: '75px'},
  onChange: refreshLayerStyles
});

var genericMaxBox = ui.Textbox({
  value: '1',
  style: {width: '75px'},
  onChange: refreshLayerStyles
});

var statusLabel = ui.Label({
  value: 'Ready. The default field contains the first exported test image.',
  style: {fontSize: '11px', color: '#1B5E20', whiteSpace: 'normal'}
});

var metadataLabel = ui.Label({
  value: 'Metadata will appear after loading.',
  style: {
    fontSize: '10px',
    color: '#555555',
    whiteSpace: 'pre-wrap',
    margin: '5px 0'
  }
});

var legendPanel = ui.Panel({
  style: {
    stretch: 'horizontal',
    margin: '5px 0 0 0',
    padding: '6px',
    backgroundColor: '#F7F7F7'
  }
});
legendPanel.add(ui.Label('Load an image and select a band.'));

var controls = ui.Panel({
  style: {
    width: '370px',
    padding: '10px'
  }
});

controls.add(title);
controls.add(ui.Label({
  value: 'Loads every band found in an exported multiband image and assigns the corresponding annual-dynamics colour ramp automatically.',
  style: {fontSize: '11px', color: '#444444', whiteSpace: 'normal'}
}));
controls.add(ui.Label('Source type', {fontWeight: 'bold', margin: '10px 0 2px 0'}));
controls.add(sourceTypeSelect);
controls.add(ui.Label('Full Earth Engine asset ID', {fontWeight: 'bold', margin: '8px 0 2px 0'}));
controls.add(assetBox);
controls.add(loadButton);
controls.add(statusLabel);
controls.add(metadataLabel);

controls.add(ui.Label('Band to display', {fontWeight: 'bold', margin: '10px 0 2px 0'}));
controls.add(bandSelect);
controls.add(keepVisibleCheckbox);

controls.add(ui.Label('Timing colour scheme', {fontWeight: 'bold', margin: '10px 0 2px 0'}));
controls.add(timingPaletteSelect);
controls.add(ui.Panel({
  widgets: [
    ui.Label('Analysis-period days:', {margin: '5px 6px 0 0'}),
    periodDaysBox
  ],
  layout: ui.Panel.Layout.flow('horizontal')
}));
controls.add(ui.Label({
  value: 'The period length is read from image metadata when available. It controls timing-layer stretches only.',
  style: {fontSize: '10px', color: '#555555', whiteSpace: 'normal'}
}));

controls.add(ui.Label('Fallback for unfamiliar future bands', {
  fontWeight: 'bold',
  margin: '10px 0 2px 0'
}));
controls.add(ui.Panel({
  widgets: [
    ui.Label('Min', {margin: '5px 4px 0 0'}),
    genericMinBox,
    ui.Label('Max', {margin: '5px 4px 0 10px'}),
    genericMaxBox
  ],
  layout: ui.Panel.Layout.flow('horizontal')
}));

controls.add(ui.Label('Legend', {fontWeight: 'bold', margin: '10px 0 2px 0'}));
controls.add(legendPanel);

ui.root.clear();
ui.root.setLayout(ui.Panel.Layout.flow('horizontal'));
ui.root.add(controls);
ui.root.add(map);

// Load the supplied test image immediately. The Load button remains available
// for another image asset or for the first image of an ImageCollection.
loadExportedImage();
