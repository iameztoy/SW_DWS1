# Surface Water Workflow

This repository contains Google Earth Engine (GEE) scripts and Python post-processing notebooks for surface-water extent mapping. The code is organized under `Approaches/` so the original Tanganyika workflow remains separate from newer water-extent methods.

## Installation And Development Setup

Future users must create their own local Python environment before running the Approach3 JupyterLab, geemap, and Earth Engine tools. Do not use Python from QGIS, ArcGIS, system Python, or a base conda environment for this project.

Use a project-local conda environment for Python, JupyterLab, geemap, and Earth Engine API work. From the repository root, the recommended environment path is:

```text
.\.envs\sw-dws1
```

Create it from `environment.yml`:

```powershell
conda env create --prefix .\.envs\sw-dws1 --file environment.yml
conda activate .\.envs\sw-dws1
python -m ipykernel install --user --name sw-dws1 --display-name "Python (SW_DWS1)"
```

Start with `docs/development_setup.md` for the full installation guidelines, including Miniforge/conda setup, environment isolation, Earth Engine authentication, JupyterLab launch commands, geemap usage, verification commands, and Git hygiene rules. Before developing Approach3, run the functional test notebook at `Approaches/Approach3/notebooks/01_earth_engine_geemap_public_dataset_test.ipynb`.

## Repository Structure

```text
docs/
├─ development_setup.md
└─ geemap_integration.md

environment.yml

Approaches/
├─ Approach1_Tanganyika/
│  ├─ main/
│  │  ├─ 1_SurfaceWater_fx_v4.js
│  │  ├─ 2_Lava_Emb_App_v2.2.js
│  │  ├─ 2_Lava_Emb_simple.js
│  │  ├─ 2_lava_fields_Tanganyika.js
│  │  ├─ 3_1_Visualize_WS_v1.js
│  │  ├─ 4_PostProcessing_v1.4h4.js
│  │  ├─ 5_Export_SW.js
│  │  └─ 6_Insights_v3app.js
│  └─ postprocessing/
│     ├─ 7_1_mosaic.ipynb
│     ├─ 7_2_1_vectorization.ipynb
│     ├─ 7_3_IoU_1.ipynb
│     ├─ 8_4_0_RiverDischarge_test_reach_overlap_v2.ipynb
│     ├─ 8_4_1_RiverDischarge_Crossing_v2c.ipynb
│     └─ 8_4_2_RiverDischarge_Analysis.ipynb
├─ Approach2/
│  ├─ 1_SurfaceWater_v5.2b_unified.js
│  └─ legacy/
│     ├─ 0_SurfaceWater_v5.js
│     ├─ 1_SurfaceWater_v5.1_QAmode.js
│     ├─ 1_SurfaceWater_v5.1_QAmode.S1.js
│     └─ 1_SurfaceWater_v5.2_unified.js
├─ Approach3/
│  ├─ 1_SurfaceWater_v5.2b_unified.js
│  ├─ README.md
│  ├─ configs/
│  ├─ notebooks/
│  ├─ scripts/
│  └─ src/
└─ SWOT_RegGlo/
   ├─ SWOT_cross.js
   └─ SWOTapp.js
```

## Approaches

### Approach1_Tanganyika

Original Tanganyika project workflow under `Approaches/Approach1_Tanganyika/` used to calculate surface-water extent. It combines GEE scripts for monthly water detection, post-processing, export, and insights with local Python notebooks for mosaicking, vectorization, IoU assessment, and river-discharge analysis.

### Approach2

Newer development under `Approaches/Approach2/` based on the Tanganyika workflow. The current working script is `1_SurfaceWater_v5.2b_unified.js`; intermediate versions are kept in `legacy/`.

### Approach3

Baseline copy of `Approaches/Approach2/1_SurfaceWater_v5.2b_unified.js`. This folder is reserved for the next development path, where the Sentinel-1 Otsu-thresholding approach will be replaced by a different method.

New Python, JupyterLab, and geemap development should be kept in this folder. See `docs/geemap_integration.md` for how geemap is used from the project environment without cloning geemap into this repository.

### SWOT_RegGlo

Separate SWOT RegGlo application scripts under `Approaches/SWOT_RegGlo/`.

## Notes

- Most GEE scripts are intended to run in the Google Earth Engine Code Editor.
- Several scripts contain project-specific asset IDs, date ranges, export folders, and toggles that should be reviewed before execution.
- The repository is script/notebook oriented and does not currently define a Python package or CLI.
- Generated outputs, local environments, credentials, logs, and large geospatial products are intentionally ignored by Git.
