# geemap Integration

`geemap` is a Python package that is installed into the project environment. Do not clone the `geemap` repository into this project unless we are contributing changes to geemap itself.

For this repository, integration means:

1. Install `geemap` and its dependencies into `.envs/sw-dws1` from `environment.yml`.
2. Start JupyterLab from that environment.
3. Select the `Python (SW_DWS1)` kernel.
4. Import `ee` and `geemap` in notebooks or scripts.
5. Initialize Earth Engine with a Google Cloud project that has Earth Engine access.
6. Use `geemap.Map()` in notebooks to inspect Earth Engine layers interactively.

The source code for our project stays in `Approaches/Approach3/`. Generated outputs, exported rasters, task manifests, logs, and local credentials stay out of Git.

## Minimal Notebook Pattern

```python
import ee
import geemap

EE_PROJECT = "your-google-cloud-project-id"

ee.Initialize(project=EE_PROJECT)

m = geemap.Map(center=[0, 0], zoom=2, ee_initialize=False)
m.add_basemap("HYBRID")
m
```

`geemap` provides the map interface. Earth Engine still runs the computation on Google's servers. The map requests tiles from Earth Engine; it does not download full rasters into the notebook unless we explicitly export or download data.

Use `ee_initialize=False` when we already initialize Earth Engine ourselves with `ee.Initialize(project=...)`. This keeps authentication and project selection explicit.

## Functional Test Notebook

Use this notebook to confirm the full stack works before development:

```text
Approaches/Approach3/notebooks/01_earth_engine_geemap_public_dataset_test.ipynb
```

It initializes Earth Engine with an explicit project, loads the public `JRC/GSW1_4/GlobalSurfaceWater` dataset, displays the occurrence band in geemap, builds a simple threshold mask, and computes a small summary statistic over a test AOI.

## When to Use geemap

Use geemap for:

- interactive map QA in JupyterLab;
- quickly visualizing `ee.Image`, `ee.ImageCollection`, and `ee.FeatureCollection` layers;
- drawing or inspecting areas of interest;
- comparing layers during method development;
- optional export helpers when they fit the workflow.

Do not use geemap as the place for core method logic. Core processing logic should live in Python modules under `Approaches/Approach3/src/` and be imported by notebooks.

## Approach3 Scope

`Approaches/Approach1_Tanganyika/` and `Approaches/Approach2/` are baselines. Do not edit them during Approach3 development unless we explicitly decide to backport or fix something there.
