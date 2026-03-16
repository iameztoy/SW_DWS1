// =====================================================================
// Post-processed Surface Water — Exports or Direct URLs (2022 → latest)
// IC: projects/hardy-tenure-383607/assets/Tanganyika/PostProc/PostProc_SW
// Output: WGS84 (EPSG:4326), scale = 10 m
// Modes: 'DRIVE' queues Drive exports; 'URL' prints direct download links
// =====================================================================

// ---------------------------
// 0) USER SETTINGS
// ---------------------------
var IC_PATH        = 'projects/hardy-tenure-383607/assets/Tanganyika/PostProc/PostProc_SW';
var START_DATE     = '2022-01-01';
var END_DATE       = '2100-01-01';     // safe upper bound
var EXPORT_MODE    = 'DRIVE';          // 'DRIVE' or 'URL'
var DRIVE_FOLDER   = 'GEE_SW';

var CRS            = 'EPSG:4326';
var SCALE_M        = 10;               // meters

// Toggles
var SHOW_VIS       = true;             // only affects map previews
var DEBUG          = true;             // diagnostic prints
var URL_MAX_PRINT  = 9999;             // if EXPORT_MODE=='URL', how many URLs to print

// ---------------------------
// 1) LOAD & FILTER
// ---------------------------
var swCol = ee.ImageCollection(IC_PATH)
  .filterDate(START_DATE, END_DATE)
  .sort('system:time_start');

// ---------------------------
// 2) DIAGNOSTICS (optional)
// ---------------------------
if (DEBUG) {
  print('IC path:', IC_PATH);
  print('Filtered window:', START_DATE, '→', END_DATE);
  print('Image count (2022+):', swCol.size());
  print('Head (5):', swCol.limit(5));
  var first = ee.Image(swCol.first());
  Map.centerObject(first, 7);
  if (SHOW_VIS) {
    Map.addLayer(first.selfMask(), {min:0, max:1, palette:['000000','00aaff']}, 'Example (first)');
    Map.addLayer(first.geometry(), {color:'yellow'}, 'Footprint (first)');
  }
}

// ---------------------------
// 3) LOOP — DRIVE exports or direct URLs
// ---------------------------
var list = swCol.toList(swCol.size());
var n = list.size().getInfo();  // OK (outside any mapped function)

print('Processing', n, 'images with mode:', EXPORT_MODE);

for (var i = 0; i < n; i++) {
  var img = ee.Image(list.get(i));

  // Build a safe name: SW_YYYY_MM (fallback to system:index if needed)
  var dateStr = 'unknown_' + i;
  try {
    dateStr = ee.Date(img.get('system:time_start')).format('YYYY_MM').getInfo();
  } catch (e1) {
    try { dateStr = ee.String(img.get('system:index')).getInfo(); } catch (e2) {}
  }
  var fileName = 'SW_' + dateStr;

  if (EXPORT_MODE === 'DRIVE') {
    // ---- Drive export (no .start() in Code Editor) ----
    Export.image.toDrive({
      image: img,                       // categorical water mask
      description: fileName,            // task name
      fileNamePrefix: fileName,         // Drive filename
      folder: DRIVE_FOLDER,
      fileFormat: 'GeoTIFF',
      formatOptions: {cloudOptimized: true},
      region: img.geometry(),           // per-image footprint
      crs: CRS,
      scale: SCALE_M,                   // meters
      maxPixels: 1e13
    });

    if (DEBUG && i < 8) print('Queued to Drive:', fileName);

  } else if (EXPORT_MODE === 'URL') {
    // ---- Direct download URL (expires after a while) ----
    var url = img.getDownloadURL({
      name: fileName,
      region: img.geometry(),
      crs: CRS,
      scale: SCALE_M,                   // meters
      format: 'GEO_TIFF'
    });
    if (i < URL_MAX_PRINT) {
      print(fileName + ' — URL:', url);
    }
  }
}

// ---------------------------
// 4) SUMMARY
// ---------------------------
if (DEBUG) {
  if (EXPORT_MODE === 'DRIVE') {
    print('All tasks queued to Drive folder:', DRIVE_FOLDER,
          '| CRS:', CRS, '| scale (m):', SCALE_M);
    print('Go to the Tasks tab and Run (or Run all).');
  } else {
    print('Printed up to', URL_MAX_PRINT, 'direct download URLs.');
  }
}

/* Notes
 - Fix applied: removed img.resample('nearest') to avoid
   "Image.resample: Invalid interpolation mode" error.
 - Using crs:'EPSG:4326' + scale:10 (m). EE will reproject to WGS84 while
   honoring 10 m target resolution; pixel angular size varies with latitude.
 - If you ever need uniform 10 m everywhere, export in a metric CRS (e.g., UTM)
   with scale:10 and omit 'crs', or run per-zone.
*/
