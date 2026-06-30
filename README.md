# Surface Water Workflow

This repository contains Google Earth Engine (GEE) scripts and Python post-processing notebooks for surface-water extent mapping. The code is organized by development approach so the original Tanganyika workflow remains separate from newer water-extent methods.

## Repository Structure

```text
Approach1_Tanganyika/
├─ main/
│  ├─ 1_SurfaceWater_fx_v4.js
│  ├─ 2_Lava_Emb_App_v2.2.js
│  ├─ 2_Lava_Emb_simple.js
│  ├─ 2_lava_fields_Tanganyika.js
│  ├─ 3_1_Visualize_WS_v1.js
│  ├─ 4_PostProcessing_v1.4h4.js
│  ├─ 5_Export_SW.js
│  └─ 6_Insights_v3app.js
└─ postprocessing/
   ├─ 7_1_mosaic.ipynb
   ├─ 7_2_1_vectorization.ipynb
   ├─ 7_3_IoU_1.ipynb
   ├─ 8_4_0_RiverDischarge_test_reach_overlap_v2.ipynb
   ├─ 8_4_1_RiverDischarge_Crossing_v2c.ipynb
   └─ 8_4_2_RiverDischarge_Analysis.ipynb

Approach2/
├─ 1_SurfaceWater_v5.2b_unified.js
└─ legacy/
   ├─ 0_SurfaceWater_v5.js
   ├─ 1_SurfaceWater_v5.1_QAmode.js
   ├─ 1_SurfaceWater_v5.1_QAmode.S1.js
   └─ 1_SurfaceWater_v5.2_unified.js

Approach3/
└─ 1_SurfaceWater_v5.2b_unified.js

SWOT_RegGlo/
├─ SWOT_cross.js
└─ SWOTapp.js
```

## Approaches

### Approach1_Tanganyika

Original Tanganyika project workflow used to calculate surface-water extent. It combines GEE scripts for monthly water detection, post-processing, export, and insights with local Python notebooks for mosaicking, vectorization, IoU assessment, and river-discharge analysis.

### Approach2

Newer development based on the Tanganyika workflow. The current working script is `1_SurfaceWater_v5.2b_unified.js`; intermediate versions are kept in `legacy/`.

### Approach3

Baseline copy of `Approach2/1_SurfaceWater_v5.2b_unified.js`. This folder is reserved for the next development path, where the Sentinel-1 Otsu-thresholding approach will be replaced by a different method.

### SWOT_RegGlo

Separate SWOT RegGlo application scripts. This folder is intentionally kept outside the approach folders.

## Notes

- Most GEE scripts are intended to run in the Google Earth Engine Code Editor.
- Several scripts contain project-specific asset IDs, date ranges, export folders, and toggles that should be reviewed before execution.
- The repository is script/notebook oriented and does not currently define a Python package or CLI.
