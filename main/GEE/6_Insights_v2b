// ---------------------------------------------
// 1) USER PARAMETERS
// ---------------------------------------------
var collectionId = 'projects/hardy-tenure-383607/assets/Tanganyika/PostProc/PostProc_SW';

// Eras
var era1Start = ee.Date('2015-01-01'), era1End = ee.Date('2019-12-31');
var era2Start = ee.Date('2020-01-01'), era2End = ee.Date(Date.now());

// ---------------------------------------------
// 2) LOAD & PREP
// ---------------------------------------------
var allRaw = ee.ImageCollection(collectionId);

// Mask to 0 and rename to 'water' (0/1)
function binarize(img) { return img.unmask(0).rename('water'); }
var all = allRaw.map(binarize);

// Safe “max over range” → always returns an image with band 'water'
function maxOverRangeSafe(startDate, endDate) {
  var ic = all.filterDate(startDate, endDate);
  return ee.Image(ee.Algorithms.If(
    ic.size().gt(0),
    ic.reduce(ee.Reducer.max()).rename('water'),
    ee.Image(0).rename('water')
  ));
}
function maxYearSafe(y) {
  var s = ee.Date.fromYMD(y, 1, 1), e = s.advance(1, 'year');
  return maxOverRangeSafe(s, e);
}
function maxMonthSafe(y, m) {
  var s = ee.Date.fromYMD(y, m, 1), e = s.advance(1, 'month');
  return maxOverRangeSafe(s, e);
}

// Split eras (already binarized)
var col1 = all.filterDate(era1Start, era1End);
var col2 = all.filterDate(era2Start, era2End);
var n1 = col1.size(), n2 = col2.size();

// ---------------------------------------------
// 3) BASIC STATS
// ---------------------------------------------
var sum1 = col1.reduce(ee.Reducer.sum()).rename('sum1');
var sum2 = col2.reduce(ee.Reducer.sum()).rename('sum2');
var occ1 = sum1.divide(n1).multiply(100).rename('occurrence_2015_2019');
var occ2 = sum2.divide(n2).multiply(100).rename('occurrence_2020_now');
var changeAbs  = occ2.subtract(occ1).rename('change_absolute');
var changeNorm = occ1.subtract(occ2).divide(occ1.add(occ2)).multiply(100).rename('change_normalized');

// ---------------------------------------------
// 4) SEASONALITY (0–12)
// ---------------------------------------------
var seasonality = ee.Image(0).rename('seasonality');
for (var m = 1; m <= 12; m++) {
  var mcol = all.filter(ee.Filter.calendarRange(m, m, 'month'));
  var mmax = ee.Image(ee.Algorithms.If(
    mcol.size().gt(0),
    mcol.reduce(ee.Reducer.max()).rename('water'),
    ee.Image(0).rename('water')
  ));
  seasonality = seasonality.add(mmax);
}

// ---------------------------------------------
// 5) YEARLY PRESENCE & RECURRENCE
// ---------------------------------------------
var startYear = 2015;
var endYear   = new Date().getFullYear();

var yearlyImgs = [];
for (var y = startYear; y <= endYear; y++) {
  yearlyImgs.push(maxYearSafe(y).set('year', y));   // band 'water'
}
var yearly = ee.ImageCollection(yearlyImgs);

// dry→wet returns per year pair
var returnImgs = [];
for (var i = 1; i < yearlyImgs.length; i++) {
  var prev = yearlyImgs[i - 1], curr = yearlyImgs[i];
  returnImgs.push(curr.eq(1).and(prev.eq(0)).rename('return'));
}
var nTransitions = Math.max(yearlyImgs.length - 1, 1);
var sumReturns = returnImgs.length > 0
  ? ee.ImageCollection(returnImgs).reduce(ee.Reducer.sum()).rename('sum_returns')
  : ee.Image(0).rename('sum_returns');
var recurrence = sumReturns.divide(nTransitions).multiply(100).rename('recurrence');

// ---------------------------------------------
// 6) TRANSITION (first vs last year)
// ---------------------------------------------
var firstYearImg = yearlyImgs.length > 0 ? yearlyImgs[0] : ee.Image(0).rename('water');
var lastYearImg  = yearlyImgs.length > 0 ? yearlyImgs[yearlyImgs.length - 1] : ee.Image(0).rename('water');
var transition = ee.Image(0).rename('transition')
  .where(firstYearImg.eq(1).and(lastYearImg.eq(1)), 1)
  .where(firstYearImg.eq(0).and(lastYearImg.eq(1)), 2)
  .where(firstYearImg.eq(1).and(lastYearImg.eq(0)), 3);

// ---------------------------------------------
// 7) MAX EXTENT (ever wet)
// ---------------------------------------------
var maxExtent = all.reduce(ee.Reducer.max()).rename('max_extent');

// ---------------------------------------------
// 8) INTERANNUAL VARIABILITY (CV %)
// ---------------------------------------------
var yearlyMean = yearly.reduce(ee.Reducer.mean()).select(0).rename('mean');
var yearlyStd  = yearly.reduce(ee.Reducer.stdDev()).select(0).rename('std');
var cv = yearlyStd.divide(yearlyMean).multiply(100).rename('cv');

// ---------------------------------------------
// 9) MEAN ANNUAL WATER AREA (m²)
// ---------------------------------------------
var pixelArea = ee.Image.pixelArea();
var meanArea = yearly.map(function(img){
  return img.select('water').multiply(pixelArea).rename('area');
}).reduce(ee.Reducer.mean()).rename('mean_area_m2');

// ---------------------------------------------
// 10) ONSET & CESSATION (mean month across years)
// ---------------------------------------------
function onsetYear(y) {
  var monthly = [];
  for (var m = 1; m <= 12; m++) {
    var wm = maxMonthSafe(y, m);  // 'water'
    var monthImg = ee.Image.constant(m).toFloat().updateMask(wm.eq(1)).rename('onset');
    monthly.push(monthImg);
  }
  return ee.ImageCollection(monthly)
           .reduce(ee.Reducer.min())
           .toFloat().unmask(0)
           .rename('onset');
}
function cessationYear(y) {
  var monthly = [];
  for (var m = 12; m >= 1; m--) {
    var wm = maxMonthSafe(y, m);
    var monthImg = ee.Image.constant(m).toFloat().updateMask(wm.eq(1)).rename('cessation');
    monthly.push(monthImg);
  }
  return ee.ImageCollection(monthly)
           .reduce(ee.Reducer.max())
           .toFloat().unmask(0)
           .rename('cessation');
}

var onsetIC = ee.ImageCollection([]);
var cessIC  = ee.ImageCollection([]);
for (var yy = startYear; yy <= endYear; yy++) {
  onsetIC = onsetIC.merge(ee.ImageCollection([onsetYear(yy)]));      // band 'onset' (Float)
  cessIC  = cessIC.merge(ee.ImageCollection([cessationYear(yy)]));   // band 'cessation' (Float)
}
var onsetMean       = onsetIC.reduce(ee.Reducer.mean()).rename('mean_onset_month');
var cessationMean   = cessIC.reduce(ee.Reducer.mean()).rename('mean_cessation_month');
var wetSeasonLength = cessationMean.subtract(onsetMean).add(1).rename('wet_season_length');

// ---------------------------------------------
// 11) LONGEST CONTINUOUS WET/DRY SPELL (months)
// ---------------------------------------------
var monthlyAll = all.filterDate(era1Start, era2End).sort('system:time_start');
function maxRun(isWet) {
  var init = ee.Dictionary({curr: ee.Image(0), max: ee.Image(0)});
  var out = ee.Dictionary(monthlyAll.iterate(function(img, prev){
    prev = ee.Dictionary(prev);
    img  = ee.Image(img);                 // band 'water'
    var cond = isWet ? img : img.eq(0);   // 1 where condition holds
    var run  = ee.Image(prev.get('curr')).add(cond).multiply(cond);
    var mx   = ee.Image(prev.get('max')).max(run);
    return ee.Dictionary({curr: run, max: mx});
  }, init));
  return ee.Image(out.get('max'));
}
var maxWetSpell = maxRun(true).rename('max_wet_spell');
var maxDrySpell = maxRun(false).rename('max_dry_spell');

// ---------------------------------------------
// 12) TREND SLOPE (months per decade)
// ---------------------------------------------
var withYear = yearly.map(function(img){
  var yr = ee.Number(img.get('year'));
  var yearBand   = ee.Image.constant(yr).toFloat().rename('year');
  var waterFloat = img.select('water').toFloat();
  return waterFloat.addBands(yearBand).select(['year','water']);
});
var trendFit = withYear.reduce(ee.Reducer.linearFit());
var trend = trendFit.select('scale').multiply(10).rename('trend_moPerDecade');

// ---------------------------------------------
// 13) FLOOD / DRY FREQUENCIES
// ---------------------------------------------
var floodFreq = returnImgs.length > 0
  ? ee.ImageCollection(returnImgs).reduce(ee.Reducer.sum()).rename('flood_frequency')
  : ee.Image(0).rename('flood_frequency');

var dryImgs = [];
for (var j = 1; j < yearlyImgs.length; j++) {
  dryImgs.push(yearlyImgs[j - 1].eq(1).and(yearlyImgs[j].eq(0)).rename('dry'));
}
var dryFreq = dryImgs.length > 0
  ? ee.ImageCollection(dryImgs).reduce(ee.Reducer.sum()).rename('dry_frequency')
  : ee.Image(0).rename('dry_frequency');

// =============================================
// NEW INSIGHTFUL LAYERS
// =============================================

// 14) FLIP RATE (%) = (flood + dry) / transitions * 100
var transConst = ee.Image.constant(nTransitions).toFloat();
var flipRate = floodFreq.add(dryFreq).toFloat()
  .divide(transConst).multiply(100).rename('flip_rate_pct');

// 15) NET SHIFT (%) = (flood - dry) / transitions * 100
var netShift = floodFreq.subtract(dryFreq).toFloat()
  .divide(transConst).multiply(100).rename('net_shift_pct');

// 16) FIRST / LAST WET YEAR and YEARS SINCE LAST WET
var firstWetYear = ee.ImageCollection(yearlyImgs.map(function(img){
  var yr = ee.Number(img.get('year'));
  return ee.Image.constant(yr).toFloat().updateMask(ee.Image(img).eq(1)).rename('year');
})).reduce(ee.Reducer.min()).rename('first_wet_year');

var lastWetYear = ee.ImageCollection(yearlyImgs.map(function(img){
  var yr = ee.Number(img.get('year'));
  return ee.Image.constant(yr).toFloat().updateMask(ee.Image(img).eq(1)).rename('year');
})).reduce(ee.Reducer.max()).rename('last_wet_year');

var yearsSinceLastWet = ee.Image.constant(endYear).toFloat()
  .subtract(lastWetYear.unmask(0))
  .rename('years_since_last_wet');

// 17) PEAK WET MONTH (mode across all years)
function monthCount(m) {
  var mcol = all.filter(ee.Filter.calendarRange(m, m, 'month'));
  var cnt = ee.Image(ee.Algorithms.If(
    mcol.size().gt(0),
    mcol.reduce(ee.Reducer.sum()),
    ee.Image(0)
  ));
  return cnt.select(0).toFloat().rename('count'); // ensure a single 'count' band
}
var maxCount = ee.Image(-1).toFloat();
var peakMonth = ee.Image(0).toFloat().rename('peak_wet_month');
for (var mm = 1; mm <= 12; mm++) {
  var cntm = monthCount(mm); // band 'count'
  var greater = cntm.gt(maxCount);
  peakMonth = peakMonth.where(greater, mm);
  maxCount  = maxCount.max(cntm);
}

// ---------------------------------------------
// 18) PATCH AREA (m²)
// ---------------------------------------------
var patchArea = maxExtent.selfMask()
  .connectedPixelCount(1024, false)
  .multiply(pixelArea)
  .rename('patch_area_m2');

// ---------------------------------------------
// 19) MASKED (self/wet) PRODUCTS
// ---------------------------------------------
var wetMask = maxExtent.eq(1);
function maskWet(img) { return img.updateMask(wetMask); }
function maskNonZero(img) { return img.updateMask(img.neq(0)); }

var occ1_m            = maskWet(occ1);
var occ2_m            = maskWet(occ2);
var changeAbs_m       = maskWet(maskNonZero(changeAbs));
var changeNorm_m      = maskWet(maskNonZero(changeNorm));
var seasonality_m     = maskWet(seasonality);
var recurrence_m      = maskWet(recurrence);
var transition_m      = transition.selfMask();
var maxExtent_m       = maxExtent.selfMask();
var cv_m              = maskWet(cv);
var meanArea_m        = maskWet(meanArea);
var onsetMean_m       = maskWet(onsetMean);
var cessationMean_m   = maskWet(cessationMean);
var wetSeasonLength_m = maskWet(wetSeasonLength);
var maxWetSpell_m     = maskWet(maxWetSpell);
var maxDrySpell_m     = maskWet(maxDrySpell);
var trend_m           = maskWet(trend);
var floodFreq_m       = maskWet(maskNonZero(floodFreq));
var dryFreq_m         = maskWet(maskNonZero(dryFreq));
var patchArea_m       = patchArea.selfMask();

// NEW masked layers
var flipRate_m        = maskWet(maskNonZero(flipRate));
var netShift_m        = maskWet(maskNonZero(netShift));
var firstWetYear_m    = maskWet(firstWetYear);
var lastWetYear_m     = maskWet(lastWetYear);
var yearsSinceLastWet_m = maskWet(yearsSinceLastWet).updateMask(lastWetYear.gt(0));
var peakMonth_m       = maskWet(peakMonth).updateMask(maxCount.gt(0));

// ---------------------------------------------
// 20) STACK (if you want to export)
// ---------------------------------------------
var allMetrics = ee.Image.cat([
  occ1_m, occ2_m,
  changeAbs_m, changeNorm_m,
  seasonality_m,
  recurrence_m,
  transition_m,
  maxExtent_m,
  cv_m,
  meanArea_m,
  onsetMean_m, cessationMean_m, wetSeasonLength_m,
  maxWetSpell_m, maxDrySpell_m,
  trend_m,
  floodFreq_m, dryFreq_m,
  // New ones:
  flipRate_m, netShift_m,
  firstWetYear_m, lastWetYear_m, yearsSinceLastWet_m,
  peakMonth_m,
  patchArea_m
]);

// ---------------------------------------------
// 21) VISUALIZE (all layers hidden by default)
// ---------------------------------------------
Map.addLayer(flipRate_m,   {min:0,   max:100, palette:['#ffffff','#0000ff']},            'Flip rate (%)', false);
Map.addLayer(netShift_m,   {min:-100,max:100, palette:['#d1102d','#ffffff','#22b14c']},  'Net shift (%)', false);
Map.addLayer(firstWetYear_m,{min:2015,max:endYear, palette:['#ffffcc','#41ab5d']},       'First wet year', false);
Map.addLayer(lastWetYear_m, {min:2015,max:endYear, palette:['#fee0d2','#de2d26']},       'Last wet year', false);
Map.addLayer(yearsSinceLastWet_m,{min:0,max:(endYear-startYear), palette:['#f7fbff','#08519c']}, 'Years since last wet', false);
// 12-color palette for months (Jan..Dec)
var monthPalette = ['#f0f9e8','#bae4bc','#7bccc4','#43a2ca','#0868ac','#f7fcf5','#c7e9c0','#a1d99b','#74c476','#31a354','#006d2c','#00441b'];
Map.addLayer(peakMonth_m,  {min:1, max:12, palette: monthPalette},                        'Peak wet month (1–12)', false);

// Existing layers (kept hidden)
Map.addLayer(occ2_m,       {min:0,   max:100, palette:['#ffffff','#0000ff']},             'Occurrence (2020–now, masked)', false);
Map.addLayer(changeAbs_m,  {min:-100,max:100, palette:['#d1102d','#ffffff','#22b14c']},  'Absolute Change (%) (masked)', false);
Map.addLayer(changeNorm_m, {min:-100,max:100, palette:['#8b4513','#ffffff','#008080']},  'Normalized Change (%) (masked)', false);
Map.addLayer(seasonality_m,{min:0,   max:12,  palette:['#f7fbff','#deebf7','#c6dbef','#9ecae1','#6baed6','#3182bd','#08519c']}, 'Seasonality (months, masked)', false);
Map.addLayer(recurrence_m, {min:0,   max:100, palette:['#ffffff','#00008b']},            'Recurrence (%) (masked)', false);
Map.addLayer(transition_m, {min:0,   max:3,   palette:['#ffffff','#0000ff','#22b14c','#d1102d']}, 'Transition (>0 only)', false);
Map.addLayer(maxExtent_m,  {min:0,   max:1,   palette:['#ffffff','#000000']},            'Max Extent (1 only)', false);
Map.addLayer(cv_m,         {min:0,   max:100, palette:['#ffffff','#ff0000']},            'Interannual CV (%) (masked)', false);
Map.addLayer(meanArea_m,   {min:0,   max:1e6, palette:['#e5f5e0','#31a354']},            'Mean Annual Water Area (m², masked)', false);
Map.addLayer(onsetMean_m,  {min:1,   max:12,  palette:['#ffffcc','#41ab5d']},            'Mean Onset Month (masked)', false);
Map.addLayer(cessationMean_m,{min:1, max:12,  palette:['#feedde','#d94801']},            'Mean Cessation Month (masked)', false);
Map.addLayer(wetSeasonLength_m,{min:1,max:12,  palette:['#f7fbff','#6baed6']},           'Wet Season Length (months, masked)', false);
Map.addLayer(maxWetSpell_m, {min:0,   max:12,  palette:['#fff5f0','#cb181d']},           'Max Wet Spell (months, masked)', false);
Map.addLayer(maxDrySpell_m, {min:0,   max:12,  palette:['#f7fbff','#253494']},           'Max Dry Spell (months, masked)', false);
Map.addLayer(trend_m,      {min:-5,  max:5,   palette:['#ca0020','#f7f7f7','#0571b0']},  'Trend (mo/decade, masked)', false);
Map.addLayer(floodFreq_m,  {min:0,   max:10,  palette:['#ffffff','#0000ff']},            'Flood Frequency (masked)', false);
Map.addLayer(dryFreq_m,    {min:0,   max:10,  palette:['#ffffff','#ff0000']},            'Dry Frequency (masked)', false);
Map.addLayer(patchArea_m,  {min:0,   max:1e6, palette:['#f7fcf5','#00441b']},            'Patch Area (m², masked)', false);
