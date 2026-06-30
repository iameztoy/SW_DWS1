# Approach3

Approach3 is the active development area for the new surface-water workflow. It starts from `1_SurfaceWater_v5.2b_unified.js` as a baseline reference, but new Python, JupyterLab, and geemap work should live in this folder.

Do not edit `Approaches/Approach1_Tanganyika/` or `Approaches/Approach2/` while developing Approach3 unless that change is explicitly requested.

## Structure

```text
Approaches/Approach3/
├─ 1_SurfaceWater_v5.2b_unified.js
├─ configs/
│  └─ README.md
├─ notebooks/
│  ├─ 00_environment_and_geemap_smoke_test.ipynb
│  └─ 01_earth_engine_geemap_public_dataset_test.ipynb
├─ scripts/
│  └─ check_environment.py
└─ src/
   └─ sw_dws1_approach3/
      ├─ __init__.py
      └─ gee_session.py
```

Use notebooks for exploration and visual QA. Move reusable logic into `src/sw_dws1_approach3/` once it becomes stable.

Use `notebooks/00_environment_and_geemap_smoke_test.ipynb` to verify local imports and widget rendering. Use `notebooks/01_earth_engine_geemap_public_dataset_test.ipynb` to verify Earth Engine authentication, public dataset access, geemap visualization, and a simple server-side Earth Engine operation.

Generated outputs should go under ignored folders such as `Approaches/Approach3/outputs/` or `Approaches/Approach3/runs/`.
