"""Run a small Approach3 Earth Engine prototype from the project environment.

This script is intentionally conservative. It prints source counts and product
metadata by default. It starts an Earth Engine export only when START_EXPORT is
set to True and EXPORT_ASSET_ROOT is provided.
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
HYBAS_ID = _env_int("SW_DWS1_HYBAS_ID", 1041259950)
START_DATE = _env_str("SW_DWS1_START_DATE", "2025-01-01")
END_DATE = _env_str("SW_DWS1_END_DATE", "2025-02-01")  # Earth Engine filterDate end is exclusive.

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
SAMPLE_SCALE_M = _env_int("SW_DWS1_SAMPLE_SCALE_M", 30)
SAMPLE_CHECK_BANDS = ["water", "water_class", "source_rank", "source_bits"]

START_EXPORT = _env_bool("SW_DWS1_START_EXPORT", False)
EXPORT_ASSET_ROOT = _env_optional_str(
    "SW_DWS1_EXPORT_ASSET_ROOT",
    None,
)  # Example: "projects/your-project/assets/SW_DWS1/Approach3"
EXPORT_LABEL = _env_optional_str(
    "SW_DWS1_EXPORT_LABEL",
    None,
)  # None uses a stable default label from PRODUCT_MODE, dates, and HYBAS_ID.
EXPORT_SCALE_M = _env_int("SW_DWS1_EXPORT_SCALE_M", 30)
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


def main() -> None:
    _add_src_to_path()

    import ee

    from sw_dws1_approach3.datasets import DynamicWorldThresholds, dynamic_world_collection
    from sw_dws1_approach3.exports import (
        ACQUISITION_EXPORT_BANDS,
        MONTHLY_EXPORT_BANDS,
        ExportConfig,
        export_image_to_asset,
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
        tanganyika_basin_aoi,
    )

    if EE_PROJECT == "your-google-cloud-project-id":
        raise ValueError(
            "Set SW_DWS1_EE_PROJECT in your shell, or edit EE_PROJECT at the top "
            "of this script before running it."
        )
    validate_date_window(START_DATE, END_DATE)

    initialize_earth_engine(project=EE_PROJECT)
    aoi = tanganyika_basin_aoi(HYBAS_ID)
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
        export_config = ExportConfig(
            asset_root=EXPORT_ASSET_ROOT,
            scale_m=EXPORT_SCALE_M,
            crs=EXPORT_CRS,
            max_pixels=EXPORT_MAX_PIXELS,
        )
        started = 0
        for window in monthly_windows(START_DATE, END_DATE):
            export_label = EXPORT_LABEL or default_export_label(
                product_mode="monthly",
                start_date=window.start_date,
                end_date=window.end_date,
                hybas_id=HYBAS_ID,
            )
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
                task = export_image_to_asset(
                    image=image,
                    region=aoi,
                    label=export_label,
                    config=export_config,
                    bands=MONTHLY_EXPORT_BANDS,
                )
                task.start()
                started += 1
                print("Started Earth Engine export task:", task.id)

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
        export_bands = MONTHLY_EXPORT_BANDS
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
        export_bands = ACQUISITION_EXPORT_BANDS
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

    if START_EXPORT:
        export_config = ExportConfig(
            asset_root=EXPORT_ASSET_ROOT,
            scale_m=EXPORT_SCALE_M,
            crs=EXPORT_CRS,
            max_pixels=EXPORT_MAX_PIXELS,
        )
        task = export_image_to_asset(
            image=image,
            region=aoi,
            label=export_label,
            config=export_config,
            bands=export_bands,
        )
        task.start()
        print("Started Earth Engine export task:", task.id)
    else:
        print("START_EXPORT is False. No Earth Engine export task was started.")


if __name__ == "__main__":
    main()
