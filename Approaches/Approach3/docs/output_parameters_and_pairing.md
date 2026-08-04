# Approach3 Output Parameters And Pairing Notes

This note explains implementation parameters that should not crowd the general README.

## Output Resolution

The default export scale is `10` meters. This is intentional so pixels selected from Dynamic World keep the detail of the 10 m Dynamic World source.

Important caveat: OPERA DSWx-HLS and OPERA DSWx-S1 source products are 30 m products. A 10 m export grid does not create new 10 m information for OPERA-derived pixels; those pixels remain limited by the 30 m source classification. Use the source bands to distinguish which pixels came from Dynamic World, OPERA HLS, or OPERA S1.

Relevant source documentation:

- Dynamic World is a 10 m Sentinel-2-derived product, and its Earth Engine collection has one image per corresponding Sentinel-2 L1C image: <https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1>
- OPERA DSWx-HLS is a 30 m product: <https://developers.google.com/earth-engine/datasets/catalog/OPERA_DSWX_L3_V1_HLS>
- OPERA DSWx-S1 is a 30 m product with 6-12 day revisit frequency: <https://developers.google.com/earth-engine/datasets/catalog/OPERA_DSWX_L3_V1_S1>

## Tile Scale Is Not Pixel Size

`TILE_SCALE_M = 50000` controls covering-grid tile size for large-area processing. It means roughly 50 km grid cells when `TILE_CRS = "EPSG:3857"`.

It is separate from `EXPORT_SCALE_M`, which controls output raster pixel size. The default is:

```python
TILE_SCALE_M = 50000
EXPORT_SCALE_M = 10
```

Python also accepts `50_000` as the same integer value as `50000`, but the notebooks and script use `50000` for clarity.

## Standard Multi-Band Output

The default output is a multi-band Earth Engine image. This is the recommended scientific product because it preserves the classification, provenance, dates, validity, and diagnostics separately.

Acquisition-date exports include:

- `water`
- `water_class`
- `source`
- `source_rank`
- `source_date_yyyymmdd`
- `source_doy`
- `gap_status`
- `valid_final`
- `source_bits`

Monthly exports add:

- `source_first_yyyymmdd`
- `source_last_yyyymmdd`
- Dynamic World observation/valid/water counts
- OPERA HLS observation/valid/water counts
- OPERA S1 observation/valid/water counts

## Optional Encoded Single-Band Output

Set:

```python
OUTPUT_PROFILE = "encoded"
```

or from PowerShell:

```powershell
$env:SW_DWS1_OUTPUT_PROFILE = "encoded"
```

This exports one band named `encoded_class_source_date`.

The encoded value is:

```text
CSSYYYYMMDD
```

Where:

- `C` is the class code:
  - `1` = open water
  - `2` = inundated or partial surface water
  - `3` = both water types
  - `4` = valid non-water
  - `0` = unresolved/no source
- `S` is the source code:
  - `1` = Dynamic World
  - `2` = OPERA DSWx-HLS
  - `3` = OPERA DSWx-S1
  - `0` = no source
- `YYYYMMDD` is the source date.

For example, `1120260101` means open water from Dynamic World on `2026-01-01`.

This single-band profile is a compact convenience output. It is not the default because it is less transparent than separate bands, especially for monthly products where multiple dates can contribute to the aggregate.

Use:

```python
OUTPUT_PROFILE = "standard_plus_encoded"
```

when you want the full standard output plus the encoded convenience band.

## HydroBASINS Level

The JavaScript baseline uses:

```javascript
ee.FeatureCollection("WWF/HydroSHEDS/v1/Basins/hybas_4")
  .filter(ee.Filter.eq("HYBAS_ID", 1041259950))
```

Approach3 keeps this as the default:

```python
HYDROBASINS_LEVEL = 4
HYBAS_ID = 1041259950
```

To use another level, change `HYDROBASINS_LEVEL`. For example, level 3 uses:

```python
HYDROBASINS_LEVEL = 3
```

The code builds the collection path as:

```text
WWF/HydroSHEDS/v1/Basins/hybas_{HYDROBASINS_LEVEL}
```

Make sure the `HYBAS_ID` belongs to the level you selected.

## Acquisition-Date Pairing Recommendation

The default acquisition-date product remains strict:

```python
HLS_PAIR_WINDOW_DAYS = 1
S1_PAIR_WINDOW_DAYS = 3
INCLUDE_OPERA_HLS_SENTINEL2 = False
```

Reasoning:

- Dynamic World is Sentinel-2-derived and usually has more frequent optical coverage than Landsat-only HLS.
- OPERA HLS Sentinel-2 is excluded by default to avoid reusing Sentinel-2 information already represented by Dynamic World.
- OPERA DSWx-S1 has a 6-12 day revisit frequency, so `S1_PAIR_WINDOW_DAYS = 3` is a strict nearest-observation compromise rather than a broad coverage maximizer.

Use wider windows only as explicit sensitivity tests:

- HLS `2` days for slow-changing large lakes or QA experiments.
- S1 `6` days when cloud-robust coverage matters more than near-synchronous timing.

Do not hide temporal mismatch. Keep `source_date_yyyymmdd`, candidate counts, and source diagnostics in outputs.

## Weekly, Biweekly, And Monthly Products

If the goal is monitoring or area time series rather than state near one Dynamic World acquisition, period products are often more defensible than wide acquisition pairing.

Practical recommendation:

- Weekly products: useful for event monitoring, but expect missing optical coverage in cloudy periods.
- Biweekly products: good compromise for future development because it better matches S1 revisit and sparse Landsat-only HLS.
- Monthly products: best for baseline parity, seasonal summaries, and smaller export volumes.

Period products should be interpreted as "water observed during the period" unless a different reducer is explicitly implemented. They are not instantaneous end-of-period maps.
