# Installation Guidelines And Development Setup

This file explains how to set up a clean local environment for the Python, JupyterLab, geemap, and Earth Engine API parts of the project.

The key rule is isolation: do not use Python environments from QGIS, ArcGIS, system Python, or a base conda environment. Those environments often carry their own geospatial libraries, DLL paths, GDAL versions, and package constraints. Mixing them with this project can create hard-to-debug import, GDAL, PROJ, rasterio, or geopandas errors.

Use Miniforge or another conda-forge-based conda installation, then create the project environment from `environment.yml`.

## Environment Location

Use a project-local conda environment inside the repository. If the repository is cloned at `C:\Users\ibana\Desktop\SW_DWS1`, the environment path is:

```powershell
C:\Users\ibana\Desktop\SW_DWS1\.envs\sw-dws1
```

For another user or another clone location, use the same relative path from the repository root:

```powershell
.\.envs\sw-dws1
```

The `.envs/` folder is ignored by Git, so installed packages stay local and are not uploaded to GitHub.

## What Gets Installed

The environment defined in `environment.yml` installs the libraries needed for the Approach3 workflow:

- Python 3.11
- Google Earth Engine Python API
- geemap
- JupyterLab
- ipykernel, ipywidgets, ipyleaflet, and JupyterLab widget support
- pandas, geopandas, shapely, pyproj
- rasterio, rioxarray, xarray, netCDF support
- matplotlib, scipy, tqdm, pyyaml
- pytest and nbstripout for testing/notebook hygiene

Do not clone the geemap repository into this project. geemap is installed as a library into `.envs/sw-dws1` and imported from notebooks or scripts.

## First-Time Setup

Run these commands from PowerShell or a Miniforge Prompt:

```powershell
cd C:\Users\ibana\Desktop\SW_DWS1
conda env create --prefix .\.envs\sw-dws1 --file environment.yml
conda activate .\.envs\sw-dws1
python -m ipykernel install --user --name sw-dws1 --display-name "Python (SW_DWS1)"
```

If `conda` is not recognized, install Miniforge for the current Windows user from conda-forge, then open the Miniforge Prompt and run the same commands. Prefer Miniforge/conda-forge for this project because geospatial packages are more consistent there on Windows.

On this machine, Miniforge is available at:

```powershell
C:\Users\ibana\miniforge3\Scripts\conda.exe
```

If ordinary `conda` is not available in PowerShell, use the explicit executable:

```powershell
cd C:\Users\ibana\Desktop\SW_DWS1
C:\Users\ibana\miniforge3\Scripts\conda.exe env create --prefix .\.envs\sw-dws1 --file environment.yml
```

The `environment.yml` file includes `nodefaults` so future environment creation uses `conda-forge` rather than mixing with ESRI, ArcGIS, or Anaconda default channels.

If `mamba` is available, this equivalent command is usually faster:

```powershell
mamba env create --prefix .\.envs\sw-dws1 --file environment.yml
```

## Verify The Environment

After installation, confirm the environment exists:

```powershell
conda env list
```

Then run the Approach3 smoke test:

```powershell
cd C:\Users\ibana\Desktop\SW_DWS1
conda activate .\.envs\sw-dws1
python Approaches\Approach3\scripts\check_environment.py
```

The Python executable should come from the project environment, not from QGIS, ArcGIS, system Python, or base conda. You can check it with:

```powershell
python -c "import sys; print(sys.executable)"
```

Expected pattern:

```text
...\SW_DWS1\.envs\sw-dws1\python.exe
```

If the path points to QGIS, ArcGIS, `C:\Windows`, or a base conda folder, stop and reactivate the project environment before running notebooks or scripts.

## Earth Engine Authentication

Authenticate from inside the project environment:

```powershell
conda activate .\.envs\sw-dws1
earthengine authenticate
```

Earth Engine credentials are stored in the user profile, not in the repository. Do not copy credential files, service-account keys, tokens, or `.env` files into the repo.

Most scripts should initialize Earth Engine explicitly with a project:

```python
import ee

EE_PROJECT = "your-google-cloud-project-id"  # Required for most EE Python workflows.
ee.Initialize(project=EE_PROJECT)
```

## Running JupyterLab

```powershell
cd C:\Users\ibana\Desktop\SW_DWS1
conda activate .\.envs\sw-dws1
jupyter lab
```

In JupyterLab, select the kernel named `Python (SW_DWS1)`.

See `docs/geemap_integration.md` for how geemap is used from this environment. The short version is that notebooks import geemap; this repository does not vendor or clone geemap.

## Functional Test With Earth Engine And geemap

After the environment smoke test passes, run a real Earth Engine/geemap test before starting development.

1. Open PowerShell or a Miniforge Prompt.
2. Move to the repository root:

```powershell
cd C:\Users\ibana\Desktop\SW_DWS1
```

3. Activate the project environment:

```powershell
conda activate .\.envs\sw-dws1
```

If `conda activate` is not available in that shell, use the Miniforge Prompt or initialize conda for PowerShell. On this machine, you can also launch commands through the explicit Miniforge executable under `C:\Users\ibana\miniforge3\Scripts\conda.exe`.

4. Authenticate Earth Engine once:

```powershell
earthengine authenticate
```

Follow the browser prompts. The credentials are stored in your user profile, not in this repository.

5. Start JupyterLab:

```powershell
jupyter lab
```

6. In JupyterLab, select the `Python (SW_DWS1)` kernel.

7. Open:

```text
Approaches/Approach3/notebooks/01_earth_engine_geemap_public_dataset_test.ipynb
```

8. In the first code cell, replace:

```python
EE_PROJECT = "your-google-cloud-project-id"
```

with a Google Cloud project ID that has Earth Engine access.

9. Run the notebook cells from top to bottom.

Expected result:

- Earth Engine initializes without an authentication error.
- geemap displays an interactive map over the Lake Tanganyika region.
- The map shows the AOI, JRC Global Surface Water occurrence, and a derived water-occurrence mask.
- The final cell prints a small dictionary with the mean water occurrence in the AOI.

This test uses a small public dataset operation, so `getInfo()` is acceptable here. During real development, avoid using `getInfo()` on large collections, large images, or large tables; export compact results instead.

## Updating Dependencies

After editing `environment.yml`, update the existing environment with:

```powershell
cd C:\Users\ibana\Desktop\SW_DWS1
conda env update --prefix .\.envs\sw-dws1 --file environment.yml --prune
```

## Running Tests

When tests are added, run them only from the project environment:

```powershell
cd C:\Users\ibana\Desktop\SW_DWS1
conda activate .\.envs\sw-dws1
python -m pytest
```

If running a one-off command from a PowerShell session where `conda activate` is not available, use `conda run` so conda-specific environment variables, including GDAL paths, are set correctly:

```powershell
C:\Users\ibana\miniforge3\Scripts\conda.exe run --prefix .\.envs\sw-dws1 python Approaches\Approach3\scripts\check_environment.py
```

## Windows Terminal And Command Prompt Notes

Windows Terminal can open different shells. If the tab says PowerShell, use the PowerShell commands above.

If the tab says Command Prompt, most commands are the same, but use `cd /d` when changing drive/path and prefer `conda.bat` for activation:

```cmd
cd /d C:\Users\ibana\Desktop\SW_DWS1
C:\Users\ibana\miniforge3\condabin\conda.bat activate .\.envs\sw-dws1
python Approaches\Approach3\scripts\check_environment.py
jupyter lab
```

The `conda run` form also works from Command Prompt and does not require activation:

```cmd
cd /d C:\Users\ibana\Desktop\SW_DWS1
C:\Users\ibana\miniforge3\Scripts\conda.exe run --prefix .\.envs\sw-dws1 python Approaches\Approach3\scripts\check_environment.py
C:\Users\ibana\miniforge3\Scripts\conda.exe run --prefix .\.envs\sw-dws1 jupyter lab
```

To verify that Command Prompt is using the project environment:

```cmd
python -c "import sys; print(sys.executable)"
```

The path should end with:

```text
SW_DWS1\.envs\sw-dws1\python.exe
```

## Git Hygiene

Before committing, always check:

```powershell
git status --short
```

Commit source code, documentation, small config templates, and dependency specs. Do not commit `.envs/`, notebook checkpoints, credentials, logs, generated outputs, Earth Engine task manifests, downloaded rasters, GeoPackages, shapefiles, or temporary data.

If a generated result is small and intentionally useful for documentation, move it to a clearly named example or documentation folder before tracking it.
