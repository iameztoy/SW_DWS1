/************************************************************
 * v0.1c — Pixel Insights + Full Visualization (GEE-only)
 * - FIX: No 'btoa' usage (URL-safe encoder instead)
 * - Adds ALL metric layers (toggleable)
 * - Click the map → sample metrics + rule-based narrative
 * - Emits URL fragment for extension:
 *      insightsURI=<urlencoded JSON>
 *      (and insights=<base64> only if encoding available)
 ************************************************************/

/*** 0) USER TOGGLES ***/
var SHOW_VIS = true;                  // add Map layers (hidden by default)
var DEBUG_PRINTS = true;              // diagnostics to Console
var ENABLE_EXTENSION_BRIDGE = true;   // write JSON to URL (#insightsURI=...)
var SAMPLE_SCALE = 30;                // reduceRegion sampling scale (m)

/*** 1) INPUTS & ERAS ***/
var collectionId = 'projects/hardy-tenure-383607/assets/Tanganyika/PostProc/PostProc_SW';
var era1Start = ee.Date('2015-01-01'), era1End = ee.Date('2019-12-31');
var era2Start = ee.Date('2020-01-01'), era2End = ee.Date(Date.now());

/*** 2) LOAD & PREP ***/
var allRaw = ee.ImageCollection(collectionId);
function binarize(img){ return img.unmask(0).rename('water'); }
var all = allRaw.map(binarize);

function maxOverRangeSafe(startDate, endDate){
  var ic = all.filterDate(startDate, endDate);
  return ee.Image(ee.Algorithms.If(
    ic.size().gt(0), ic.reduce(ee.Reducer.max()).rename('water'),
    ee.Image(0).rename('water')
  ));
}
function maxYearSafe(y){
  var s = ee.Date.fromYMD(y,1,1), e = s.advance(1,'year');
  return maxOverRangeSafe(s,e);
}
function maxMonthSafe(y,m){
  var s = ee.Date.fromYMD(y,m,1), e = s.advance(1,'month');
  return maxOverRangeSafe(s,e);
}

var col1 = all.filterDate(era1Start, era1End);
var col2 = all.filterDate(era2Start, era2End);
var n1 = col1.size(), n2 = col2.size();
if (DEBUG_PRINTS) print('DEBUG eras: n1(2015–2019)=', n1, ' n2(2020–now)=', n2);

/*** 3) BASIC STATS ***/
var sum1 = col1.reduce(ee.Reducer.sum()).rename('sum1');
var sum2 = col2.reduce(ee.Reducer.sum()).rename('sum2');
var occ1 = sum1.divide(n1).multiply(100).rename('occurrence_2015_2019');
var occ2 = sum2.divide(n2).multiply(100).rename('occurrence_2020_now');
var changeAbs = occ2.subtract(occ1).rename('change_absolute');
var changeNorm = occ1.subtract(occ2).divide(occ1.add(occ2)).multiply(100).rename('change_normalized');

/*** 4) SEASONALITY (0–12) ***/
var seasonality = ee.Image(0).rename('seasonality');
for (var m = 1; m <= 12; m++){
  var mcol = all.filter(ee.Filter.calendarRange(m, m, 'month'));
  var mmax = ee.Image(ee.Algorithms.If(
    mcol.size().gt(0), mcol.reduce(ee.Reducer.max()).rename('water'),
    ee.Image(0).rename('water')
  ));
  seasonality = seasonality.add(mmax);
}

/*** 5) YEARLY PRESENCE & RECURRENCE ***/
var startYear = 2015;
var endYear = new Date().getFullYear();
var yearlyImgs = [];
for (var y = startYear; y <= endYear; y++){
  yearlyImgs.push(maxYearSafe(y).set('year', y));
}
var yearly = ee.ImageCollection(yearlyImgs);

var returnImgs = [];
for (var i = 1; i < yearlyImgs.length; i++){
  var prev = yearlyImgs[i-1], curr = yearlyImgs[i];
  returnImgs.push(curr.eq(1).and(prev.eq(0)).rename('return')); // dry→wet
}
var nTransitions = Math.max(yearlyImgs.length - 1, 1);
var sumReturns = returnImgs.length > 0
  ? ee.ImageCollection(returnImgs).reduce(ee.Reducer.sum()).rename('sum_returns')
  : ee.Image(0).rename('sum_returns');
var recurrence = sumReturns.divide(nTransitions).multiply(100).rename('recurrence');

/*** 6) TRANSITION (first vs last year) ***/
var firstYearImg = yearlyImgs.length > 0 ? yearlyImgs[0] : ee.Image(0).rename('water');
var lastYearImg  = yearlyImgs.length > 0 ? yearlyImgs[yearlyImgs.length-1] : ee.Image(0).rename('water');
var transition = ee.Image(0).rename('transition')
  .where(firstYearImg.eq(1).and(lastYearImg.eq(1)), 1)
  .where(firstYearImg.eq(0).and(lastYearImg.eq(1)), 2)
  .where(firstYearImg.eq(1).and(lastYearImg.eq(0)), 3);

/*** 7) MAX EXTENT (ever wet) ***/
var maxExtent = all.reduce(ee.Reducer.max()).rename('max_extent');

/*** 8) INTERANNUAL VARIABILITY (CV %) ***/
var yearlyMean = yearly.reduce(ee.Reducer.mean()).select(0).rename('mean');
var yearlyStd  = yearly.reduce(ee.Reducer.stdDev()).select(0).rename('std');
var cv = yearlyStd.divide(yearlyMean).multiply(100).rename('cv');

/*** 9) MEAN ANNUAL WATER AREA (m²) ***/
var pixelArea = ee.Image.pixelArea();
var meanArea = yearly.map(function(img){
  return img.select('water').multiply(pixelArea).rename('area');
}).reduce(ee.Reducer.mean()).rename('mean_area_m2');

/*** 10) ONSET & CESSATION ***/
function onsetYear(yy){
  var monthly = [];
  for (var mm = 1; mm <= 12; mm++){
    var wm = maxMonthSafe(yy, mm);
    monthly.push(ee.Image.constant(mm).toFloat().updateMask(wm.eq(1)).rename('onset'));
  }
  return ee.ImageCollection(monthly).reduce(ee.Reducer.min()).toFloat().unmask(0).rename('onset');
}
function cessationYear(yy){
  var monthly = [];
  for (var mm = 12; mm >= 1; mm--){
    var wm = maxMonthSafe(yy, mm);
    monthly.push(ee.Image.constant(mm).toFloat().updateMask(wm.eq(1)).rename('cessation'));
  }
  return ee.ImageCollection(monthly).reduce(ee.Reducer.max()).toFloat().unmask(0).rename('cessation');
}
var onsetIC = ee.ImageCollection([]);
var cessIC  = ee.ImageCollection([]);
for (var yy = startYear; yy <= endYear; yy++){
  onsetIC = onsetIC.merge(ee.ImageCollection([onsetYear(yy)]));
  cessIC  = cessIC.merge(ee.ImageCollection([cessationYear(yy)]));
}
var onsetMean = onsetIC.reduce(ee.Reducer.mean()).rename('mean_onset_month');
var cessationMean = cessIC.reduce(ee.Reducer.mean()).rename('mean_cessation_month');
var wetSeasonLength = cessationMean.subtract(onsetMean).add(1).rename('wet_season_length');

/*** 11) LONGEST CONTINUOUS WET/DRY SPELL (months) ***/
var monthlyAll = all.filterDate(era1Start, era2End).sort('system:time_start');
function maxRun(isWet){
  var init = ee.Dictionary({curr: ee.Image(0), max: ee.Image(0)});
  var out = ee.Dictionary(monthlyAll.iterate(function(img, prev){
    prev = ee.Dictionary(prev);
    img = ee.Image(img);
    var cond = isWet ? img : img.eq(0);
    var run = ee.Image(prev.get('curr')).add(cond).multiply(cond);
    var mx  = ee.Image(prev.get('max')).max(run);
    return ee.Dictionary({curr: run, max: mx});
  }, init));
  return ee.Image(out.get('max'));
}
var maxWetSpell = maxRun(true).rename('max_wet_spell');
var maxDrySpell = maxRun(false).rename('max_dry_spell');

/*** 12) TREND (months per decade) ***/
var withYear = yearly.map(function(img){
  var yr = ee.Number(img.get('year'));
  return img.select('water').toFloat()
           .addBands(ee.Image.constant(yr).toFloat().rename('year'))
           .select(['year','water']);
});
var trendFit = withYear.reduce(ee.Reducer.linearFit());
var trend = trendFit.select('scale').multiply(10).rename('trend_moPerDecade');

/*** 13) FLOOD / DRY FREQ ***/
var floodFreq = returnImgs.length > 0
  ? ee.ImageCollection(returnImgs).reduce(ee.Reducer.sum()).rename('flood_frequency')
  : ee.Image(0).rename('flood_frequency');

var dryImgs = [];
for (var j = 1; j < yearlyImgs.length; j++){
  dryImgs.push(yearlyImgs[j-1].eq(1).and(yearlyImgs[j].eq(0)).rename('dry'));
}
var dryFreq = dryImgs.length > 0
  ? ee.ImageCollection(dryImgs).reduce(ee.Reducer.sum()).rename('dry_frequency')
  : ee.Image(0).rename('dry_frequency');

/*** 14) FLIP RATE & NET SHIFT ***/
var nTransitionsImg = ee.Image.constant(nTransitions).toFloat();
var flipRate = floodFreq.add(dryFreq).toFloat().divide(nTransitionsImg).multiply(100).rename('flip_rate_pct');
var netShift = floodFreq.subtract(dryFreq).toFloat().divide(nTransitionsImg).multiply(100).rename('net_shift_pct');

/*** 15) FIRST/LAST WET YEAR & YEARS SINCE ***/
var firstWetYear = ee.ImageCollection(yearlyImgs.map(function(img){
  var yr = ee.Number(img.get('year'));
  return ee.Image.constant(yr).toFloat().updateMask(ee.Image(img).eq(1)).rename('year');
})).reduce(ee.Reducer.min()).rename('first_wet_year');

var lastWetYear = ee.ImageCollection(yearlyImgs.map(function(img){
  var yr = ee.Number(img.get('year'));
  return ee.Image.constant(yr).toFloat().updateMask(ee.Image(img).eq(1)).rename('year');
})).reduce(ee.Reducer.max()).rename('last_wet_year');

var yearsSinceLastWet = ee.Image.constant(endYear).toFloat()
  .subtract(lastWetYear.unmask(0)).rename('years_since_last_wet');

/*** 16) PEAK WET MONTH ***/
function monthCount(mm){
  var mcol = all.filter(ee.Filter.calendarRange(mm, mm, 'month'));
  var cnt = ee.Image(ee.Algorithms.If(mcol.size().gt(0), mcol.reduce(ee.Reducer.sum()), ee.Image(0)));
  return cnt.select(0).toFloat().rename('count');
}
var maxCount = ee.Image(-1).toFloat();
var peakMonth = ee.Image(0).toFloat().rename('peak_wet_month');
for (var mm = 1; mm <= 12; mm++){
  var cntm = monthCount(mm);
  var greater = cntm.gt(maxCount);
  peakMonth = peakMonth.where(greater, mm);
  maxCount  = maxCount.max(cntm);
}

/*** 17) PATCH AREA (m²) ***/
var patchArea = maxExtent.selfMask()
  .connectedPixelCount(1024, false)
  .multiply(pixelArea).rename('patch_area_m2');

/*** 18) MASKED PRODUCTS ***/
var wetMask = maxExtent.eq(1);
function maskWet(img){ return img.updateMask(wetMask); }
function maskNonZero(img){ return img.updateMask(img.neq(0)); }

var occ1_m = maskWet(occ1);
var occ2_m = maskWet(occ2);
var changeAbs_m = maskWet(maskNonZero(changeAbs));
var changeNorm_m = maskWet(maskNonZero(changeNorm));
var seasonality_m = maskWet(seasonality);
var recurrence_m = maskWet(recurrence);
var transition_m = transition.selfMask();
var maxExtent_m = maxExtent.selfMask();
var cv_m = maskWet(cv);
var meanArea_m = maskWet(meanArea);
var onsetMean_m = maskWet(onsetMean);
var cessationMean_m = maskWet(cessationMean);
var wetSeasonLength_m = maskWet(wetSeasonLength);
var maxWetSpell_m = maskWet(maxWetSpell);
var maxDrySpell_m = maskWet(maxDrySpell);
var trend_m = maskWet(trend);
var floodFreq_m = maskWet(maskNonZero(floodFreq));
var dryFreq_m = maskWet(maskNonZero(dryFreq));
var patchArea_m = patchArea.selfMask();
var flipRate_m = maskWet(maskNonZero(flipRate));
var netShift_m = maskWet(maskNonZero(netShift));
var firstWetYear_m = maskWet(firstWetYear);
var lastWetYear_m = maskWet(lastWetYear);
var yearsSinceLastWet_m = maskWet(yearsSinceLastWet).updateMask(lastWetYear.gt(0));
var peakMonth_m = maskWet(peakMonth).updateMask(maxCount.gt(0));

/*** 19) STACK (for sampling on click) ***/
var allMetrics = ee.Image.cat([
  occ1_m, occ2_m, changeAbs_m, changeNorm_m, seasonality_m, recurrence_m,
  transition_m, maxExtent_m, cv_m, meanArea_m, onsetMean_m, cessationMean_m,
  wetSeasonLength_m, maxWetSpell_m, maxDrySpell_m, trend_m, floodFreq_m,
  dryFreq_m, flipRate_m, netShift_m, firstWetYear_m, lastWetYear_m,
  yearsSinceLastWet_m, peakMonth_m, patchArea_m
]);

/*** 20) VISUALIZATION — ALL layers (hidden by default) ***/
if (SHOW_VIS){
  var palRedWhiteGreen = ['#d1102d','#ffffff','#22b14c'];
  var palBlueScale     = ['#ffffff','#0000ff'];
  var palBrownTeal     = ['#8b4513','#ffffff','#008080'];
  var palCv            = ['#ffffff','#ff0000'];
  var palArea          = ['#e5f5e0','#31a354'];
  var palWetLen        = ['#f7fbff','#6baed6'];
  var palWetSpell      = ['#fff5f0','#cb181d'];
  var palDrySpell      = ['#f7fbff','#253494'];
  var palTrend         = ['#ca0020','#f7f7f7','#0571b0'];
  var palMaxExtent     = ['#ffffff','#000000'];
  var palRecurrence    = ['#ffffff','#00008b'];
  var palTrans         = ['#ffffff','#0000ff','#22b14c','#d1102d'];
  var monthPalette     = ['#f0f9e8','#bae4bc','#7bccc4','#43a2ca','#0868ac','#f7fcf5','#c7e9c0','#a1d99b','#74c476','#31a354','#006d2c','#00441b'];

  Map.addLayer(occ1_m, {min:0,max:100,palette:palBlueScale}, 'Occurrence (2015–2019)', false);
  Map.addLayer(occ2_m, {min:0,max:100,palette:palBlueScale}, 'Occurrence (2020–now)', false);
  Map.addLayer(changeAbs_m,  {min:-100,max:100,palette:palRedWhiteGreen}, 'Absolute Change (%)', false);
  Map.addLayer(changeNorm_m, {min:-100,max:100,palette:palBrownTeal},     'Normalized Change (%)', false);
  Map.addLayer(seasonality_m,{min:0,max:12,palette:['#f7fbff','#08519c']},'Seasonality (months)', false);
  Map.addLayer(recurrence_m, {min:0,max:100,palette:palRecurrence},       'Recurrence (%)', false);
  Map.addLayer(transition_m, {min:0,max:3,palette:palTrans},              'Transition (0–3)', false);
  Map.addLayer(maxExtent_m,  {min:0,max:1,palette:palMaxExtent},          'Max Extent (binary)', false);
  Map.addLayer(cv_m,         {min:0,max:200,palette:palCv},               'Interannual CV (%)', false);
  Map.addLayer(meanArea_m,   {min:0,max:1e6,palette:palArea},             'Mean Annual Water Area (m²)', false);
  Map.addLayer(onsetMean_m,  {min:1,max:12,palette:['#ffffcc','#41ab5d']}, 'Mean Onset Month', false);
  Map.addLayer(cessationMean_m,{min:1,max:12,palette:['#feedde','#d94801']}, 'Mean Cessation Month', false);
  Map.addLayer(wetSeasonLength_m,{min:1,max:12,palette:palWetLen},         'Wet Season Length (mo)', false);
  Map.addLayer(maxWetSpell_m,{min:0,max:120,palette:palWetSpell},         'Max Wet Spell (mo)', false);
  Map.addLayer(maxDrySpell_m,{min:0,max:120,palette:palDrySpell},         'Max Dry Spell (mo)', false);
  Map.addLayer(trend_m,      {min:-5,max:5,palette:palTrend},             'Trend (mo/decade)', false);
  Map.addLayer(floodFreq_m,  {min:0,max:10,palette:palBlueScale},         'Flood Frequency', false);
  Map.addLayer(dryFreq_m,    {min:0,max:10,palette:['#ffffff','#ff0000']}, 'Dry Frequency', false);
  Map.addLayer(flipRate_m,   {min:0,max:100,palette:palBlueScale},        'Flip Rate (%)', false);
  Map.addLayer(netShift_m,   {min:-100,max:100,palette:palRedWhiteGreen}, 'Net Shift (%)', false);
  Map.addLayer(firstWetYear_m,{min:2015,max:endYear,palette:['#ffffcc','#41ab5d']}, 'First Wet Year', false);
  Map.addLayer(lastWetYear_m, {min:2015,max:endYear,palette:['#fee0d2','#de2d26']}, 'Last Wet Year', false);
  Map.addLayer(yearsSinceLastWet_m,{min:0,max:(endYear-startYear),palette:['#f7fbff','#08519c']}, 'Years Since Last Wet', false);
  Map.addLayer(peakMonth_m,  {min:1,max:12,palette:monthPalette},         'Peak Wet Month (1–12)', false);
  Map.addLayer(patchArea_m,  {min:0,max:1e6,palette:['#f7fcf5','#00441b']}, 'Patch Area (m²)', false);
}

/*** 21) UI — Click→Sample→Narrative ***/
var panel = ui.Panel({style:{width:'380px'}});
var title = ui.Label('Pixel Insights (click the map)', {fontWeight:'bold', fontSize:'14px'});
var coordLbl = ui.Label('', {fontSize:'12px', color:'#555'});
var rawLbl   = ui.Label('Raw metrics will appear here…', {whiteSpace:'pre-wrap', fontSize:'11px'});
var noteLbl  = ui.Label('Narrative will appear here.', {whiteSpace:'pre-wrap', fontSize:'12px', color:'#0a5'});
panel.add(title).add(coordLbl).add(rawLbl).add(noteLbl);
ui.root.insert(0, panel);

function rb(val){ if (val===null||val===undefined) return val; return (Math.abs(val)>1e6)?Math.round(val):Math.round(val*1e3)/1e3; }
function buildNarrative(m, lat, lon){
  function has(x){ return x!==null && x!==undefined; }
  var parts = [];
  if      (m.transition===2) parts.push('Recently turned wetter (dry→wet).');
  else if (m.transition===3) parts.push('Recently turned drier (wet→dry).');
  else if (m.transition===1) parts.push('Stable wet at both endpoints.');
  else parts.push('No clear regime label.');
  if (has(m.first_wet_year)) parts.push('First wet year: '+m.first_wet_year+'.');
  if (has(m.last_wet_year))  parts.push('Last wet year: '+m.last_wet_year+'.');
  if (has(m.years_since_last_wet)) parts.push('Years since last wet: '+m.years_since_last_wet+'.');
  if (has(m.net_shift_pct)) parts.push('Net shift: '+rb(m.net_shift_pct)+'%.');
  if (has(m.flip_rate_pct)) parts.push('Flip rate: '+rb(m.flip_rate_pct)+'%.');
  if (has(m.flood_frequency)||has(m.dry_frequency)) parts.push('Flood flips: '+(m.flood_frequency||0)+', dry flips: '+(m.dry_frequency||0)+'.');
  if (has(m.peak_wet_month)) parts.push('Peak wet month: '+m.peak_wet_month+'.');
  if (has(m.wet_season_length)) parts.push('Wet-season length (mean): '+rb(m.wet_season_length)+' mo.');
  if (has(m.trend_moPerDecade)) parts.push('Trend: '+rb(m.trend_moPerDecade)+' mo/decade.');
  if (has(m.cv)) parts.push('Interannual CV: '+rb(m.cv)+'%.');
  if (has(m.occurrence_2020_now)) parts.push('Occurrence (2020–now): '+rb(m.occurrence_2020_now)+'%.');
  return 'Point ('+lon.toFixed(5)+', '+lat.toFixed(5)+')\n'+parts.join(' ');
}

Map.onClick(function(coords){
  var pt = ee.Geometry.Point([coords.lon, coords.lat]);
  coordLbl.setValue('Lon: '+coords.lon.toFixed(6)+', Lat: '+coords.lat.toFixed(6));
  var dict = allMetrics.reduceRegion({
    reducer: ee.Reducer.first(),
    geometry: pt,
    scale: SAMPLE_SCALE,
    maxPixels: 1e8,
    bestEffort: true
  });
  dict.evaluate(function(res){
    if (DEBUG_PRINTS) print('DEBUG raw metrics @click', res);
    var clean = {};
    if (res){
      Object.keys(res).forEach(function(k){
        var v = res[k];
        if (v!==null && v!==undefined) clean[k] = (typeof v==='number') ? rb(v) : v;
      });
    }
    var payload = { lon: coords.lon, lat: coords.lat, when: Date.now(), metrics: clean };
    rawLbl.setValue(JSON.stringify(payload, null, 2));
    noteLbl.setValue(buildNarrative(payload.metrics, coords.lat, coords.lon));

    if (ENABLE_EXTENSION_BRIDGE){
      var json = JSON.stringify(payload);
      // Always set URI-encoded JSON for compatibility
      var uri = encodeURIComponent(json);
      ui.url.set('insightsURI', uri);
      if (DEBUG_PRINTS) print('DEBUG emitted insightsURI length:', uri.length);

      // If a working base64 encoder exists, also set 'insights' (optional)
      try {
        // try a UTF-8 safe base64 if available; falls back silently
        if (typeof btoa === 'function' && typeof encodeURIComponent === 'function') {
          // utf8 → base64
          var b64 = btoa(unescape(encodeURIComponent(json)));
          ui.url.set('insights', b64);
          if (DEBUG_PRINTS) print('DEBUG also emitted insights (base64) length:', b64.length);
        }
      } catch (e) {
        if (DEBUG_PRINTS) print('DEBUG base64 emit skipped:', e);
      }
    }
  });
});
