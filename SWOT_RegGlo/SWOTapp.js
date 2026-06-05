
/***************************************************************
 * SWOT WSE + CHIRPS APP-STYLE TEMPORAL EXPLORER
 * -------------------------------------------------------------
 *
 * Purpose:
 *   This Google Earth Engine JavaScript script behaves like a
 *   simple app. The user selects options from a left-side control
 *   panel and clicks "Run / refresh analysis". Then, when the user
 *   clicks any pixel on the map, the app plots the results in a
 *   separate right-side chart panel:
 *
 *     1. CHIRPS v3 precipitation for that location
 *     2. SWOT WSE for that location
 *
 *   The plots can be shown:
 *     - separately
 *     - or together in one combined dual-axis plot
 *
 * Input SWOT ImageCollection:
 *   projects/hardy-tenure-383607/assets/WaterSurface/SWOT_HR100m
 *
 * IMPORTANT SWOT BAND MAPPING:
 *   b1 = WSE
 *   b2 = wse_qual
 *
 * Official SWOT wse_qual coding:
 *   0 = nominal
 *   1 = suspect
 *   2 = degraded
 *   3 = bad
 *
 * CHIRPS sources:
 *   UCSB-CHC/CHIRPS/V3/PENTAD
 *   UCSB-CHC/CHIRPS/V3/DAILY_SAT
 *
 * Notes on precipitation aggregation:
 *   - MONTHLY_PENTAD mode computes monthly totals from the
 *     CHIRPS v3 PENTAD collection. This is the default and is
 *     faster than monthly aggregation from daily images.
 *   - DAILY mode uses CHIRPS v3 DAILY_SAT values directly.
 *   - PENTAD mode uses CHIRPS v3 PENTAD values directly.
 *   - MONTHLY_DAILY mode is retained for comparison/testing.
 *   - A precomputed CHIRPS v3 monthly ImageCollection was not
 *     found in the Earth Engine Data Catalog at the time this
 *     script was prepared.
 *
 * Default app settings:
 *   - JRC max extent mask: OFF
 *   - wse_qual mask: ON
 *   - quality mode: EQ
 *   - quality EQ value: 0
 *   - precipitation aggregation: MONTHLY_PENTAD
 *   - profile plot mode: SEPARATE
 *
 * Version:
 *   SWOT_WSE_CHIRPS_AppStyle_Profile_v7_PentadMonthly_RightPanel
 ***************************************************************/


/****************************************************************
 * 0. INPUT DATASETS AND CONSTANTS
 ****************************************************************/

var SWOT_COLLECTION_ASSET =
  'projects/hardy-tenure-383607/assets/WaterSurface/SWOT_HR100m';

var INPUT_WSE_BAND = 'b1';
var INPUT_QUAL_BAND = 'b2';

var JRC_GSW_ASSET = 'JRC/GSW1_4/GlobalSurfaceWater';

var CHIRPS_DAILY_COLLECTION_ASSET = 'UCSB-CHC/CHIRPS/V3/DAILY_SAT';
var CHIRPS_PENTAD_COLLECTION_ASSET = 'UCSB-CHC/CHIRPS/V3/PENTAD';
var CHIRPS_PRECIP_BAND = 'precipitation';


//--------------------------------------------------------------
// Sampling scales
//--------------------------------------------------------------
var SWOT_PROFILE_SCALE_METERS = 100;
var CHIRPS_PROFILE_SCALE_METERS = 5566;


//--------------------------------------------------------------
// Default time range
//--------------------------------------------------------------
var DEFAULT_START_DATE = '2022-01-01';
var DEFAULT_END_DATE = '2025-12-31';


//--------------------------------------------------------------
// Map defaults
//--------------------------------------------------------------
Map.setOptions('SATELLITE');
Map.setCenter(20, 2, 3);


/****************************************************************
 * 1. VISUALIZATION PARAMETERS
 ****************************************************************/

var WSE_VIS = {
  min: 0,
  max: 2000,
  palette: [
    '081d58',
    '225ea8',
    '41b6c4',
    'a1dab4',
    'ffffcc',
    'fecc5c',
    'fd8d3c',
    'e31a1c'
  ]
};

var WSE_STDDEV_VIS = {
  min: 0,
  max: 10,
  palette: [
    'ffffff',
    'd9f0a3',
    'addd8e',
    '78c679',
    '41ab5d',
    '238443',
    '005a32'
  ]
};

var WSE_RANGE_VIS = {
  min: 0,
  max: 25,
  palette: [
    'ffffff',
    'fee8c8',
    'fdbb84',
    'fc8d59',
    'e34a33',
    'b30000'
  ]
};

var WSE_COUNT_VIS = {
  min: 0,
  max: 50,
  palette: [
    'ffffff',
    'deebf7',
    '9ecae1',
    '4292c6',
    '08519c'
  ]
};

var QUAL_VIS = {
  min: 0,
  max: 3,
  palette: [
    '1a9850',
    'fee08b',
    'f46d43',
    'd73027'
  ]
};


/****************************************************************
 * 2. LOAD STATIC DATA
 ****************************************************************/

var swotRawAll = ee.ImageCollection(SWOT_COLLECTION_ASSET)
  .filter(ee.Filter.notNull(['system:time_start']));

var jrcMaxExtent = ee.Image(JRC_GSW_ASSET)
  .select('max_extent')
  .eq(1)
  .selfMask()
  .rename('jrc_max_extent');

var chirpsDailyAll = ee.ImageCollection(CHIRPS_DAILY_COLLECTION_ASSET)
  .select(CHIRPS_PRECIP_BAND);

var chirpsPentadAll = ee.ImageCollection(CHIRPS_PENTAD_COLLECTION_ASSET)
  .select(CHIRPS_PRECIP_BAND);

print('Raw SWOT collection:', swotRawAll);
print('Number of dated SWOT images:', swotRawAll.size());
print('First raw SWOT image:', swotRawAll.first());
print('SWOT band names:', ee.Image(swotRawAll.first()).bandNames());
print('CHIRPS v3 daily collection:', chirpsDailyAll);
print('CHIRPS daily first image:', chirpsDailyAll.first());
print('CHIRPS v3 pentad collection:', chirpsPentadAll);
print('CHIRPS pentad first image:', chirpsPentadAll.first());


/****************************************************************
 * 3. GLOBAL APP STATE
 ****************************************************************/

var currentSwotPrepared = null;
var currentChirpsProfileCollection = null;
var currentPrecipAggregation = 'MONTHLY_PENTAD';
var currentProfilePlotMode = 'SEPARATE';
var currentPrecipUnits = 'mm/month';
var currentStartDateText = DEFAULT_START_DATE;
var currentEndDateText = DEFAULT_END_DATE;
var currentClickedPointLayer = null;


/****************************************************************
 * 4. LEFT-SIDE APP PANEL
 ****************************************************************/

var appPanel = ui.Panel({
  style: {
    position: 'top-left',
    width: '360px',
    maxHeight: '95%',
    padding: '8px'
  }
});

var titleLabel = ui.Label({
  value: 'SWOT WSE + CHIRPS explorer',
  style: {
    fontWeight: 'bold',
    fontSize: '16px',
    margin: '0 0 6px 0'
  }
});

var descriptionLabel = ui.Label({
  value:
    'Select options, click "Run / refresh analysis", then click the map. The charts will appear in the right-side panel.',
  style: {
    fontSize: '11px',
    color: '444444',
    margin: '0 0 8px 0'
  }
});


//--------------------------------------------------------------
// Time range controls
//--------------------------------------------------------------

var timeLabel = ui.Label({
  value: '1. Time range',
  style: {
    fontWeight: 'bold',
    fontSize: '13px',
    margin: '8px 0 4px 0'
  }
});

var startDateBox = ui.Textbox({
  placeholder: 'YYYY-MM-DD',
  value: DEFAULT_START_DATE,
  style: {
    width: '150px'
  }
});

var endDateBox = ui.Textbox({
  placeholder: 'YYYY-MM-DD',
  value: DEFAULT_END_DATE,
  style: {
    width: '150px'
  }
});

var dateRow = ui.Panel({
  widgets: [
    ui.Label({
      value: 'Start:',
      style: {width: '45px', fontSize: '11px'}
    }),
    startDateBox,
    ui.Label({
      value: 'End:',
      style: {width: '35px', fontSize: '11px', margin: '0 0 0 6px'}
    }),
    endDateBox
  ],
  layout: ui.Panel.Layout.flow('horizontal')
});


//--------------------------------------------------------------
// Mask controls
//--------------------------------------------------------------

var maskLabel = ui.Label({
  value: '2. SWOT masking',
  style: {
    fontWeight: 'bold',
    fontSize: '13px',
    margin: '10px 0 4px 0'
  }
});

var applyJrcCheckbox = ui.Checkbox({
  label: 'Apply JRC maximum water extent mask',
  value: false
});

var applyQualCheckbox = ui.Checkbox({
  label: 'Apply SWOT wse_qual mask',
  value: true
});

var qualModeSelect = ui.Select({
  items: ['EQ', 'LTE', 'LIST'],
  value: 'EQ',
  style: {
    width: '90px'
  }
});

var qualEqBox = ui.Textbox({
  placeholder: '0',
  value: '0',
  style: {
    width: '55px'
  }
});

var qualMaxBox = ui.Textbox({
  placeholder: '1',
  value: '1',
  style: {
    width: '55px'
  }
});

var qualListBox = ui.Textbox({
  placeholder: '0,1',
  value: '0,1',
  style: {
    width: '80px'
  }
});

var qualRow = ui.Panel({
  widgets: [
    ui.Label({
      value: 'Mode:',
      style: {width: '45px', fontSize: '11px'}
    }),
    qualModeSelect,
    ui.Label({
      value: 'EQ:',
      style: {width: '28px', fontSize: '11px', margin: '0 0 0 6px'}
    }),
    qualEqBox,
    ui.Label({
      value: 'LTE:',
      style: {width: '32px', fontSize: '11px', margin: '0 0 0 6px'}
    }),
    qualMaxBox
  ],
  layout: ui.Panel.Layout.flow('horizontal')
});

var qualListRow = ui.Panel({
  widgets: [
    ui.Label({
      value: 'LIST values:',
      style: {width: '75px', fontSize: '11px'}
    }),
    qualListBox
  ],
  layout: ui.Panel.Layout.flow('horizontal')
});

var qualHelpLabel = ui.Label({
  value:
    'Quality codes: 0 nominal, 1 suspect, 2 degraded, 3 bad. Default keeps only b2 == 0.',
  style: {
    fontSize: '10px',
    color: '666666',
    margin: '2px 0 0 0'
  }
});


//--------------------------------------------------------------
// Optional numeric WSE range mask
//--------------------------------------------------------------

var applyWseRangeCheckbox = ui.Checkbox({
  label: 'Apply optional numeric WSE range mask',
  value: false
});

var wseMinBox = ui.Textbox({
  placeholder: '-500',
  value: '-500',
  style: {
    width: '80px'
  }
});

var wseMaxBox = ui.Textbox({
  placeholder: '9000',
  value: '9000',
  style: {
    width: '80px'
  }
});

var wseRangeRow = ui.Panel({
  widgets: [
    ui.Label({
      value: 'Min:',
      style: {width: '35px', fontSize: '11px'}
    }),
    wseMinBox,
    ui.Label({
      value: 'Max:',
      style: {width: '35px', fontSize: '11px', margin: '0 0 0 6px'}
    }),
    wseMaxBox
  ],
  layout: ui.Panel.Layout.flow('horizontal')
});


//--------------------------------------------------------------
// Precipitation and profile controls
//--------------------------------------------------------------

var profileLabel = ui.Label({
  value: '3. Click-profile plots',
  style: {
    fontWeight: 'bold',
    fontSize: '13px',
    margin: '10px 0 4px 0'
  }
});

var precipAggregationSelect = ui.Select({
  items: [
    {
      label: 'Monthly total from CHIRPS v3 pentad - faster',
      value: 'MONTHLY_PENTAD'
    },
    {
      label: 'Pentad precipitation',
      value: 'PENTAD'
    },
    {
      label: 'Daily precipitation from CHIRPS v3 daily SAT',
      value: 'DAILY'
    },
    {
      label: 'Monthly total from CHIRPS v3 daily SAT - slower',
      value: 'MONTHLY_DAILY'
    }
  ],
  value: 'MONTHLY_PENTAD',
  style: {
    width: '295px'
  }
});

var profilePlotModeSelect = ui.Select({
  items: [
    {
      label: 'Separate plots',
      value: 'SEPARATE'
    },
    {
      label: 'Combined dual-axis plot',
      value: 'COMBINED'
    }
  ],
  value: 'SEPARATE',
  style: {
    width: '220px'
  }
});

var profileHelpLabel = ui.Label({
  value:
    'Default monthly precipitation is computed from CHIRPS v3 pentad totals, which is faster than summing daily images.',
  style: {
    fontSize: '10px',
    color: '666666',
    margin: '2px 0 0 0'
  }
});


//--------------------------------------------------------------
// Map layer controls
//--------------------------------------------------------------

var layerLabel = ui.Label({
  value: '4. Map layers',
  style: {
    fontWeight: 'bold',
    fontSize: '13px',
    margin: '10px 0 4px 0'
  }
});

var showOverallCheckbox = ui.Checkbox({
  label: 'Show overall summary layers',
  value: true
});

var showAnnualMeanCheckbox = ui.Checkbox({
  label: 'Show annual mean WSE layers',
  value: true
});

var showAnnualStdCheckbox = ui.Checkbox({
  label: 'Show annual stdDev/range/count layers',
  value: false
});

var showJrcCheckbox = ui.Checkbox({
  label: 'Show JRC maximum extent layer',
  value: false
});


//--------------------------------------------------------------
// Run button and status
//--------------------------------------------------------------

var runButton = ui.Button({
  label: 'Run / refresh analysis',
  style: {
    stretch: 'horizontal',
    margin: '10px 0 4px 0'
  }
});

var statusLabel = ui.Label({
  value: 'Ready. Select options and run the analysis.',
  style: {
    fontSize: '11px',
    color: '555555',
    margin: '4px 0 0 0'
  }
});


//--------------------------------------------------------------
// Right-side profile chart panel
//--------------------------------------------------------------

var chartPanel = ui.Panel({
  style: {
    position: 'top-right',
    width: '560px',
    maxHeight: '95%',
    padding: '8px'
  }
});

var chartPanelTitle = ui.Label({
  value: 'Click-profile output',
  style: {
    fontWeight: 'bold',
    fontSize: '16px',
    margin: '0 0 6px 0'
  }
});

var chartPanelHelp = ui.Label({
  value:
    'After running the analysis, click a pixel on the map to create the precipitation and WSE charts here.',
  style: {
    fontSize: '11px',
    color: '555555',
    margin: '0 0 8px 0'
  }
});

var profileOutputPanel = ui.Panel({
  style: {
    stretch: 'horizontal',
    maxHeight: '850px'
  }
});

profileOutputPanel.add(ui.Label({
  value: 'No point selected yet.',
  style: {
    fontSize: '11px',
    color: '777777'
  }
}));

chartPanel.add(chartPanelTitle);
chartPanel.add(chartPanelHelp);
chartPanel.add(profileOutputPanel);


//--------------------------------------------------------------
// Assemble panel
//--------------------------------------------------------------

appPanel.add(titleLabel);
appPanel.add(descriptionLabel);

appPanel.add(timeLabel);
appPanel.add(dateRow);

appPanel.add(maskLabel);
appPanel.add(applyJrcCheckbox);
appPanel.add(applyQualCheckbox);
appPanel.add(qualRow);
appPanel.add(qualListRow);
appPanel.add(qualHelpLabel);
appPanel.add(applyWseRangeCheckbox);
appPanel.add(wseRangeRow);

appPanel.add(profileLabel);
appPanel.add(ui.Label({
  value: 'Precipitation aggregation:',
  style: {fontSize: '11px', margin: '2px 0 2px 0'}
}));
appPanel.add(precipAggregationSelect);
appPanel.add(ui.Label({
  value: 'Profile display mode:',
  style: {fontSize: '11px', margin: '6px 0 2px 0'}
}));
appPanel.add(profilePlotModeSelect);
appPanel.add(profileHelpLabel);

appPanel.add(layerLabel);
appPanel.add(showOverallCheckbox);
appPanel.add(showAnnualMeanCheckbox);
appPanel.add(showAnnualStdCheckbox);
appPanel.add(showJrcCheckbox);

appPanel.add(runButton);
appPanel.add(statusLabel);

Map.add(appPanel);
Map.add(chartPanel);


/****************************************************************
 * 5. HELPER FUNCTIONS
 ****************************************************************/

function parseNumberFromTextbox(textbox, fallbackValue) {

  var parsed = Number(textbox.getValue());

  if (isNaN(parsed)) {
    return fallbackValue;
  }

  return parsed;
}


function parseQualityList(text) {

  var parts = text.split(',');
  var values = [];

  parts.forEach(function(part) {

    var value = Number(part.trim());

    if (!isNaN(value)) {
      values.push(value);
    }
  });

  if (values.length === 0) {
    values = [0];
  }

  return values;
}


function buildWseQualityMask(qualImage, mode, eqValue, maxValue, listValues) {

  var qualMask;

  if (mode === 'LTE') {

    qualMask = qualImage.lte(maxValue);

  } else if (mode === 'EQ') {

    qualMask = qualImage.eq(eqValue);

  } else if (mode === 'LIST') {

    qualMask = ee.Image(0);

    listValues.forEach(function(value) {
      qualMask = qualMask.or(qualImage.eq(value));
    });

  } else {

    qualMask = ee.Image(1);
  }

  return qualMask.rename('wse_qual_mask');
}


function buildWseRangeMask(wseImage, minValue, maxValue) {

  return wseImage
    .gte(minValue)
    .and(wseImage.lte(maxValue))
    .rename('wse_value_range_mask');
}


function addWseRangeBand(summaryImage) {

  summaryImage = ee.Image(summaryImage);

  var wseRange = summaryImage
    .select('wse_max')
    .subtract(summaryImage.select('wse_min'))
    .rename('wse_range');

  return summaryImage.addBands(wseRange);
}


var WSE_SUMMARY_REDUCER = ee.Reducer.mean()
  .combine({
    reducer2: ee.Reducer.median(),
    sharedInputs: true
  })
  .combine({
    reducer2: ee.Reducer.stdDev(),
    sharedInputs: true
  })
  .combine({
    reducer2: ee.Reducer.minMax(),
    sharedInputs: true
  })
  .combine({
    reducer2: ee.Reducer.count(),
    sharedInputs: true
  });


function buildMonthlyPrecipFromPentad(pentadCollection, startDate, endDate) {

  startDate = ee.Date(startDate);
  endDate = ee.Date(endDate);

  var startMonth = ee.Date.fromYMD(
    startDate.get('year'),
    startDate.get('month'),
    1
  );

  var endMonth = ee.Date.fromYMD(
    endDate.get('year'),
    endDate.get('month'),
    1
  );

  var nMonths = endMonth.difference(startMonth, 'month').add(1);

  var monthOffsets = ee.List.sequence(0, nMonths.subtract(1));

  var monthlyImages = monthOffsets.map(function(offset) {

    offset = ee.Number(offset);

    var monthStart = startMonth.advance(offset, 'month');
    var monthEnd = monthStart.advance(1, 'month');

    /*
      The pentadCollection has already been filtered to the selected
      date range. Therefore, first and last months may be partial if
      the selected date range starts or ends mid-month.

      CHIRPS v3 PENTAD precipitation units are mm/pentad.
      Summing the pentads in a month gives mm/month.
    */

    var monthlyTotal = pentadCollection
      .filterDate(monthStart, monthEnd)
      .sum()
      .rename(CHIRPS_PRECIP_BAND);

    return monthlyTotal
      .set('system:time_start', monthStart.millis())
      .set('year', monthStart.get('year'))
      .set('month', monthStart.get('month'))
      .set('aggregation', 'monthly_total_from_pentad');
  });

  return ee.ImageCollection.fromImages(monthlyImages);
}


function buildMonthlyPrecipFromDaily(dailyCollection, startDate, endDate) {

  startDate = ee.Date(startDate);
  endDate = ee.Date(endDate);

  var startMonth = ee.Date.fromYMD(
    startDate.get('year'),
    startDate.get('month'),
    1
  );

  var endMonth = ee.Date.fromYMD(
    endDate.get('year'),
    endDate.get('month'),
    1
  );

  var nMonths = endMonth.difference(startMonth, 'month').add(1);

  var monthOffsets = ee.List.sequence(0, nMonths.subtract(1));

  var monthlyImages = monthOffsets.map(function(offset) {

    offset = ee.Number(offset);

    var monthStart = startMonth.advance(offset, 'month');
    var monthEnd = monthStart.advance(1, 'month');

    /*
      The dailyCollection has already been filtered to the selected
      date range. Therefore, first and last months are partial if
      the selected date range starts or ends mid-month.
    */

    var monthlyTotal = dailyCollection
      .filterDate(monthStart, monthEnd)
      .sum()
      .rename(CHIRPS_PRECIP_BAND);

    return monthlyTotal
      .set('system:time_start', monthStart.millis())
      .set('year', monthStart.get('year'))
      .set('month', monthStart.get('month'))
      .set('aggregation', 'monthly_total');
  });

  return ee.ImageCollection.fromImages(monthlyImages);
}


function getDateRangeFromUI() {

  var startText = startDateBox.getValue();
  var endText = endDateBox.getValue();

  currentStartDateText = startText;
  currentEndDateText = endText;

  return {
    startText: startText,
    endText: endText,
    startDate: ee.Date(startText),
    endDate: ee.Date(endText),
    endExclusive: ee.Date(endText).advance(1, 'day')
  };
}


function prepareSwotCollectionForCurrentSettings(swotCollection) {

  var applyJrc = applyJrcCheckbox.getValue();
  var applyQual = applyQualCheckbox.getValue();
  var qualMode = qualModeSelect.getValue();

  var qualEqValue = parseNumberFromTextbox(qualEqBox, 0);
  var qualMaxValue = parseNumberFromTextbox(qualMaxBox, 1);
  var qualListValues = parseQualityList(qualListBox.getValue());

  var applyWseRange = applyWseRangeCheckbox.getValue();
  var wseMin = parseNumberFromTextbox(wseMinBox, -500);
  var wseMax = parseNumberFromTextbox(wseMaxBox, 9000);


  function prepareOneImage(image) {

    image = ee.Image(image);

    var wse = image
      .select(INPUT_WSE_BAND)
      .rename('wse');

    var wseQual = image
      .select(INPUT_QUAL_BAND)
      .rename('wse_qual');

    if (applyJrc) {
      wse = wse.updateMask(jrcMaxExtent);
      wseQual = wseQual.updateMask(jrcMaxExtent);
    }

    if (applyQual) {

      var qualMask = buildWseQualityMask(
        wseQual,
        qualMode,
        qualEqValue,
        qualMaxValue,
        qualListValues
      );

      wse = wse.updateMask(qualMask);
    }

    if (applyWseRange) {

      var wseRangeMask = buildWseRangeMask(
        wse,
        wseMin,
        wseMax
      );

      wse = wse.updateMask(wseRangeMask);
    }

    var date = ee.Date(image.get('system:time_start'));

    return wse
      .addBands(wseQual)
      .copyProperties(image, image.propertyNames())
      .set('year', date.get('year'))
      .set('month', date.get('month'))
      .set('year_month', date.format('YYYY-MM'));
  }

  return swotCollection.map(prepareOneImage);
}


function buildPrecipCollectionForCurrentSettings(dateRange) {

  currentPrecipAggregation = precipAggregationSelect.getValue();

  var dailyFiltered = chirpsDailyAll.filterDate(
    dateRange.startDate,
    dateRange.endExclusive
  );

  var pentadFiltered = chirpsPentadAll.filterDate(
    dateRange.startDate,
    dateRange.endExclusive
  );

  if (currentPrecipAggregation === 'MONTHLY_PENTAD') {

    currentPrecipUnits = 'mm/month';

    return buildMonthlyPrecipFromPentad(
      pentadFiltered,
      dateRange.startDate,
      dateRange.endDate
    );

  } else if (currentPrecipAggregation === 'MONTHLY_DAILY') {

    currentPrecipUnits = 'mm/month';

    return buildMonthlyPrecipFromDaily(
      dailyFiltered,
      dateRange.startDate,
      dateRange.endDate
    );

  } else if (currentPrecipAggregation === 'PENTAD') {

    currentPrecipUnits = 'mm/pentad';

    return pentadFiltered;

  } else {

    currentPrecipUnits = 'mm/day';

    return dailyFiltered;
  }
}


function buildAnnualWseSummaries(swotPrepared) {

  var availableYears = ee.List(
    swotPrepared.aggregate_array('year')
  ).distinct().sort();

  return ee.ImageCollection.fromImages(
    availableYears.map(function(year) {

      year = ee.Number(year);

      var annualCollection = swotPrepared
        .filter(ee.Filter.eq('year', year))
        .select('wse');

      var annualSummary = annualCollection.reduce(WSE_SUMMARY_REDUCER);
      annualSummary = addWseRangeBand(annualSummary);

      return annualSummary
        .set('year', year)
        .set('n_source_images', annualCollection.size())
        .set('system:time_start',
             ee.Date.fromYMD(year, 1, 1).millis());
    })
  );
}


function addMapLayers(swotPrepared, annualSummaries) {

  if (showJrcCheckbox.getValue()) {
    Map.addLayer(
      jrcMaxExtent,
      {palette: ['00ffff']},
      'JRC maximum water extent',
      false
    );
  }

  if (showOverallCheckbox.getValue()) {

    var overallWseSummary = swotPrepared
      .select('wse')
      .reduce(WSE_SUMMARY_REDUCER);

    overallWseSummary = addWseRangeBand(overallWseSummary);

    Map.addLayer(
      overallWseSummary.select('wse_mean'),
      WSE_VIS,
      'Overall mean masked SWOT WSE',
      true
    );

    Map.addLayer(
      overallWseSummary.select('wse_stdDev'),
      WSE_STDDEV_VIS,
      'Overall WSE standard deviation',
      false
    );

    Map.addLayer(
      overallWseSummary.select('wse_range'),
      WSE_RANGE_VIS,
      'Overall WSE range',
      false
    );

    Map.addLayer(
      overallWseSummary.select('wse_count'),
      WSE_COUNT_VIS,
      'Overall valid WSE observation count',
      false
    );
  }

  if (showAnnualMeanCheckbox.getValue()) {

    var availableYears = ee.List(
      swotPrepared.aggregate_array('year')
    ).distinct().sort();

    availableYears.evaluate(function(yearList) {

      yearList.forEach(function(year) {

        var annualImage = ee.Image(
          annualSummaries
            .filter(ee.Filter.eq('year', year))
            .first()
        );

        Map.addLayer(
          annualImage.select('wse_mean'),
          WSE_VIS,
          'Annual mean WSE - ' + year,
          false
        );
      });
    });
  }

  if (showAnnualStdCheckbox.getValue()) {

    var availableYears2 = ee.List(
      swotPrepared.aggregate_array('year')
    ).distinct().sort();

    availableYears2.evaluate(function(yearList) {

      yearList.forEach(function(year) {

        var annualImage = ee.Image(
          annualSummaries
            .filter(ee.Filter.eq('year', year))
            .first()
        );

        Map.addLayer(
          annualImage.select('wse_stdDev'),
          WSE_STDDEV_VIS,
          'Annual WSE stdDev - ' + year,
          false
        );

        Map.addLayer(
          annualImage.select('wse_range'),
          WSE_RANGE_VIS,
          'Annual WSE range - ' + year,
          false
        );

        Map.addLayer(
          annualImage.select('wse_count'),
          WSE_COUNT_VIS,
          'Annual valid WSE count - ' + year,
          false
        );
      });
    });
  }
}


function resetClickedPointLayer() {

  currentClickedPointLayer = ui.Map.Layer(
    ee.FeatureCollection([]),
    {color: 'ff0000'},
    'Clicked profile point'
  );

  Map.layers().add(currentClickedPointLayer);
}


function updateClickedPointLayer(point, lon, lat) {

  if (currentClickedPointLayer === null) {
    resetClickedPointLayer();
  }

  currentClickedPointLayer.setEeObject(
    ee.FeatureCollection([
      ee.Feature(point, {
        longitude: lon,
        latitude: lat
      })
    ])
  );
}


function buildCombinedProfileCollection(precipCollection, swotPrepared) {

  function emptyWseBand() {
    return ee.Image.constant(0)
      .rename('wse')
      .updateMask(ee.Image.constant(0));
  }

  function emptyPrecipBand() {
    return ee.Image.constant(0)
      .rename('precipitation')
      .updateMask(ee.Image.constant(0));
  }

  var precipImages = precipCollection.map(function(image) {

    image = ee.Image(image);

    var precip = image
      .select(CHIRPS_PRECIP_BAND)
      .rename('precipitation');

    return precip
      .addBands(emptyWseBand())
      .copyProperties(image, ['system:time_start']);
  });

  var wseImages = swotPrepared.map(function(image) {

    image = ee.Image(image);

    var wse = image
      .select('wse')
      .rename('wse');

    return emptyPrecipBand()
      .addBands(wse)
      .copyProperties(image, ['system:time_start']);
  });

  return precipImages
    .merge(wseImages)
    .sort('system:time_start');
}


/****************************************************************
 * 6. MAIN RUN FUNCTION
 ****************************************************************/

function runAnalysis() {

  statusLabel.setValue('Running analysis with selected settings...');

  profileOutputPanel.clear();
  profileOutputPanel.add(ui.Label({
    value: 'Analysis refreshed. Click the map to create the temporal profile in this right-side panel.',
    style: {
      fontSize: '11px',
      color: '555555'
    }
  }));

  currentProfilePlotMode = profilePlotModeSelect.getValue();

  var dateRange = getDateRangeFromUI();

  var swotFiltered = swotRawAll.filterDate(
    dateRange.startDate,
    dateRange.endExclusive
  );

  currentSwotPrepared = prepareSwotCollectionForCurrentSettings(
    swotFiltered
  );

  currentChirpsProfileCollection = buildPrecipCollectionForCurrentSettings(
    dateRange
  );

  var annualSummaries = buildAnnualWseSummaries(currentSwotPrepared);

  Map.layers().reset([]);
  addMapLayers(currentSwotPrepared, annualSummaries);
  resetClickedPointLayer();

  print('------------------------------------------------------');
  print('APP RUN SETTINGS');
  print('------------------------------------------------------');
  print('Start date:', currentStartDateText);
  print('End date:', currentEndDateText);
  print('Apply JRC mask:', applyJrcCheckbox.getValue());
  print('Apply wse_qual mask:', applyQualCheckbox.getValue());
  print('Quality mode:', qualModeSelect.getValue());
  print('Quality EQ value:', qualEqBox.getValue());
  print('Quality LTE max:', qualMaxBox.getValue());
  print('Quality LIST values:', qualListBox.getValue());
  print('Apply WSE range mask:', applyWseRangeCheckbox.getValue());
  print('Precipitation aggregation:', currentPrecipAggregation);
  print('CHIRPS daily source:', CHIRPS_DAILY_COLLECTION_ASSET);
  print('CHIRPS pentad source:', CHIRPS_PENTAD_COLLECTION_ASSET);
  print('Profile plot mode:', currentProfilePlotMode);
  print('Filtered SWOT collection:', currentSwotPrepared);
  print('Filtered/prepared SWOT image count:', currentSwotPrepared.size());
  print('Precipitation profile collection:', currentChirpsProfileCollection);
  print('Precipitation image count:', currentChirpsProfileCollection.size());
  print('Annual WSE summaries:', annualSummaries);

  statusLabel.setValue(
    'Analysis ready. Click the map to plot profiles. ' +
    'SWOT dates: ' + currentStartDateText + ' to ' + currentEndDateText +
    '. Precipitation: ' + currentPrecipAggregation +
    '. Plot mode: ' + currentProfilePlotMode + '.'
  );
}


runButton.onClick(runAnalysis);


/****************************************************************
 * 7. CLICK PROFILE CHARTS
 ****************************************************************/

function buildPrecipChart(region) {

  var chartTitle;

  if (currentPrecipAggregation === 'MONTHLY_PENTAD') {
    chartTitle = 'CHIRPS v3 monthly precipitation total from pentads';
  } else if (currentPrecipAggregation === 'MONTHLY_DAILY') {
    chartTitle = 'CHIRPS v3 monthly precipitation total from daily SAT';
  } else if (currentPrecipAggregation === 'PENTAD') {
    chartTitle = 'CHIRPS v3 pentad precipitation';
  } else {
    chartTitle = 'CHIRPS v3 daily SAT precipitation';
  }

  return ui.Chart.image.series({
      imageCollection: currentChirpsProfileCollection,
      region: region,
      reducer: ee.Reducer.first(),
      scale: CHIRPS_PROFILE_SCALE_METERS,
      xProperty: 'system:time_start'
    })
    .setChartType('ColumnChart')
    .setOptions({
      title: chartTitle,
      hAxis: {
        title: 'Date',
        format: 'YYYY-MM-dd',
        gridlines: {count: 6}
      },
      vAxis: {
        title: 'Precipitation (' + currentPrecipUnits + ')',
        viewWindow: {
          min: 0
        }
      },
      legend: {
        position: 'none'
      },
      explorer: {
        axis: 'horizontal',
        keepInBounds: true
      }
    });
}


function buildWseChart(region) {

  return ui.Chart.image.series({
      imageCollection: currentSwotPrepared.select('wse'),
      region: region,
      reducer: ee.Reducer.first(),
      scale: SWOT_PROFILE_SCALE_METERS,
      xProperty: 'system:time_start'
    })
    .setChartType('ScatterChart')
    .setOptions({
      title: 'Masked SWOT WSE temporal profile',
      hAxis: {
        title: 'SWOT acquisition time',
        format: 'YYYY-MM-dd',
        gridlines: {count: 6}
      },
      vAxis: {
        title: 'WSE from b1'
      },
      pointSize: 4,
      lineWidth: 1,
      legend: {
        position: 'none'
      },
      interpolateNulls: false,
      explorer: {
        axis: 'horizontal',
        keepInBounds: true
      }
    });
}


function buildCombinedChart(region) {

  var combinedCollection = buildCombinedProfileCollection(
    currentChirpsProfileCollection,
    currentSwotPrepared
  );

  return ui.Chart.image.series({
      imageCollection: combinedCollection,
      region: region,
      reducer: ee.Reducer.first(),
      scale: SWOT_PROFILE_SCALE_METERS,
      xProperty: 'system:time_start'
    })
    .setChartType('ComboChart')
    .setOptions({
      title: 'CHIRPS precipitation and masked SWOT WSE',
      hAxis: {
        title: 'Date',
        format: 'YYYY-MM-dd',
        gridlines: {count: 6}
      },
      vAxes: {
        0: {
          title: 'Precipitation (' + currentPrecipUnits + ')',
          viewWindow: {
            min: 0
          }
        },
        1: {
          title: 'WSE from b1'
        }
      },
      series: {
        0: {
          type: 'bars',
          targetAxisIndex: 0
        },
        1: {
          type: 'line',
          pointSize: 4,
          lineWidth: 1,
          targetAxisIndex: 1
        }
      },
      interpolateNulls: false,
      legend: {
        position: 'bottom'
      },
      explorer: {
        axis: 'horizontal',
        keepInBounds: true
      }
    });
}


function updateTemporalProfile(coords) {

  if (currentSwotPrepared === null ||
      currentChirpsProfileCollection === null) {

    profileOutputPanel.clear();
    profileOutputPanel.add(ui.Label({
      value: 'Please run the analysis before clicking the map.',
      style: {
        fontSize: '11px',
        color: 'cc0000'
      }
    }));

    return;
  }

  var lon = coords.lon;
  var lat = coords.lat;
  var point = ee.Geometry.Point([lon, lat]);

  updateClickedPointLayer(point, lon, lat);

  profileOutputPanel.clear();

  profileOutputPanel.add(ui.Label({
    value:
      'Selected point: lon ' +
      lon.toFixed(5) +
      ', lat ' +
      lat.toFixed(5),
    style: {
      fontSize: '11px',
      color: '333333',
      margin: '0 0 4px 0'
    }
  }));

  profileOutputPanel.add(ui.Label({
    value:
      'Date range: ' +
      currentStartDateText +
      ' to ' +
      currentEndDateText +
      ' | Precipitation: ' +
      currentPrecipAggregation +
      ' | Plot mode: ' +
      currentProfilePlotMode,
    style: {
      fontSize: '10px',
      color: '666666',
      margin: '0 0 6px 0'
    }
  }));

  if (currentProfilePlotMode === 'COMBINED') {

    profileOutputPanel.add(buildCombinedChart(point));

  } else {

    profileOutputPanel.add(buildPrecipChart(point));
    profileOutputPanel.add(buildWseChart(point));
  }
}


Map.onClick(updateTemporalProfile);


/****************************************************************
 * 8. INITIAL RUN
 ****************************************************************/

runAnalysis();
