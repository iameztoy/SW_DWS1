# Surface Water Workflow (Lake Tanganyika Basin)

This repository contains a **Google Earth Engine (GEE) + Python post-processing workflow** to extract, clean, analyze, and evaluate monthly surface-water maps for the Lake Tanganyika basin.

The project combines:
- **Remote sensing water detection in GEE** (Dynamic World + Sentinel-1).
- **Post-processing and quality controls** for monthly binary water layers.
- **Export and analytics scripts** (change metrics, seasonality, trends, recurrence, etc.).
- **Python notebooks** for desktop GIS post-processing (mosaicking, vectorization, IoU assessment).

---

## Repository structure

```text
main/
├─ GEE/
│  ├─ 0_visualizeTiles
│  ├─ 1_SurfaceWater_fx_v4
│  ├─ 2_Process_S1_LOSH_mask_v.1.2_testing
│  ├─ 3_1_Visualize_WS_v1
│  ├─ 4_PostProcessing_v1.4f
│  ├─ 5_Export_SW
│  └─ 6_Insights_v2b
└─ post_processing/
   ├─ 1_mosaic.ipynb
   ├─ 2_vectorization.ipynb
   └─ 3_IoU.ipynb
```

---

## Objectives

- Build a **monthly surface-water product** for the Lake Tanganyika basin.
- Improve water detection by combining **Dynamic World probabilities** with **Sentinel-1 SAR thresholding**.
- Reduce false positives/negatives using **terrain, seasonality, and temporal consistency rules**.
- Produce actionable outputs for monitoring:
  - monthly maps,
  - long-term occurrence/change layers,
  - recurrence/transition behavior,
  - flood/dry dynamics and trend indicators.
- Support downstream QA and benchmarking through **mosaic, vectorization, and IoU analysis** notebooks.

---

## Available scripts (GEE)

> These scripts are intended to run in the Google Earth Engine Code Editor.  
> Most scripts include a **User Settings/Parameters** section at the top.

### `main/GEE/0_visualizeTiles`
Creates and visualizes a square processing grid over the AOI (HydroBASINS ID for Lake Tanganyika). Useful to inspect tile layout before batch processing.

### `main/GEE/1_SurfaceWater_fx_v4`
Core monthly water-extraction script:
- filters Dynamic World and Sentinel-1 by month,
- creates Dynamic World water/flooded vegetation masks,
- applies Otsu thresholding to SAR,
- merges masks and exports monthly water products to an Earth Engine asset path.

### `main/GEE/2_Process_S1_LOSH_mask_v.1.2_testing`
Testing/tuning script focused on Sentinel-1 + LOSH/terrain-informed masking logic and date utilities. Useful for validating masking behavior and temporal helper functions before running the full production chain.

### `main/GEE/3_1_Visualize_WS_v1`
Visualization and inspection workflow for water products with AOI and slope context layers. Useful for manual QC and for inspecting class behavior in map view.

### `main/GEE/4_PostProcessing_v1.4f`
Main post-processing engine (large script) that applies additional rule-based cleaning and temporal logic to monthly products. Includes options for testing geometry/full AOI and supports multiple exports including class-level outputs.

### `main/GEE/5_Export_SW`
Exports post-processed monthly surface-water imagery:
- either queues Drive exports, or
- prints direct download URLs.

Configured for a post-processed ImageCollection and WGS84 output at 10 m target scale.

### `main/GEE/6_Insights_v2b`
Generates analytical layers from the post-processed collection, including:
- occurrence by era,
- absolute/normalized change,
- seasonality,
- recurrence and transitions,
- max extent,
- onset/cessation and wet-season length,
- flood/dry frequencies,
- flip rate/net shift,
- trend diagnostics and summary indicators.

---

## Available notebooks (`main/post_processing`)

These notebooks complement GEE outputs for local/desktop processing (Python GIS stack).

### `1_mosaic.ipynb`
Builds monthly raster mosaics from tiled GeoTIFF outputs, with optional completeness and consistency checks, and diagnostic summaries.

### `2_vectorization.ipynb`
Converts monthly raster mosaics to vector polygons with memory-safe polygonization flow, AOI buffering, dissolve/cleanup steps, and inventory QA outputs.

### `3_IoU.ipynb`
Computes overlap and comparison metrics (IoU, Dice, precision/recall, area and boundary diagnostics) between paired monthly vector products (e.g., DEM-based vs GEE-derived outputs), with table/plot exports.

---

## Typical workflow

1. **Tile/AOI setup & map checks** (`0_visualizeTiles`, `3_1_Visualize_WS_v1`).
2. **Monthly extraction** (`1_SurfaceWater_fx_v4`) to build base water layers.
3. **Rule-based post-processing** (`4_PostProcessing_v1.4f`).
4. **Export final monthly products** (`5_Export_SW`).
5. **Generate insights layers** (`6_Insights_v2b`).
6. Optional local desktop steps:
   - mosaic tiles (`1_mosaic.ipynb`),
   - vectorize (`2_vectorization.ipynb`),
   - evaluate agreement (`3_IoU.ipynb`).

---

## Notes

- Several scripts are currently parameterized for the **Lake Tanganyika basin** (`HYBAS_ID = 1041259950`) and specific Earth Engine asset paths.
- Before running, update project-specific asset IDs, date ranges, export folders, and toggles in each script's settings block.
- The repository is script/notebook oriented and does not currently define a Python package or CLI.

