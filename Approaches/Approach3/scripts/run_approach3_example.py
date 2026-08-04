"""Run a small Approach3 Earth Engine prototype from the project environment.

This script is intentionally conservative. It prints source counts and product
metadata by default. It starts an Earth Engine export only when START_EXPORT is
set to True and EXPORT_IMAGE_COLLECTION is provided.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _env_str(name: str, default: str) -> str:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value


def _env_optional_str(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value


def _env_int(name: str, default: int) -> int:
    return int(_env_str(name, str(default)))


def _env_float(name: str, default: float) -> float:
    return float(_env_str(name, str(default)))


def _env_optional_bbox(name: str) -> tuple[float, float, float, float] | None:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return None
    parts = [float(part.strip()) for part in value.split(",")]
    if len(parts) != 4:
        raise ValueError(f"{name} must contain four comma-separated values: west,south,east,north")
    return tuple(parts)  # type: ignore[return-value]


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


# ---------------------------------------------------------------------------
# Required parameters
# ---------------------------------------------------------------------------

EE_PROJECT = _env_str("SW_DWS1_EE_PROJECT", "your-google-cloud-project-id")


# ---------------------------------------------------------------------------
# Optional parameters
# ---------------------------------------------------------------------------

PRODUCT_MODE = _env_str("SW_DWS1_PRODUCT_MODE", "monthly")
START_DATE = _env_str("SW_DWS1_START_DATE", "2025-01-01")
END_DATE = _env_str("SW_DWS1_END_DATE", "2025-02-01")  # Earth Engine filterDate end is exclusive.

AOI_MODE = _env_str("SW_DWS1_AOI_MODE", "basin")
HYBAS_ID = _env_int("SW_DWS1_HYBAS_ID", 1041259950)
HYDROBASINS_LEVEL = _env_int("SW_DWS1_HYDROBASINS_LEVEL", 4)
AOI_BBOX = _env_optional_bbox("SW_DWS1_AOI_BBOX")
AOI_GEOJSON_PATH = _env_optional_str("SW_DWS1_AOI_GEOJSON_PATH", None)
TEST_AOI_POINT_LON = _env_float("SW_DWS1_TEST_AOI_POINT_LON", 29.75)
TEST_AOI_POINT_LAT = _env_float("SW_DWS1_TEST_AOI_POINT_LAT", -6.5)
TEST_AOI_BUFFER_M = _env_int("SW_DWS1_TEST_AOI_BUFFER_M", 20000)

DW_WATER_THRESHOLD = _env_float("SW_DWS1_DW_WATER_THRESHOLD", 0.5)
DW_NONWATER_THRESHOLD = _env_float("SW_DWS1_DW_NONWATER_THRESHOLD", 0.05)
DW_FLOODED_VEG_THRESHOLD = _env_float("SW_DWS1_DW_FLOODED_VEG_THRESHOLD", 0.3)

HLS_PAIR_WINDOW_DAYS = _env_int("SW_DWS1_HLS_PAIR_WINDOW_DAYS", 1)
S1_PAIR_WINDOW_DAYS = _env_int("SW_DWS1_S1_PAIR_WINDOW_DAYS", 3)
INCLUDE_OPERA_HLS_SENTINEL2 = _env_bool("SW_DWS1_INCLUDE_OPERA_HLS_SENTINEL2", False)

ACQUISITION_ANCHOR_USE_SAMPLE_REGION = _env_bool(
    "SW_DWS1_ACQUISITION_ANCHOR_USE_SAMPLE_REGION",
    True,
)
RUN_SAMPLE_CHECK = _env_bool("SW_DWS1_RUN_SAMPLE_CHECK", True)
SAMPLE_POINT_LON = _env_float("SW_DWS1_SAMPLE_POINT_LON", 29.75)
SAMPLE_POINT_LAT = _env_float("SW_DWS1_SAMPLE_POINT_LAT", -6.5)
SAMPLE_BUFFER_M = _env_int("SW_DWS1_SAMPLE_BUFFER_M", 20000)
SAMPLE_SCALE_M = _env_int("SW_DWS1_SAMPLE_SCALE_M", 10)
SAMPLE_CHECK_BANDS = ["water", "water_class", "source_rank", "source_bits"]

USE_TILING = _env_bool("SW_DWS1_USE_TILING", False)
TILE_SCALE_M = _env_int("SW_DWS1_TILE_SCALE_M", 50000)
TILE_CRS = _env_str("SW_DWS1_TILE_CRS", "EPSG:3857")
MAX_PREVIEW_TILES = _env_int("SW_DWS1_MAX_PREVIEW_TILES", 12)
MAX_TILES_TO_EXPORT = _env_int("SW_DWS1_MAX_TILES_TO_EXPORT", 1)

OUTPUT_PROFILE = _env_str("SW_DWS1_OUTPUT_PROFILE", "standard")
START_EXPORT = _env_bool("SW_DWS1_START_EXPORT", False)
EXPORT_IMAGE_COLLECTION = _env_optional_str("SW_DWS1_EXPORT_IMAGE_COLLECTION", None)
EXPORT_ASSET_ROOT = _env_optional_str(
    "SW_DWS1_EXPORT_ASSET_ROOT",
    None,
)  # Example: "projects/your-project/assets/SW_DWS1/Approach3"
EXPORT_LABEL = _env_optional_str(
    "SW_DWS1_EXPORT_LABEL",
    None,
)  # None uses a stable default label from PRODUCT_MODE, dates, and HYBAS_ID.
EXPORT_SCALE_M = _env_int("SW_DWS1_EXPORT_SCALE_M", 10)
EXPORT_CRS = _env_str("SW_DWS1_EXPORT_CRS", "EPSG:4326")
EXPORT_MAX_PIXELS = _env_float("SW_DWS1_EXPORT_MAX_PIXELS", 1e13)
MAX_BATCH_EXPORT_TASKS = _env_int("SW_DWS1_MAX_BATCH_EXPORT_TASKS", 1)


def _add_src_to_path() -> None:
    script_path = Path(__file__).resolve()
    approach3_root = script_path.parents[1]
    sys.path.insert(0, str(approach3_root / "src"))


def _sample_histogram(image, bands: list[str]) -> dict:
    import ee

    return (
        image.select(bands)
        .reduceRegion(
            reducer=ee.Reducer.frequencyHistogram(),
            geometry=_sample_region(),
            scale=SAMPLE_SCALE_M,
            maxPixels=1_000_000,
            bestEffort=True,
        )
        .getInfo()
    )


def _sample_region():
    import ee

    point = ee.Geometry.Point([SAMPLE_POINT_LON, SAMPLE_POINT_LAT])
    return point.buffer(SAMPLE_BUFFER_M)


def _print_sample_check(image, bands: list[str]) -> None:
    if not RUN_SAMPLE_CHECK:
        print("RUN_SAMPLE_CHECK is False. Pixel-level sample check was skipped.")
        return

    print(
        "Sample check region:",
        {
            "lon": SAMPLE_POINT_LON,
            "lat": SAMPLE_POINT_LAT,
            "buffer_m": SAMPLE_BUFFER_M,
            "scale_m": SAMPLE_SCALE_M,
            "bands": bands,
        },
    )
    print("Sample check histograms:", _sample_histogram(image, bands))


def _print_aoi_and_grid_summary(aoi, grid, tile_config) -> None:
    from sw_dws1_approach3.aoi import aoi_summary
    from sw_dws1_approach3.tiling import grid_summary

    print(
        "AOI configuration:",
        {
            "mode": AOI_MODE,
            "hybas_id": HYBAS_ID if AOI_MODE == "basin" else None,
            "hydrobasins_level": HYDROBASINS_LEVEL if AOI_MODE == "basin" else None,
            "bbox": AOI_BBOX,
            "geojson_path": AOI_GEOJSON_PATH,
            "test_point": [TEST_AOI_POINT_LON, TEST_AOI_POINT_LAT],
            "test_buffer_m": TEST_AOI_BUFFER_M,
        },
    )
    print("AOI summary:", aoi_summary(aoi).getInfo())
    if tile_config.enabled:
        print("Tile grid configuration:", tile_config)
        print("Tile grid summary:", grid_summary(aoi, grid).getInfo())
        print(
            "Tile export cap:",
            {
                "max_tiles_to_export": tile_config.max_export_tiles,
                "max_batch_export_tasks": MAX_BATCH_EXPORT_TASKS,
            },
        )
    else:
        print("Tiling is disabled. The AOI will be handled as one export region.")


def _export_target_root() -> str | None:
    return EXPORT_IMAGE_COLLECTION or EXPORT_ASSET_ROOT


def _export_config_class():
    from sw_dws1_approach3.exports import ExportConfig

    return ExportConfig(
        asset_root=_export_target_root(),
        scale_m=EXPORT_SCALE_M,
        crs=EXPORT_CRS,
        max_pixels=EXPORT_MAX_PIXELS,
    )


def _start_exports_for_image(
    *,
    image,
    aoi,
    grid,
    tile_config,
    label: str,
    bands: list[str],
    max_tasks: int,
) -> int:
    from sw_dws1_approach3.exports import export_image_to_asset
    from sw_dws1_approach3.tiling import export_regions

    if not START_EXPORT:
        if tile_config.enabled:
            print(
                "START_EXPORT is False. No export tasks were started. "
                "With tiling enabled, exports would be created per grid tile."
            )
        else:
            print("START_EXPORT is False. No Earth Engine export task was started.")
        return 0

    regions = export_regions(
        aoi=aoi,
        use_tiling=tile_config.enabled,
        grid=grid,
        max_tiles=tile_config.max_export_tiles,
    )
    export_config = _export_config_class()
    started = 0
    for region in regions:
        if started >= max_tasks:
            break
        region_label = label if region.label_suffix == "aoi" else f"{label}_{region.label_suffix}"
        export_image = image.set(
            {
                "approach3_export_region": region.label_suffix,
                "approach3_tiled_export": tile_config.enabled,
                "approach3_output_profile": OUTPUT_PROFILE,
            }
        )
        task = export_image_to_asset(
            image=export_image,
            region=region.region,
            label=region_label,
            config=export_config,
            bands=bands,
        )
        task.start()
        started += 1
        print("Started Earth Engine export task:", {"id": task.id, "label": region_label})
    if started < len(regions):
        print(f"Started {started} task(s); remaining regions were skipped by the task cap.")
    return started


def main() -> None:
    _add_src_to_path()

    import ee

    from sw_dws1_approach3.aoi import AoiConfig, resolve_aoi
    from sw_dws1_approach3.availability import source_availability_flags
    from sw_dws1_approach3.datasets import DynamicWorldThresholds, dynamic_world_collection
    from sw_dws1_approach3.exports import (
        add_encoded_summary_band,
        export_bands_for_profile,
    )
    from sw_dws1_approach3.gee_session import initialize_earth_engine
    from sw_dws1_approach3.periods import default_export_label, monthly_windows, validate_date_window
    from sw_dws1_approach3.products import (
        PairingConfig,
        ProductConfig,
        build_acquisition_product,
        build_monthly_product,
        candidate_counts,
        first_dynamic_world_image,
    )
    from sw_dws1_approach3.tiling import TileGridConfig, build_covering_grid

    if EE_PROJECT == "your-google-cloud-project-id":
        raise ValueError(
            "Set SW_DWS1_EE_PROJECT in your shell, or edit EE_PROJECT at the top "
            "of this script before running it."
        )
    validate_date_window(START_DATE, END_DATE)
    print("Source availability preflight:", source_availability_flags(START_DATE, END_DATE))

    initialize_earth_engine(project=EE_PROJECT)
    aoi_config = AoiConfig(
        mode=AOI_MODE,
        hybas_id=HYBAS_ID,
        hydrobasins_level=HYDROBASINS_LEVEL,
        bbox=AOI_BBOX,
        point_lon=TEST_AOI_POINT_LON,
        point_lat=TEST_AOI_POINT_LAT,
        point_buffer_m=TEST_AOI_BUFFER_M,
        geojson_path=AOI_GEOJSON_PATH,
    )
    aoi = resolve_aoi(aoi_config)
    tile_config = TileGridConfig(
        enabled=USE_TILING,
        tile_scale_m=TILE_SCALE_M,
        crs=TILE_CRS,
        max_preview_tiles=MAX_PREVIEW_TILES,
        max_export_tiles=MAX_TILES_TO_EXPORT,
    )
    grid = build_covering_grid(aoi, tile_config) if tile_config.enabled else None
    _print_aoi_and_grid_summary(aoi, grid, tile_config)

    thresholds = DynamicWorldThresholds(
        water=DW_WATER_THRESHOLD,
        nonwater=DW_NONWATER_THRESHOLD,
        flooded_vegetation=DW_FLOODED_VEG_THRESHOLD,
    )
    pairing = PairingConfig(
        hls_pair_window_days=HLS_PAIR_WINDOW_DAYS,
        s1_pair_window_days=S1_PAIR_WINDOW_DAYS,
        include_opera_hls_sentinel2=INCLUDE_OPERA_HLS_SENTINEL2,
    )
    config = ProductConfig(thresholds=thresholds, pairing=pairing)

    if PRODUCT_MODE == "monthly_batch":
        started = 0
        for window in monthly_windows(START_DATE, END_DATE):
            default_label = default_export_label(
                product_mode="monthly",
                start_date=window.start_date,
                end_date=window.end_date,
                hybas_id=HYBAS_ID,
            )
            export_label = f"{EXPORT_LABEL}_{window.label}" if EXPORT_LABEL else default_label
            counts = candidate_counts(
                aoi=aoi,
                start_date=window.start_date,
                end_date=window.end_date,
                include_opera_hls_sentinel2=INCLUDE_OPERA_HLS_SENTINEL2,
            ).getInfo()
            print(
                "Monthly window:",
                {
                    "start_date": window.start_date,
                    "end_date": window.end_date,
                    "label": export_label,
                    "counts": counts,
                },
            )

            if START_EXPORT and started < MAX_BATCH_EXPORT_TASKS:
                image = build_monthly_product(
                    aoi=aoi,
                    start_date=window.start_date,
                    end_date=window.end_date,
                    config=config,
                )
                image = add_encoded_summary_band(image)
                started += _start_exports_for_image(
                    image=image,
                    aoi=aoi,
                    grid=grid,
                    tile_config=tile_config,
                    label=export_label,
                    bands=export_bands_for_profile(
                        product_mode="monthly",
                        output_profile=OUTPUT_PROFILE,
                    ),
                    max_tasks=MAX_BATCH_EXPORT_TASKS - started,
                )

        if START_EXPORT:
            print(f"Started {started} monthly export task(s).")
            if started >= MAX_BATCH_EXPORT_TASKS:
                print("Reached MAX_BATCH_EXPORT_TASKS; remaining windows were dry-run only.")
        else:
            print("START_EXPORT is False. No Earth Engine export tasks were started.")
        if RUN_SAMPLE_CHECK:
            first_window = monthly_windows(START_DATE, END_DATE)[0]
            image = build_monthly_product(
                aoi=aoi,
                start_date=first_window.start_date,
                end_date=first_window.end_date,
                config=config,
            )
            print(
                "Monthly batch sample check uses the first window:",
                {"start_date": first_window.start_date, "end_date": first_window.end_date},
            )
            _print_sample_check(image, SAMPLE_CHECK_BANDS)
        return

    counts = candidate_counts(
        aoi=aoi,
        start_date=START_DATE,
        end_date=END_DATE,
        include_opera_hls_sentinel2=INCLUDE_OPERA_HLS_SENTINEL2,
    ).getInfo()
    print("Source image counts:", counts)

    if PRODUCT_MODE == "monthly":
        image = build_monthly_product(
            aoi=aoi,
            start_date=START_DATE,
            end_date=END_DATE,
            config=config,
        )
        image = add_encoded_summary_band(image)
        export_bands = export_bands_for_profile(
            product_mode="monthly",
            output_profile=OUTPUT_PROFILE,
        )
        metadata_keys = [
            "approach3_mode",
            "period_start",
            "period_end",
            "monthly_reduce_method",
            "dynamic_world_count",
            "hls_count",
            "s1_count",
        ]
    elif PRODUCT_MODE == "acquisition":
        anchor_region = _sample_region() if ACQUISITION_ANCHOR_USE_SAMPLE_REGION else aoi
        if ACQUISITION_ANCHOR_USE_SAMPLE_REGION:
            anchor_count = dynamic_world_collection(
                anchor_region,
                START_DATE,
                END_DATE,
            ).size().getInfo()
            print(
                "Acquisition anchor Dynamic World count in sample region:",
                anchor_count,
            )
        else:
            anchor_count = counts["dynamic_world"]

        if anchor_count == 0:
            raise ValueError(
                "No Dynamic World image is available for the acquisition prototype. "
                "Try a different date window or sample point."
            )
        anchor = first_dynamic_world_image(
            aoi=anchor_region,
            start_date=START_DATE,
            end_date=END_DATE,
        )
        image = build_acquisition_product(anchor, aoi=aoi, config=config)
        image = add_encoded_summary_band(image)
        export_bands = export_bands_for_profile(
            product_mode="acquisition",
            output_profile=OUTPUT_PROFILE,
        )
        metadata_keys = [
            "approach3_mode",
            "anchor_date",
            "hls_candidate_count",
            "s1_candidate_count",
            "dynamic_world_source_id",
        ]
    else:
        raise ValueError('PRODUCT_MODE must be "monthly", "acquisition", or "monthly_batch".')

    print("Product metadata:", image.toDictionary(metadata_keys).getInfo())
    print("Export bands:", export_bands)
    export_label = EXPORT_LABEL or default_export_label(
        product_mode=PRODUCT_MODE,
        start_date=START_DATE,
        end_date=END_DATE,
        hybas_id=HYBAS_ID,
    )
    print("Export label:", export_label)
    _print_sample_check(image, SAMPLE_CHECK_BANDS)

    _start_exports_for_image(
        image=image,
        aoi=aoi,
        grid=grid,
        tile_config=tile_config,
        label=export_label,
        bands=export_bands,
        max_tasks=MAX_TILES_TO_EXPORT if tile_config.enabled else 1,
    )


if __name__ == "__main__":
    main()
