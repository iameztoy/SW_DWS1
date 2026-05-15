/***************************************************************
 * SWOT WSE + JRC MAXIMUM WATER EXTENT MASK
 * -------------------------------------------------------------
 * Exploratory visualization of continental SWOT WSE mosaics
 *
 * Input ImageCollection:
 *   projects/hardy-tenure-383607/assets/WaterSurface/SWOT_HR100m
 *
 * IMPORTANT:
 *   b1 = wse
 *   b2 = wse_qual
 *
 * Official wse_qual coding:
 *   0 = nominal
 *   1 = suspect
 *   2 = degraded
 *   3 = bad
 *
 * Main functionality:
 *   1. Apply JRC Global Surface Water maximum water extent mask
 *   2. Optionally filter WSE pixels according to wse_qual / b2
 *   3. Produce WSE temporal summaries:
 *        - overall mean, median, stdDev, range, count
 *        - annual summaries
 *        - year-month summaries
 *        - calendar-month climatologies across all years
 *
 * Version:
 *   SWOT_WSE_JRCMaxExtent_QualMask_Visualization_v1
 ***************************************************************/


/****************************************************************
 * 0. USER PARAMETERS
 ****************************************************************/

//--------------------------------------------------------------
// SWOT ImageCollection asset
//--------------------------------------------------------------
var SWOT_COLLECTION_ASSET =
  'projects/hardy-tenure-383607/assets/WaterSurface/SWOT_HR100m';


//--------------------------------------------------------------
// Band names in your ingested SWOT collection
//--------------------------------------------------------------
var INPUT_WSE_BAND = 'b1';        // b1 = WSE
var INPUT_QUAL_BAND = 'b2';       // b2 = wse_qual


//--------------------------------------------------------------
// JRC Maximum Water Extent mask
//--------------------------------------------------------------
var APPLY_JRC_MAX_EXTENT_MASK = true;


//--------------------------------------------------------------
// SWOT WSE quality mask
//--------------------------------------------------------------
var APPLY_WSE_QUAL_MASK = true;


/*
  WSE quality filtering options:

  1. 'LTE'
     Keep values equal or lower than a threshold.
     Example:
       WSE_QUAL_FILTER_MODE = 'LTE';
       WSE_QUAL_MAX_VALUE = 1;
     Result:
       Keeps 0 and 1
       0 = nominal
       1 = suspect

  2. 'EQ'
     Keep only one exact quality value.
     Example:
       WSE_QUAL_FILTER_MODE = 'EQ';
       WSE_QUAL_EQUAL_VALUE = 0;
     Result:
       Keeps only nominal pixels.

  3. 'LIST'
     Keep a manually defined list of values.
     Example:
       WSE_QUAL_FILTER_MODE = 'LIST';
       WSE_QUAL_ALLOWED_VALUES = [0, 1];
     Result:
       Keeps nominal and suspect pixels.
*/

var WSE_QUAL_FILTER_MODE = 'LTE';

var WSE_QUAL_MAX_VALUE = 1;            // Used if mode = 'LTE'
var WSE_QUAL_EQUAL_VALUE = 0;          // Used if mode = 'EQ'
var WSE_QUAL_ALLOWED_VALUES = [0, 1];  // Used if mode = 'LIST'


//--------------------------------------------------------------
// Visualization toggles
//--------------------------------------------------------------
var SHOW_JRC_MAX_EXTENT_MASK = false;

var SHOW_FIRST_RAW_SWOT_WSE = false;
var SHOW_FIRST_MASKED_SWOT_WSE = false;
var SHOW_FIRST_SWOT_QUALITY_BAND = false;

var SHOW_OVERALL_SUMMARY_LAYERS = true;

var SHOW_ANNUAL_MEAN_WSE_LAYERS = true;
var SHOW_ANNUAL_STDDEV_LAYERS = false;
var SHOW_ANNUAL_RANGE_LAYERS = false;
var SHOW_ANNUAL_COUNT_LAYERS = false;

var SHOW_YEAR_MONTH_MEAN_LAYERS = false;
var SHOW_CALENDAR_MONTH_MEAN_LAYERS = false;


//--------------------------------------------------------------
// Map configuration
//--------------------------------------------------------------
Map.setOptions('SATELLITE');
Map.setCenter(20, 2, 3);


/****************************************************************
 * 1. VISUALIZATION PARAMETERS
 ****************************************************************/

/*
  Absolute WSE can span a very large range at continental scale.
  You may want to adapt min/max when inspecting specific lakes,
  river systems, or regions.
*/

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
    '1a9850',  // 0 nominal
    'fee08b',  // 1 suspect
    'f46d43',  // 2 degraded
    'd73027'   // 3 bad
  ]
};


/****************************************************************
 * 2. LOAD INPUT DATA
 ****************************************************************/

var swotRaw = ee.ImageCollection(SWOT_COLLECTION_ASSET);

print('------------------------------------------------------');
print('RAW SWOT IMAGE COLLECTION');
print('------------------------------------------------------');
print('Raw SWOT collection:', swotRaw);
print('Number of raw SWOT images:', swotRaw.size());
print('First raw SWOT image:', swotRaw.first());
print('Band names in first raw SWOT image:',
      ee.Image(swotRaw.first()).bandNames());


/****************************************************************
 * 3. LOAD JRC GLOBAL SURFACE WATER MAXIMUM EXTENT
 ****************************************************************/

/*
  JRC/GSW1_4/GlobalSurfaceWater
  max_extent:
    Pixel value = 1 where surface water was detected at least once
    during the JRC observation period.
*/

var jrcGSW = ee.Image('JRC/GSW1_4/GlobalSurfaceWater');

var jrcMaxExtent = jrcGSW
  .select('max_extent')
  .eq(1)
  .selfMask()
  .rename('jrc_max_extent');

if (SHOW_JRC_MAX_EXTENT_MASK) {
  Map.addLayer(
    jrcMaxExtent,
    {palette: ['00ffff']},
    'JRC Maximum Water Extent',
    false
  );
}


/****************************************************************
 * 4. CHECK TEMPORAL METADATA
 ****************************************************************/

/*
  Annual and monthly summaries require system:time_start.
  We retain only images that have this property.
*/

var swotWithDates = swotRaw.filter(
  ee.Filter.notNull(['system:time_start'])
);

print('------------------------------------------------------');
print('TEMPORAL METADATA CHECK');
print('------------------------------------------------------');
print('Images with system:time_start:', swotWithDates.size());
print('Earliest SWOT date:',
      ee.Date(swotWithDates.aggregate_min('system:time_start')));
print('Latest SWOT date:',
      ee.Date(swotWithDates.aggregate_max('system:time_start')));


/****************************************************************
 * 5. QUALITY MASK FUNCTION
 ****************************************************************/

/*
  This function receives the quality band, b2 / wse_qual,
  and returns a Boolean mask according to the chosen mode.
*/

function buildWseQualityMask(qualImage) {

  var qualMask;

  if (WSE_QUAL_FILTER_MODE === 'LTE') {

    // Example: <= 1 keeps quality 0 and 1
    qualMask = qualImage.lte(WSE_QUAL_MAX_VALUE);

  } else if (WSE_QUAL_FILTER_MODE === 'EQ') {

    // Example: == 0 keeps only nominal
    qualMask = qualImage.eq(WSE_QUAL_EQUAL_VALUE);

  } else if (WSE_QUAL_FILTER_MODE === 'LIST') {

    // Example: [0, 1] keeps nominal and suspect
    qualMask = ee.Image(0);

    WSE_QUAL_ALLOWED_VALUES.forEach(function(value) {
      qualMask = qualMask.or(qualImage.eq(value));
    });

  } else {

    // Fallback: no quality filtering
    print('WARNING: Unknown WSE_QUAL_FILTER_MODE. No quality mask applied.');
    qualMask = ee.Image(1);
  }

  return qualMask.rename('wse_qual_mask');
}


/****************************************************************
 * 6. PREPARE SWOT IMAGE COLLECTION
 ****************************************************************/

/*
  For every input SWOT image:
    - b1 is renamed to 'wse'
    - b2 is renamed to 'wse_qual'
    - JRC water mask is optionally applied
    - WSE quality mask is optionally applied to WSE
    - temporal properties are added:
        year
        month
        year_month
*/

function prepareSwotImage(image) {

  image = ee.Image(image);

  // Extract and rename the bands
  var wse = image
    .select(INPUT_WSE_BAND)
    .rename('wse');

  var wseQual = image
    .select(INPUT_QUAL_BAND)
    .rename('wse_qual');

  //------------------------------------------------------------
  // Apply JRC maximum water extent mask
  //------------------------------------------------------------
  if (APPLY_JRC_MAX_EXTENT_MASK) {
    wse = wse.updateMask(jrcMaxExtent);
    wseQual = wseQual.updateMask(jrcMaxExtent);
  }

  //------------------------------------------------------------
  // Apply wse_qual mask to WSE
  //------------------------------------------------------------
  if (APPLY_WSE_QUAL_MASK) {

    var qualityMask = buildWseQualityMask(wseQual);

    // Important:
    // The quality mask is applied to WSE, not to the quality band.
    // This preserves the quality band for diagnostics.
    wse = wse.updateMask(qualityMask);
  }

  //------------------------------------------------------------
  // Temporal properties
  //------------------------------------------------------------
  var date = ee.Date(image.get('system:time_start'));

  var year = date.get('year');
  var month = date.get('month');
  var yearMonth = date.format('YYYY-MM');

  //------------------------------------------------------------
  // Output image
  //------------------------------------------------------------
  return wse
    .addBands(wseQual)
    .copyProperties(image, image.propertyNames())
    .set('year', year)
    .set('month', month)
    .set('year_month', yearMonth);
}


var swotPrepared = swotWithDates.map(prepareSwotImage);

print('------------------------------------------------------');
print('PREPARED SWOT COLLECTION');
print('------------------------------------------------------');
print('Prepared SWOT collection:', swotPrepared);
print('First prepared SWOT image:', swotPrepared.first());
print('Bands in prepared SWOT image:',
      ee.Image(swotPrepared.first()).bandNames());


/****************************************************************
 * 7. OPTIONAL INSPECTION LAYERS
 ****************************************************************/

if (SHOW_FIRST_RAW_SWOT_WSE) {

  var firstRaw = ee.Image(swotWithDates.first());

  Map.addLayer(
    firstRaw.select(INPUT_WSE_BAND),
    WSE_VIS,
    'First raw SWOT WSE - b1',
    false
  );
}


if (SHOW_FIRST_MASKED_SWOT_WSE) {

  var firstPrepared = ee.Image(swotPrepared.first());

  Map.addLayer(
    firstPrepared.select('wse'),
    WSE_VIS,
    'First masked SWOT WSE',
    false
  );
}


if (SHOW_FIRST_SWOT_QUALITY_BAND) {

  var firstPreparedQual = ee.Image(swotPrepared.first());

  Map.addLayer(
    firstPreparedQual.select('wse_qual'),
    QUAL_VIS,
    'First SWOT wse_qual - b2',
    false
  );
}


/****************************************************************
 * 8. AVAILABLE YEARS AND YEAR-MONTHS
 ****************************************************************/

var availableYears = ee.List(
  swotPrepared.aggregate_array('year')
).distinct().sort();

var availableYearMonths = ee.List(
  swotPrepared.aggregate_array('year_month')
).distinct().sort();

print('------------------------------------------------------');
print('AVAILABLE TEMPORAL GROUPS');
print('------------------------------------------------------');
print('Available years:', availableYears);
print('Available year-month combinations:', availableYearMonths);


// Count source images by year
var imageCountByYear = ee.FeatureCollection(
  availableYears.map(function(year) {

    year = ee.Number(year);

    var yearCollection = swotPrepared.filter(
      ee.Filter.eq('year', year)
    );

    return ee.Feature(null, {
      year: year,
      n_source_images: yearCollection.size()
    });
  })
);

print('Number of source SWOT mosaics per year:', imageCountByYear);


/****************************************************************
 * 9. REDUCER FOR WSE TEMPORAL SUMMARIES
 ****************************************************************/

/*
  This reducer will produce:
    wse_mean
    wse_median
    wse_stdDev
    wse_min
    wse_max
    wse_count
*/

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


/*
  Add range:
    wse_range = wse_max - wse_min
*/

function addWseRangeBand(summaryImage) {

  summaryImage = ee.Image(summaryImage);

  var wseRange = summaryImage
    .select('wse_max')
    .subtract(summaryImage.select('wse_min'))
    .rename('wse_range');

  return summaryImage.addBands(wseRange);
}


/****************************************************************
 * 10. OVERALL SUMMARY ACROSS ALL SWOT IMAGES
 ****************************************************************/

var overallWseSummary = swotPrepared
  .select('wse')
  .reduce(WSE_SUMMARY_REDUCER);

overallWseSummary = addWseRangeBand(overallWseSummary);

print('------------------------------------------------------');
print('OVERALL WSE SUMMARY');
print('------------------------------------------------------');
print('Overall WSE summary image:', overallWseSummary);
print('Overall summary bands:', overallWseSummary.bandNames());


/****************************************************************
 * 11. ANNUAL WSE SUMMARIES
 ****************************************************************/

/*
  One image per year.
  Each image contains:
    wse_mean
    wse_median
    wse_stdDev
    wse_min
    wse_max
    wse_count
    wse_range
*/

var annualWseSummaries = ee.ImageCollection.fromImages(
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

print('------------------------------------------------------');
print('ANNUAL WSE SUMMARIES');
print('------------------------------------------------------');
print('Annual WSE summaries:', annualWseSummaries);


/****************************************************************
 * 12. YEAR-MONTH WSE SUMMARIES
 ****************************************************************/

/*
  One image per available year-month combination.
  Example:
    2022-07
    2022-08
    2023-01
    etc.
*/

var yearMonthWseSummaries = ee.ImageCollection.fromImages(
  availableYearMonths.map(function(yearMonth) {

    yearMonth = ee.String(yearMonth);

    var monthlyCollection = swotPrepared
      .filter(ee.Filter.eq('year_month', yearMonth))
      .select('wse');

    var firstImage = ee.Image(
      swotPrepared
        .filter(ee.Filter.eq('year_month', yearMonth))
        .first()
    );

    var year = ee.Number(firstImage.get('year'));
    var month = ee.Number(firstImage.get('month'));

    var monthlySummary = monthlyCollection.reduce(WSE_SUMMARY_REDUCER);

    monthlySummary = addWseRangeBand(monthlySummary);

    return monthlySummary
      .set('year', year)
      .set('month', month)
      .set('year_month', yearMonth)
      .set('n_source_images', monthlyCollection.size())
      .set('system:time_start',
           ee.Date.fromYMD(year, month, 1).millis());
  })
);

print('------------------------------------------------------');
print('YEAR-MONTH WSE SUMMARIES');
print('------------------------------------------------------');
print('Year-month WSE summaries:', yearMonthWseSummaries);


/****************************************************************
 * 13. CALENDAR-MONTH CLIMATOLOGIES ACROSS ALL YEARS
 ****************************************************************/

/*
  One image per calendar month:
    January mean across all years
    February mean across all years
    ...
    December mean across all years
*/

var monthNumbers = ee.List.sequence(1, 12);

var calendarMonthWseSummaries = ee.ImageCollection.fromImages(
  monthNumbers.map(function(month) {

    month = ee.Number(month);

    var calendarMonthCollection = swotPrepared
      .filter(ee.Filter.eq('month', month))
      .select('wse');

    var monthSummary = calendarMonthCollection.reduce(WSE_SUMMARY_REDUCER);

    monthSummary = addWseRangeBand(monthSummary);

    return monthSummary
      .set('calendar_month', month)
      .set('n_source_images', calendarMonthCollection.size())
      .set('system:time_start',
           ee.Date.fromYMD(2000, month, 1).millis());
  })
);

print('------------------------------------------------------');
print('CALENDAR-MONTH WSE SUMMARIES');
print('------------------------------------------------------');
print('Calendar-month WSE summaries:', calendarMonthWseSummaries);


/****************************************************************
 * 14. INTERANNUAL VARIABILITY OF ANNUAL MEAN WSE
 ****************************************************************/

/*
  This isolates between-year variability of annual mean WSE.

  Example interpretation:
    - high values may indicate strong interannual lake/river level changes
    - but also consider source observation counts and sampling density
*/

var annualMeanWseCollection = annualWseSummaries.select('wse_mean');

var interannualAnnualMeanSummary = annualMeanWseCollection.reduce(
  ee.Reducer.mean()
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
    })
);

var interannualAnnualMeanRange = interannualAnnualMeanSummary
  .select('wse_mean_max')
  .subtract(interannualAnnualMeanSummary.select('wse_mean_min'))
  .rename('wse_annual_mean_range');

interannualAnnualMeanSummary =
  interannualAnnualMeanSummary.addBands(interannualAnnualMeanRange);

print('------------------------------------------------------');
print('INTERANNUAL VARIABILITY OF ANNUAL MEAN WSE');
print('------------------------------------------------------');
print('Interannual annual-mean WSE summary:',
      interannualAnnualMeanSummary);
print('Bands:',
      interannualAnnualMeanSummary.bandNames());


/****************************************************************
 * 15. DISPLAY OVERALL SUMMARY LAYERS
 ****************************************************************/

if (SHOW_OVERALL_SUMMARY_LAYERS) {

  Map.addLayer(
    overallWseSummary.select('wse_mean'),
    WSE_VIS,
    'Overall mean masked SWOT WSE',
    true
  );

  Map.addLayer(
    overallWseSummary.select('wse_median'),
    WSE_VIS,
    'Overall median masked SWOT WSE',
    false
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

  Map.addLayer(
    interannualAnnualMeanSummary.select('wse_mean_stdDev'),
    WSE_STDDEV_VIS,
    'Interannual stdDev of annual mean WSE',
    false
  );

  Map.addLayer(
    interannualAnnualMeanSummary.select('wse_annual_mean_range'),
    WSE_RANGE_VIS,
    'Interannual range of annual mean WSE',
    false
  );
}


/****************************************************************
 * 16. DISPLAY ANNUAL SUMMARY LAYERS
 ****************************************************************/

if (SHOW_ANNUAL_MEAN_WSE_LAYERS) {

  availableYears.evaluate(function(yearList) {

    yearList.forEach(function(year) {

      var annualImage = ee.Image(
        annualWseSummaries
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


if (SHOW_ANNUAL_STDDEV_LAYERS) {

  availableYears.evaluate(function(yearList) {

    yearList.forEach(function(year) {

      var annualImage = ee.Image(
        annualWseSummaries
          .filter(ee.Filter.eq('year', year))
          .first()
      );

      Map.addLayer(
        annualImage.select('wse_stdDev'),
        WSE_STDDEV_VIS,
        'Annual WSE stdDev - ' + year,
        false
      );
    });
  });
}


if (SHOW_ANNUAL_RANGE_LAYERS) {

  availableYears.evaluate(function(yearList) {

    yearList.forEach(function(year) {

      var annualImage = ee.Image(
        annualWseSummaries
          .filter(ee.Filter.eq('year', year))
          .first()
      );

      Map.addLayer(
        annualImage.select('wse_range'),
        WSE_RANGE_VIS,
        'Annual WSE range - ' + year,
        false
      );
    });
  });
}


if (SHOW_ANNUAL_COUNT_LAYERS) {

  availableYears.evaluate(function(yearList) {

    yearList.forEach(function(year) {

      var annualImage = ee.Image(
        annualWseSummaries
          .filter(ee.Filter.eq('year', year))
          .first()
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


/****************************************************************
 * 17. DISPLAY YEAR-MONTH MEAN WSE LAYERS
 ****************************************************************/

/*
  WARNING:
    If many year-month combinations exist, this can add many layers.
*/

if (SHOW_YEAR_MONTH_MEAN_LAYERS) {

  availableYearMonths.evaluate(function(yearMonthList) {

    yearMonthList.forEach(function(yearMonth) {

      var monthlyImage = ee.Image(
        yearMonthWseSummaries
          .filter(ee.Filter.eq('year_month', yearMonth))
          .first()
      );

      Map.addLayer(
        monthlyImage.select('wse_mean'),
        WSE_VIS,
        'Year-month mean WSE - ' + yearMonth,
        false
      );
    });
  });
}


/****************************************************************
 * 18. DISPLAY CALENDAR-MONTH MEAN WSE LAYERS
 ****************************************************************/

if (SHOW_CALENDAR_MONTH_MEAN_LAYERS) {

  var monthLabels = {
    1: 'January',
    2: 'February',
    3: 'March',
    4: 'April',
    5: 'May',
    6: 'June',
    7: 'July',
    8: 'August',
    9: 'September',
    10: 'October',
    11: 'November',
    12: 'December'
  };

  for (var m = 1; m <= 12; m++) {

    var calendarMonthImage = ee.Image(
      calendarMonthWseSummaries
        .filter(ee.Filter.eq('calendar_month', m))
        .first()
    );

    Map.addLayer(
      calendarMonthImage.select('wse_mean'),
      WSE_VIS,
      'Calendar-month mean WSE - ' + monthLabels[m],
      false
    );
  }
}


/****************************************************************
 * 19. OPTIONAL QUICK NOTES PRINTED TO THE CONSOLE
 ****************************************************************/

print('------------------------------------------------------');
print('SCRIPT SETTINGS');
print('------------------------------------------------------');
print('Apply JRC maximum water extent mask:',
      APPLY_JRC_MAX_EXTENT_MASK);
print('Apply WSE quality mask:',
      APPLY_WSE_QUAL_MASK);
print('Quality filter mode:',
      WSE_QUAL_FILTER_MODE);
print('If LTE: keep wse_qual <=',
      WSE_QUAL_MAX_VALUE);
print('If EQ: keep wse_qual ==',
      WSE_QUAL_EQUAL_VALUE);
print('If LIST: keep wse_qual in',
      WSE_QUAL_ALLOWED_VALUES);
print('------------------------------------------------------');
