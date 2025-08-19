//---------------------------------------------------------------------------//
// 0. SET YOUR PARAMETERS
//---------------------------------------------------------------------------//
var parameter = {
  // adjust this to control tile size (in meters for EPSG:4326 it'll be degrees, 
  // so e.g. ~0.1 gives ~11 km tiles at the equator)
  CG_SCALE: 200000
};

//---------------------------------------------------------------------------//
// 1. DEFINE AOI & BUILD TILE GRID
//---------------------------------------------------------------------------//
var hydrobasins = ee.FeatureCollection("WWF/HydroSHEDS/v1/Basins/hybas_4")
                    .filter(ee.Filter.eq('HYBAS_ID', 1041259950));
var aoi = hydrobasins.geometry();

// Create square tiles covering the AOI
var rawTiles  = aoi.coveringGrid({ proj: 'EPSG:4326', scale: parameter.CG_SCALE });
var tileCount = rawTiles.size();
var rawList   = rawTiles.toList(tileCount);

var tiles = ee.FeatureCollection(
  ee.List.sequence(0, tileCount.subtract(1)).map(function(i) {
    var feat   = ee.Feature(rawList.get(i));
    var tileId = ee.Number(i).format('%03d');  // "000", "001", …
    return feat.set('tile_id', tileId);
  })
);

//---------------------------------------------------------------------------//
// 2. VISUALIZE ON THE MAP
//---------------------------------------------------------------------------//
// 2.1 Center the map on your AOI
Map.centerObject(aoi, 7);

// 2.2 Add the AOI boundary for context
Map.addLayer(aoi, {color: '00FF00'}, 'AOI');

// 2.3 Style and add the tile grid
var tileStyle = {
  color:     'FF0000',    // red outline
  fillColor: '00000000',  // fully transparent fill
  width:     1
};
Map.addLayer(tiles.style(tileStyle), {}, 'Tile Grid');

//---------------------------------------------------------------------------//
// 3. (OPTIONAL) CLIENT‑SIDE TILE‐BY‐TILE INSPECTION
//---------------------------------------------------------------------------//
// If you want to click through individual tiles by their IDs, you can fetch 
// the list and then add each tile as its own layer:
tiles.aggregate_array('tile_id').getInfo().forEach(function(id) {
  var fc = tiles.filter(ee.Filter.eq('tile_id', id));
  Map.addLayer(fc, {color: '0000FF'}, 'Tile ' + id);
});
