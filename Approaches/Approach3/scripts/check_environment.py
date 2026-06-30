"""Smoke test for the Approach3 Python/Jupyter/geemap environment.

Run from the project root after activating the project environment:

    python Approaches/Approach3/scripts/check_environment.py
"""

from __future__ import annotations

import importlib
import os
import platform
from pathlib import Path


# Optional parameters. Edit these when you want to test Earth Engine auth.
EE_PROJECT: str | None = None
CHECK_EARTH_ENGINE_INITIALIZE = False
CHECK_GEEMAP_MAP_OBJECT = True


PROJECT_ROOT = Path(__file__).resolve().parents[3]
os.environ.setdefault("MPLCONFIGDIR", str(PROJECT_ROOT / ".cache" / "matplotlib"))


REQUIRED_IMPORTS = [
    ("ee", "earthengine-api"),
    ("geemap", "geemap"),
    ("jupyterlab", "jupyterlab"),
    ("ipykernel", "ipykernel"),
    ("ipywidgets", "ipywidgets"),
    ("ipyleaflet", "ipyleaflet"),
    ("pandas", "pandas"),
    ("geopandas", "geopandas"),
    ("rasterio", "rasterio"),
    ("rioxarray", "rioxarray"),
    ("xarray", "xarray"),
    ("yaml", "pyyaml"),
]


def check_import(module_name: str, package_name: str) -> bool:
    try:
        importlib.import_module(module_name)
    except Exception as exc:  # pragma: no cover - diagnostic script
        print(f"[FAIL] {package_name}: {exc}")
        return False

    print(f"[ OK ] {package_name}")
    return True


def check_earth_engine() -> bool:
    if not CHECK_EARTH_ENGINE_INITIALIZE:
        print("[SKIP] Earth Engine initialization check")
        return True

    if not EE_PROJECT:
        print("[FAIL] Set EE_PROJECT before enabling Earth Engine initialization")
        return False

    try:
        import ee

        ee.Initialize(project=EE_PROJECT)
        message = ee.String("Hello from Earth Engine").getInfo()
    except Exception as exc:  # pragma: no cover - diagnostic script
        print(f"[FAIL] Earth Engine initialization: {exc}")
        return False

    print(f"[ OK ] Earth Engine initialization: {message}")
    return True


def check_geemap() -> bool:
    if not CHECK_GEEMAP_MAP_OBJECT:
        print("[SKIP] geemap map object check")
        return True

    try:
        import geemap

        geemap.Map(center=[0, 0], zoom=2, ee_initialize=False)
    except Exception as exc:  # pragma: no cover - diagnostic script
        print(f"[FAIL] geemap map object: {exc}")
        return False

    print("[ OK ] geemap map object")
    return True


def main() -> int:
    print("Approach3 environment smoke test")
    print(f"Python: {platform.python_version()}")
    print(f"Platform: {platform.platform()}")
    print()

    import_checks = [check_import(module, package) for module, package in REQUIRED_IMPORTS]
    ee_ok = check_earth_engine()
    geemap_ok = check_geemap()

    print()
    if all(import_checks) and ee_ok and geemap_ok:
        print("Environment smoke test completed successfully.")
        return 0

    print("Environment smoke test found issues.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
