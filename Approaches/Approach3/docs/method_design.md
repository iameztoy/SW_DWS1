# Approach3 Method Design

This note records the starting design for the new Python, JupyterLab, geemap, and Earth Engine workflow in `Approaches/Approach3`.

The baseline reference is `../1_SurfaceWater_v5.2b_unified.js`. The new workflow should keep the useful Dynamic World logic, but replace the local Sentinel-1 GRD plus Otsu threshold gap-fill with OPERA DSWx products:

1. Dynamic World
2. OPERA DSWx-HLS
3. OPERA DSWx-S1

Each later product only fills pixels that remain no-data, masked, or uncertain after earlier products.

## Initial Parameters

These are design defaults for the first Python implementation. Keep equivalent required and optional values at the beginning of scripts or notebooks.

Required parameters:

| Parameter | Initial value | Notes |
| --- | --- | --- |
| `ee_project` | user-provided | Google Cloud project with Earth Engine access. Prefer `SW_DWS1_EE_PROJECT` in the shell instead of editing tracked files. |
| `aoi` | HydroBASINS level 4 Tanganyika basin, unless overridden | Match the current JS baseline first. |
| `start_date` | user-provided | Must be checked against product availability. |
| `end_date` | user-provided | End date is exclusive in Earth Engine `filterDate`. |

Optional parameters:

| Parameter | Initial value | Notes |
| --- | --- | --- |
| `dw_water_threshold` | `0.5` | Match the JS baseline for Dynamic World open water. |
| `dw_nonwater_threshold` | `0.05` | Values between this and `dw_water_threshold` are uncertain. |
| `dw_flooded_veg_threshold` | `0.3` | Match the JS baseline for flooded vegetation. |
| `include_opera_hls_sentinel2` | `False` | Default false to avoid reusing Sentinel-2 information already represented by Dynamic World. |
| `hls_pair_window_days` | `1` | Initial tolerance for individual-date pairing. Prefer same UTC day where possible. |
| `s1_pair_window_days` | `3` | Initial tolerance for individual-date pairing. To be tested. |
| `monthly_reduce_method` | `water_if_any_valid_water` | Mirrors the current monthly "any water observation" behavior. |
| `export_scale_m` | `30` | OPERA products are 30 m. Dynamic World is 10 m, so resampling policy must be explicit. |
| `export_crs` | `EPSG:4326` | Match the JS baseline first, then review if a projected CRS is better for area work. |
| `output_profile` | `standard` | Include final class, validity, source, date, and basic diagnostics. |

Important date warning:

- Dynamic World starts in 2015 and is Sentinel-2-derived.
- OPERA DSWx-HLS starts on 2023-04-04 in the Earth Engine catalog.
- OPERA DSWx-S1 starts on 2024-08-01 in the Earth Engine catalog.
- The old JS default period, 2015-08 to 2021-12, cannot exercise OPERA gap filling. Tests for the full hierarchy must use 2024-08-01 or later if DSWx-S1 is required.

## Current JavaScript Baseline

`1_SurfaceWater_v5.2b_unified.js` is a monthly Earth Engine Code Editor script with three run modes:

| Run mode | Purpose |
| --- | --- |
| `EXPORT_WATER` | Queue monthly raster exports. |
| `THRESHOLD_QA` | Export monthly QA comparing original and safe Otsu thresholds. |
| `S1_DRIVER_QA` | Export QA tables that split Sentinel-1 behavior by pass and platform. |

The current production logic is:

1. Build a monthly list client-side.
2. Count monthly Dynamic World and Sentinel-1 images.
3. Build a Dynamic World monthly water candidate:
   - `water > 0.5` is open water.
   - `water <= 0.05` is valid non-water.
   - intermediate water probabilities are masked as uncertain.
   - monthly open water is any high-confidence water observation in the month.
   - flooded vegetation is monthly mean `flooded_vegetation > 0.3`.
4. Treat Dynamic World masked or uncertain pixels as gaps.
5. Fill Dynamic World gaps with Sentinel-1 GRD monthly minimum backscatter classified by Otsu.
6. Remove small connected components.
7. Export bands such as `water`, `valid_final`, `gap_status`, `water_source`, Dynamic World diagnostics, and Sentinel-1 diagnostics.

Key porting implications:

- Dynamic World is the authoritative base. Gap-fill products should not overwrite valid Dynamic World pixels.
- The JS script uses Code Editor callback patterns such as `evaluate(...)`; the Python version should use explicit orchestration and avoid large `getInfo()` calls.
- The current Sentinel-1 Otsu logic is not carried forward except as a reference for QA concepts and source/gap band ideas.
- Monthly exports currently skip months without Dynamic World. For Approach3 we should decide whether an OPERA-only monthly output is allowed when Dynamic World has no data.
- Do not convert masked or uncertain pixels to zero before priority merging. Premature `unmask(0)` would turn cloud, layover, HAND, or Dynamic World uncertainty into valid non-water and would block lower-priority gap filling.

## Dataset Facts

Official Earth Engine catalog sources checked on 2026-07-01:

- Dynamic World: <https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1>
- OPERA DSWx-HLS: <https://developers.google.com/earth-engine/datasets/catalog/OPERA_DSWX_L3_V1_HLS>
- OPERA DSWx-S1: <https://developers.google.com/earth-engine/datasets/catalog/OPERA_DSWX_L3_V1_S1>

### Dynamic World

Collection ID:

```python
ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1")
```

Relevant bands:

| Band | Meaning |
| --- | --- |
| `water` | Probability of complete water coverage. |
| `flooded_vegetation` | Probability of flooded vegetation. |
| `label` | Highest-probability class; `0=water`, `3=flooded_vegetation`. |

Design use:

- Use the current probability thresholds first for parity with the JS baseline.
- Preserve the distinction between open water and flooded vegetation in the output class/source bands.
- Use Dynamic World image acquisition time as the source date when a pixel comes from Dynamic World.
- Normalize Dynamic World to common `open_water`, `inundated_or_partial`, `valid`, and `water_class` bands before merging.

### OPERA DSWx-HLS

Collection ID:

```python
ee.ImageCollection("OPERA/DSWX/L3_V1/HLS")
```

Relevant properties:

| Property | Use |
| --- | --- |
| `SENSOR` | `OLI` for Landsat-8, `MSI` for Sentinel-2. |
| `SPACECRAFT_NAME` | Platform name such as `Landsat-8`, `Sentinel-2A`, `Sentinel-2B`, or `Sentinel-2C`. |
| `PROCESSING_DATETIME` | Product processing time; do not use for acquisition pairing. |

Relevant bands:

| Band | Use |
| --- | --- |
| `WTR_Water_classification` | Preferred class band. |
| `BWTR_Binary_water` | Quick water/no-water band; less expressive than `WTR`. |
| `CONF_Confidence` | Useful for QA and optional stricter filters. |
| `DIAG_diagnostic` | Diagnostic layer; fill/no-data value is `65535`. |

`WTR_Water_classification` values:

| Value | Meaning | Approach3 interpretation |
| --- | --- | --- |
| `0` | Not water | Valid non-water. |
| `1` | Open water | Water class. |
| `2` | Partial surface water | Partial/inundated water class, not pure inundated vegetation. |
| `252` | Snow/ice | Invalid for water decision. |
| `253` | Cloud/cloud shadow/adjacent | Invalid for water decision. |
| `254` | Ocean masked | Invalid for basin water decision. |

Design use:

- Default gap-fill should filter out `SENSOR == "MSI"` so Landsat-derived HLS fills Dynamic World gaps without reusing Sentinel-2-derived information.
- Keep `include_opera_hls_sentinel2=False` as an explicit optional parameter. If set true, Sentinel-2 HLS can be used for QA experiments or dates with no Dynamic World counterpart.
- Use `WTR.eq(1)` for open water and `WTR.eq(2)` for partial/inundated water. Treat `WTR.lt(252)` as valid.
- Use `WTR_Water_classification` for class separation. `BWTR_Binary_water` is useful for quick QA, but it loses open-water versus partial-water information.

### OPERA DSWx-S1

Collection ID:

```python
ee.ImageCollection("OPERA/DSWX/L3_V1/S1")
```

Relevant properties:

| Property | Use |
| --- | --- |
| `POLARIZATION` | Source radar polarization metadata. |
| `RTC_ORBIT_PASS_DIRECTION` | Ascending/descending QA. |
| `SENSOR` | Sentinel-1 instrument mode, typically `IW`. |
| `SPACECRAFT_NAME` | Sentinel-1 platform. |
| `LAYOVER_SHADOW_COVERAGE` | QA and possible filtering. |
| `SPATIAL_COVERAGE` | QA and possible filtering. |

Relevant bands:

| Band | Use |
| --- | --- |
| `WTR_Water_classification` | Preferred class band. |
| `BWTR_Binary_water` | Quick water/no-water band. |
| `CONF_Confidence` | Useful for open water and inundated vegetation confidence classes. |
| `DIAG_diagnostic` | Fuzzy water-likelihood and mask diagnostics. |

`WTR_Water_classification` values:

| Value | Meaning | Approach3 interpretation |
| --- | --- | --- |
| `0` | Not water | Valid non-water. |
| `1` | Open water | Water class. |
| `3` | Inundated vegetation | Inundated vegetation class. |
| `250` | HAND/topographic height masked | Invalid for water decision. |
| `251` | Layover/shadow masked | Invalid for water decision. |
| `254` | Ocean masked | Invalid for basin water decision. |

Design use:

- Use DSWx-S1 only after Dynamic World and DSWx-HLS have left a pixel unresolved.
- Use `WTR.eq(1)` for open water and `WTR.eq(3)` for inundated vegetation. Treat `WTR.lt(250)` as valid.
- Keep pass/platform and coverage properties for QA, not as mandatory production filters in the first implementation.
- Use `WTR_Water_classification` for class separation. `BWTR_Binary_water` is useful for quick QA, but it loses open-water versus inundated-vegetation information.

## Source Normalization And Priority Merge

Both temporal modes should use the same source normalizers before merging.

Common normalized bands:

| Band | Meaning |
| --- | --- |
| `open_water` | Binary open-water detection. |
| `inundated_or_partial` | Binary flooded vegetation, inundated vegetation, or HLS partial surface water detection. |
| `valid` | Binary valid water/non-water decision. |
| `water_class` | `0=valid non-water`, `1=open water`, `2=inundated/partial water`, `3=both`, masked = no valid estimate. |
| `source` | Class-specific source/provenance code for the product that supplies the selected pixel. |
| `source_rank` | Coarse source rank: `1=Dynamic World`, `2=OPERA DSWx-HLS`, `3=OPERA DSWx-S1`. |
| `source_bits` | Diagnostic bitmask showing which products had valid observations for the period. |

Priority merge:

1. Select Dynamic World wherever `dw.valid == 1`, including valid Dynamic World non-water.
2. Fill only remaining invalid pixels with valid OPERA DSWx-HLS Landsat-derived pixels.
3. Fill only remaining invalid pixels with valid OPERA DSWx-S1 pixels.
4. Set `valid_final`.
5. Mask `water_class` where `valid_final == 0`.

The first implementation should keep strict priority: valid non-water from a higher-priority source blocks lower-priority water detections. This follows the current JS principle that gap-fill products fill only gaps. It should be checked carefully in cloud-edge, wetland, and mixed-pixel QA examples.

## Output Bands

The output should make three things explicit: final water state, which product supplied the pixel, and the acquisition date of that product.

Initial standard output bands:

| Band | Type | Codes |
| --- | --- | --- |
| `water` | byte | `0=valid non-water`, `1=water or inundated vegetation`, masked = no final estimate. |
| `water_class` | byte | `0=valid non-water`, `1=open water`, `2=inundated/partial/flooded vegetation`, `3=both`, masked = no final estimate. |
| `source` | byte | Source/class code table below. |
| `source_rank` | byte | `1=Dynamic World`, `2=OPERA DSWx-HLS`, `3=OPERA DSWx-S1`, masked = no source. |
| `source_date_yyyymmdd` | int32 | Acquisition date of the product that supplied the pixel. |
| `source_doy` | uint16 | Day of year of the product that supplied the pixel. |
| `valid_final` | byte | `1=final pixel has a valid water/non-water estimate`, `0=no final estimate`. |
| `gap_status` | byte | `0=resolved by Dynamic World`, `1=filled by HLS`, `2=filled by S1`, `3=still unresolved`. |
| `source_bits` | byte | Diagnostic bitmask: `1=DW valid`, `2=HLS Landsat valid`, `4=HLS Sentinel-2 diagnostic valid`, `6=mixed HLS Landsat+Sentinel-2 stream`, `8=S1 valid`. |

Initial `source` codes:

| Code | Meaning |
| --- | --- |
| `0` | No final source. |
| `1` | Dynamic World open water. |
| `2` | Dynamic World flooded vegetation. |
| `3` | Dynamic World open water and flooded vegetation. |
| `4` | OPERA DSWx-HLS open water. |
| `5` | OPERA DSWx-HLS partial surface water. |
| `6` | OPERA DSWx-S1 open water. |
| `7` | OPERA DSWx-S1 inundated vegetation. |
| `8` | Valid non-water from Dynamic World. |
| `9` | Valid non-water from OPERA DSWx-HLS. |
| `10` | Valid non-water from OPERA DSWx-S1. |

Open point:

- For pixels where a higher-priority product says valid non-water and a lower-priority product says water, the hierarchy currently implies keeping the higher-priority valid non-water. This is consistent with the current JS principle that lower-priority products fill gaps only and do not override valid Dynamic World pixels. We should test this carefully in known wetland and cloud-edge cases.

## Individual Acquisition-Date Approach

This should be developed first because it clarifies product pairing and provenance before monthly aggregation.

Initial strategy:

1. Build target dates from Dynamic World acquisitions in the AOI and date range.
2. For each Dynamic World image, classify Dynamic World open water, flooded vegetation, valid non-water, and unresolved pixels.
3. Fill unresolved pixels with same-day, or nearest, OPERA DSWx-HLS Landsat-derived image(s) within `hls_pair_window_days`. Candidate HLS images are filtered to the Dynamic World anchor image footprint before choosing the nearest time match, then the final product is clipped to the requested AOI.
4. Fill remaining unresolved pixels with nearest OPERA DSWx-S1 image(s) within `s1_pair_window_days`, also filtered to the Dynamic World anchor image footprint before nearest-time sorting.
5. Write `source_date_yyyymmdd` from the actual product that supplied each pixel, not from the target date.

Why start with Dynamic World target dates:

- It preserves the existing logic that Dynamic World is the authoritative base.
- It avoids immediately creating a dense time series from every OPERA tile and every Sentinel-1 acquisition.
- It makes the first prototype easier to inspect in geemap.

Known limitation:

- Landsat-HLS and Sentinel-1 acquisitions within a tolerance window are not simultaneous with the Dynamic World Sentinel-2 acquisition. The source date bands are therefore mandatory, and the tolerance should be small and visible in outputs.
- Do not derive monthly area by summing individual acquisition-date products. The same HLS or S1 scene can be paired to more than one Dynamic World anchor date.

Likely second individual-date mode:

- `target_date_mode="all_product_dates"` can later emit an output for each unique acquisition date from Dynamic World, Landsat-derived DSWx-HLS, and DSWx-S1. This may be useful for dense event analysis, but it requires stricter rules to avoid an excessive number of exports.

## Monthly Aggregate Approach

The monthly workflow should be built after the individual-date classifier is stable.

Initial strategy:

1. Aggregate Dynamic World over the month using the current JS thresholds:
   - open water if any valid high-probability water observation occurs;
   - flooded vegetation from monthly mean probability;
   - unresolved where Dynamic World is masked or uncertain for the month.
2. Aggregate OPERA DSWx-HLS over the month, defaulting to Landsat-derived HLS only:
   - valid where any valid `WTR < 252` observation exists;
   - water where any valid `WTR in [1, 2]` observation exists;
   - class priority inside HLS should preserve open water vs partial surface water.
3. Fill remaining unresolved pixels with monthly OPERA DSWx-S1:
   - valid where any valid `WTR < 250` observation exists;
   - water where any valid `WTR in [1, 3]` observation exists.
4. Export monthly diagnostics similar to the JS baseline:
   - observation counts by product;
   - valid counts by product;
   - water counts by product;
   - open and inundated/partial counts by product;
   - occurrence percentages by product;
   - source/gap coverage;
   - first and last acquisition date used by product.

Monthly source-date rule:

- For pixels resolved by a monthly aggregate, a single `source_date_yyyymmdd` can be misleading if several observations contributed. The first implementation should either:
  - use the date of the first water observation for water pixels and first valid observation for non-water pixels, or
  - include `source_first_yyyymmdd` and `source_last_yyyymmdd` bands for monthly outputs.

Recommendation:

- Use `source_first_yyyymmdd` and `source_last_yyyymmdd` for monthly aggregate products. Keep `source_date_yyyymmdd` for individual-date products.
- The current monthly prototype keeps `source_date_yyyymmdd` as the first valid source date for compatibility, and also adds explicit `source_first_yyyymmdd` and `source_last_yyyymmdd` bands. Monthly analyses should use the explicit first/last bands.
- Start the integrated product at 30 m because both OPERA products are 30 m. Keep Dynamic World 10 m detail as diagnostic counts or fractions when aggregating to 30 m. A 10 m final product should be a deliberate backward-compatibility decision, because upsampling OPERA to 10 m creates false spatial precision.

## SWOT Compatibility

The output should remain easy to compare with SWOT-derived products already handled in Google Earth Engine.

Existing local SWOT scripts use:

- SWOT collection: `projects/hardy-tenure-383607/assets/WaterSurface/SWOT_HR100m`
- `b1 = wse`
- `b2 = wse_qual`
- quality codes: `0=nominal`, `1=suspect`, `2=degraded`, `3=bad`

Design implications:

- Preserve acquisition-date bands so SWOT overlap can be tested by time window.
- Preserve product source bands so SWOT comparisons can be stratified by Dynamic World, HLS, and S1 source.
- Keep the final binary `water` band simple, but retain `water_class` for inundated vegetation and partial water analysis.
- Avoid local-only outputs as the primary product; Earth Engine images/assets are easier to cross with existing SWOT workflows.
- `swot.py` provides optional helpers to load and quality-mask the SWOT collection for an Approach3 AOI/date window. It does not force SWOT into the core DW/OPERA hierarchy.

## First Python Implementation Slice

The first coding step is narrow and now implemented as a prototype:

1. Python modules define collection IDs, class constants, reusable source normalizers, acquisition-date pairing, monthly aggregation, export helpers, period windows, and optional SWOT compatibility helpers.
2. `notebooks/02_opera_hierarchy_acquisition_prototype.ipynb` initializes Earth Engine, loads a short 2024-08-or-later test window, visualizes the acquisition-date hierarchy, and visualizes the monthly aggregate hierarchy.
3. `scripts/run_approach3_example.py` runs the same core workflow outside JupyterLab and only starts an export when explicitly configured.
4. Lightweight tests import the modules and check constant/code definitions without requiring Earth Engine authentication.

Leave confidence filtering and deeper SWOT-vs-Approach3 overlap metrics for later slices.

Do not edit `Approaches/Approach1_Tanganyika/` or `Approaches/Approach2/` for this work.
