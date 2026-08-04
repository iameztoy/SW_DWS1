# Approach3

Approach3 is the active development area for the new surface-water workflow. It starts from `1_SurfaceWater_v5.2b_unified.js` as a baseline reference, but new Python, JupyterLab, and geemap work should live in this folder.

Do not edit `Approaches/Approach1_Tanganyika/` or `Approaches/Approach2/` while developing Approach3 unless that change is explicitly requested.

## Method Design

Start with `docs/method_design.md`. It summarizes the current JavaScript baseline, the Dynamic World and OPERA DSWx datasets, the proposed source/date output bands, and the first individual-date and monthly aggregate workflow designs.

For practical parameter details such as 10 m export scale, tile size, HydroBASINS level, multi-band versus encoded output, and acquisition pairing windows, see `docs/output_parameters_and_pairing.md`.

## Structure

```text
Approaches/Approach3/
├─ 1_SurfaceWater_v5.2b_unified.js
├─ configs/
│  └─ README.md
├─ docs/
│  ├─ method_design.md
│  └─ output_parameters_and_pairing.md
├─ notebooks/
│  ├─ 00_environment_and_geemap_smoke_test.ipynb
│  ├─ 01_earth_engine_geemap_public_dataset_test.ipynb
│  └─ 02_opera_hierarchy_acquisition_prototype.ipynb
├─ scripts/
│  ├─ check_environment.py
│  └─ run_approach3_example.py
└─ src/
   └─ sw_dws1_approach3/
      ├─ __init__.py
      ├─ aoi.py
      ├─ availability.py
      ├─ datasets.py
      ├─ exports.py
      ├─ gee_session.py
      ├─ periods.py
      ├─ products.py
      ├─ swot.py
      └─ tiling.py
```

Use notebooks for exploration and visual QA. Move reusable logic into `src/sw_dws1_approach3/` once it becomes stable.

Use `notebooks/00_environment_and_geemap_smoke_test.ipynb` to verify local imports and widget rendering. Use `notebooks/01_earth_engine_geemap_public_dataset_test.ipynb` to verify Earth Engine authentication, public dataset access, geemap visualization, and a simple server-side Earth Engine operation.

Use `notebooks/02_opera_hierarchy_acquisition_prototype.ipynb` for interactive development. It has a user-parameter cell at the top, AOI inspection, optional drawn AOI handling, source counts, grid/tile preview, acquisition-date product preview, monthly product preview, area summaries, and an export dry-run/start cell.

Reusable SWOT compatibility helpers are in `src/sw_dws1_approach3/swot.py`. They load the existing `SWOT_HR100m` asset, rename `b1` to `wse`, rename `b2` to `wse_qual`, and apply optional quality/JRC masks for later comparison with Approach3 products.

## Running The Python Example Script

Use `scripts/run_approach3_example.py` to run the same core workflow outside JupyterLab. Required and optional parameters are at the top of the script. By default, `START_EXPORT = False`, so the script checks source counts and product metadata but does not start an Earth Engine export task.

If `EXPORT_LABEL = None`, the script builds a stable label from the product mode, date window, and `HYBAS_ID`, for example `approach3_monthly_2025_01_hybas_1041259950`.

Most parameters can also be set from the shell with `SW_DWS1_*` environment variables. This is useful for local settings such as the Earth Engine project ID, because it avoids editing tracked files before committing to GitHub.

Set `PRODUCT_MODE = "monthly_batch"` to split `START_DATE` to `END_DATE` into monthly windows. This mode is also a dry-run by default: it prints each monthly window, source counts, and export label. If `START_EXPORT = True`, it starts at most `MAX_BATCH_EXPORT_TASKS` exports, which defaults to `1`.

By default, the script also runs a small server-side sample check around `SAMPLE_POINT_LON`, `SAMPLE_POINT_LAT`. This does not export data. It requests histograms for `water`, `water_class`, `source_rank`, and `source_bits` inside a small buffer so that Earth Engine actually evaluates the product bands. Set `SW_DWS1_RUN_SAMPLE_CHECK=false` if you only want counts and metadata.

## AOI, Dates, And Tiling

The default AOI mode is `basin`, using the HydroBASINS level-4 `HYBAS_ID` from the reference JavaScript script. For small tests, use `point_buffer`, `bbox`, or the notebook's `drawn` mode before running full-basin exports.

Date filtering uses Earth Engine's `filterDate(start, end)`, where `END_DATE` is exclusive. If a source is not available in the selected date range, the workflow should continue with higher-priority available sources and leave remaining gaps flagged with `valid_final = 0` and `gap_status = 3`. The script and notebook print source availability preflight flags and actual source counts before building products.

For large AOIs, set `USE_TILING = True` in the notebook or `SW_DWS1_USE_TILING=true` in the shell. The grid uses Earth Engine `Geometry.coveringGrid`; `TILE_SCALE_M` controls the grid cell size in the selected `TILE_CRS`. Preview the grid in the notebook before starting exports.

PowerShell:

```powershell
cd C:\Users\ibana\Desktop\SW_DWS1
conda activate .\.envs\sw-dws1
$env:SW_DWS1_EE_PROJECT = "your-google-cloud-project-id"
python Approaches\Approach3\scripts\run_approach3_example.py
```

PowerShell acquisition-date mode:

```powershell
cd C:\Users\ibana\Desktop\SW_DWS1
conda activate .\.envs\sw-dws1
$env:SW_DWS1_EE_PROJECT = "your-google-cloud-project-id"
$env:SW_DWS1_PRODUCT_MODE = "acquisition"
$env:SW_DWS1_START_DATE = "2025-01-01"
$env:SW_DWS1_END_DATE = "2025-02-01"
python Approaches\Approach3\scripts\run_approach3_example.py
```

Command Prompt:

```cmd
cd /d C:\Users\ibana\Desktop\SW_DWS1
C:\Users\ibana\miniforge3\condabin\conda.bat activate .\.envs\sw-dws1
set SW_DWS1_EE_PROJECT=your-google-cloud-project-id
python Approaches\Approach3\scripts\run_approach3_example.py
```

Command Prompt acquisition-date mode:

```cmd
cd /d C:\Users\ibana\Desktop\SW_DWS1
C:\Users\ibana\miniforge3\condabin\conda.bat activate .\.envs\sw-dws1
set SW_DWS1_EE_PROJECT=your-google-cloud-project-id
set SW_DWS1_PRODUCT_MODE=acquisition
set SW_DWS1_START_DATE=2025-01-01
set SW_DWS1_END_DATE=2025-02-01
python Approaches\Approach3\scripts\run_approach3_example.py
```

No-activation form, useful when a shell has not been initialized for conda:

```powershell
$env:SW_DWS1_EE_PROJECT = "your-google-cloud-project-id"
C:\Users\ibana\miniforge3\Scripts\conda.exe run --prefix .\.envs\sw-dws1 python Approaches\Approach3\scripts\run_approach3_example.py
```

Common environment overrides:

```text
SW_DWS1_PRODUCT_MODE=monthly | acquisition | monthly_batch
SW_DWS1_START_DATE=2025-01-01
SW_DWS1_END_DATE=2025-02-01
SW_DWS1_AOI_MODE=basin | point_buffer | bbox | geojson
SW_DWS1_HYBAS_ID=1041259950
SW_DWS1_HYDROBASINS_LEVEL=4
SW_DWS1_AOI_BBOX=29.0,-7.0,30.0,-6.0
SW_DWS1_AOI_GEOJSON_PATH=C:\path\to\aoi.geojson
SW_DWS1_TEST_AOI_POINT_LON=29.75
SW_DWS1_TEST_AOI_POINT_LAT=-6.5
SW_DWS1_TEST_AOI_BUFFER_M=20000
SW_DWS1_INCLUDE_OPERA_HLS_SENTINEL2=false
SW_DWS1_ACQUISITION_ANCHOR_USE_SAMPLE_REGION=true
SW_DWS1_RUN_SAMPLE_CHECK=true
SW_DWS1_SAMPLE_POINT_LON=29.75
SW_DWS1_SAMPLE_POINT_LAT=-6.5
SW_DWS1_SAMPLE_BUFFER_M=20000
SW_DWS1_USE_TILING=false
SW_DWS1_TILE_SCALE_M=50000
SW_DWS1_TILE_CRS=EPSG:3857
SW_DWS1_MAX_PREVIEW_TILES=12
SW_DWS1_MAX_TILES_TO_EXPORT=1
SW_DWS1_START_EXPORT=false
SW_DWS1_OUTPUT_PROFILE=standard
SW_DWS1_EXPORT_SCALE_M=10
SW_DWS1_EXPORT_IMAGE_COLLECTION=projects/your-project/assets/SW_DWS1/Approach3
SW_DWS1_MAX_BATCH_EXPORT_TASKS=1
```

Before running it, set `SW_DWS1_EE_PROJECT` to a Google Cloud project with Earth Engine access. This avoids editing a tracked script with local settings. To export, also set `SW_DWS1_START_EXPORT=true` and `SW_DWS1_EXPORT_IMAGE_COLLECTION` to an Earth Engine image collection or folder path where you have write permission. The older `SW_DWS1_EXPORT_ASSET_ROOT` variable is still accepted as a fallback.

Generated outputs should go under ignored folders such as `Approaches/Approach3/outputs/` or `Approaches/Approach3/runs/`.
