from __future__ import annotations

import sys
from pathlib import Path


APPROACH3_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APPROACH3_ROOT / "src"))

from sw_dws1_approach3 import datasets  # noqa: E402
from sw_dws1_approach3 import exports  # noqa: E402
from sw_dws1_approach3 import periods  # noqa: E402
from sw_dws1_approach3 import products  # noqa: E402
from sw_dws1_approach3 import swot  # noqa: E402


def test_collection_ids_are_expected() -> None:
    assert datasets.DYNAMIC_WORLD_COLLECTION == "GOOGLE/DYNAMICWORLD/V1"
    assert datasets.OPERA_DSWX_HLS_COLLECTION == "OPERA/DSWX/L3_V1/HLS"
    assert datasets.OPERA_DSWX_S1_COLLECTION == "OPERA/DSWX/L3_V1/S1"
    assert datasets.JRC_GLOBAL_SURFACE_WATER == "JRC/GSW1_4/GlobalSurfaceWater"


def test_source_codes_are_unique_except_no_source() -> None:
    codes = [
        datasets.SourceCode.DW_OPEN_WATER,
        datasets.SourceCode.DW_FLOODED_VEGETATION,
        datasets.SourceCode.DW_BOTH_WATER_TYPES,
        datasets.SourceCode.HLS_OPEN_WATER,
        datasets.SourceCode.HLS_PARTIAL_SURFACE_WATER,
        datasets.SourceCode.S1_OPEN_WATER,
        datasets.SourceCode.S1_INUNDATED_VEGETATION,
        datasets.SourceCode.DW_VALID_NONWATER,
        datasets.SourceCode.HLS_VALID_NONWATER,
        datasets.SourceCode.S1_VALID_NONWATER,
    ]
    assert len(codes) == len(set(codes))


def test_source_bit_values() -> None:
    assert datasets.SourceBit.DYNAMIC_WORLD_VALID == 1
    assert datasets.SourceBit.HLS_LANDSAT_VALID == 2
    assert datasets.SourceBit.HLS_SENTINEL2_DIAGNOSTIC_VALID == 4
    assert (
        datasets.SourceBit.HLS_MIXED_VALID
        == datasets.SourceBit.HLS_LANDSAT_VALID
        | datasets.SourceBit.HLS_SENTINEL2_DIAGNOSTIC_VALID
    )
    assert datasets.SourceBit.S1_VALID == 8


def test_normalized_band_contract() -> None:
    assert datasets.DECISION_BANDS == [
        "water",
        "water_class",
        "source",
        "source_rank",
        "source_date_yyyymmdd",
        "source_doy",
        "gap_status",
    ]
    assert datasets.COMPONENT_BANDS == ["open_water", "inundated_or_partial"]
    assert (
        datasets.NORMALIZED_BANDS
        == datasets.COMPONENT_BANDS + datasets.DECISION_BANDS + ["valid", "source_bits"]
    )


def test_default_pairing_config_is_strict() -> None:
    config = products.PairingConfig()
    assert config.hls_pair_window_days == 1
    assert config.s1_pair_window_days == 3
    assert config.include_opera_hls_sentinel2 is False


def test_hls_source_bit_helper() -> None:
    assert products.hls_source_bit(False) == datasets.SourceBit.HLS_LANDSAT_VALID
    assert products.hls_source_bit(True) == datasets.SourceBit.HLS_MIXED_VALID


def test_tanganyika_baseline_constants() -> None:
    assert products.HYDROBASINS_LEVEL4_COLLECTION == "WWF/HydroSHEDS/v1/Basins/hybas_4"
    assert products.DEFAULT_TANGANYIKA_HYBAS_ID == 1041259950


def test_monthly_band_contract() -> None:
    assert products.MONTHLY_SOURCE_DATE_BANDS == [
        "source_first_yyyymmdd",
        "source_last_yyyymmdd",
    ]
    assert products.MONTHLY_DIAGNOSTIC_BANDS == [
        "obs_count",
        "valid_count",
        "open_count",
        "inundated_or_partial_count",
    ]


def test_export_band_contracts() -> None:
    assert "source_date_yyyymmdd" in exports.ACQUISITION_EXPORT_BANDS
    assert "source_first_yyyymmdd" in exports.MONTHLY_EXPORT_BANDS
    assert "source_last_yyyymmdd" in exports.MONTHLY_EXPORT_BANDS
    assert set(exports.ACQUISITION_EXPORT_BANDS).issubset(exports.MONTHLY_EXPORT_BANDS)


def test_export_label_sanitizing() -> None:
    assert exports.safe_task_label("Approach3 2025/01 Tanganyika") == "Approach3_2025_01_Tanganyika"
    assert (
        exports.build_asset_id("projects/example/assets/root/", "Approach3 2025/01")
        == "projects/example/assets/root/Approach3_2025_01"
    )


def test_server_side_empty_sources_use_templates() -> None:
    product_source = (APPROACH3_ROOT / "src" / "sw_dws1_approach3" / "products.py").read_text()
    assert "_with_template_image" in product_source
    assert "ee.Algorithms.If" not in product_source


def test_acquisition_pairing_uses_anchor_footprint() -> None:
    product_source = (APPROACH3_ROOT / "src" / "sw_dws1_approach3" / "products.py").read_text()
    assert "anchor_footprint = dynamic_world_image.geometry()" in product_source
    assert "opera_dswx_hls_collection(\n            anchor_footprint" in product_source
    assert "opera_dswx_s1_collection(anchor_footprint)" in product_source


def test_monthly_diagnostic_counts_are_unmasked_to_zero() -> None:
    product_source = (APPROACH3_ROOT / "src" / "sw_dws1_approach3" / "products.py").read_text()
    assert '.count().unmask(0).rename("obs_count")' in product_source
    assert '.sum().unmask(0).rename("valid_count")' in product_source
    assert '.sum().unmask(0).rename("open_count")' in product_source
    assert '.unmask(0)\n        .rename("inundated_or_partial_count")' in product_source


def test_example_script_exports_are_opt_in() -> None:
    script_source = (APPROACH3_ROOT / "scripts" / "run_approach3_example.py").read_text()
    assert '_env_str("SW_DWS1_EE_PROJECT", "your-google-cloud-project-id")' in script_source
    assert '_env_str("SW_DWS1_PRODUCT_MODE", "monthly")' in script_source
    assert '"SW_DWS1_ACQUISITION_ANCHOR_USE_SAMPLE_REGION"' in script_source
    assert '_env_bool("SW_DWS1_RUN_SAMPLE_CHECK", True)' in script_source
    assert '_env_bool("SW_DWS1_START_EXPORT", False)' in script_source
    assert '"SW_DWS1_EXPORT_ASSET_ROOT"' in script_source
    assert '"SW_DWS1_EXPORT_LABEL"' in script_source
    assert '_env_int("SW_DWS1_MAX_BATCH_EXPORT_TASKS", 1)' in script_source
    assert '"monthly_batch"' in script_source


def test_monthly_windows_split_partial_months() -> None:
    windows = periods.monthly_windows("2025-01-15", "2025-04-10")
    assert windows == [
        periods.PeriodWindow("2025-01-15", "2025-02-01", "2025_01"),
        periods.PeriodWindow("2025-02-01", "2025-03-01", "2025_02"),
        periods.PeriodWindow("2025-03-01", "2025-04-01", "2025_03"),
        periods.PeriodWindow("2025-04-01", "2025-04-10", "2025_04"),
    ]


def test_default_export_label() -> None:
    assert (
        periods.default_export_label(
            product_mode="monthly",
            start_date="2025-01-01",
            end_date="2025-02-01",
            hybas_id=1041259950,
        )
        == "approach3_monthly_2025_01_hybas_1041259950"
    )
    assert (
        periods.default_export_label(
            product_mode="acquisition",
            start_date="2025-01-03",
            end_date="2025-01-04",
            hybas_id=1041259950,
        )
        == "approach3_acquisition_2025_01_03_hybas_1041259950"
    )


def test_swot_defaults_match_existing_scripts() -> None:
    assert (
        swot.DEFAULT_SWOT_COLLECTION_ASSET
        == "projects/hardy-tenure-383607/assets/WaterSurface/SWOT_HR100m"
    )
    assert swot.DEFAULT_SWOT_WSE_BAND == "b1"
    assert swot.DEFAULT_SWOT_QUALITY_BAND == "b2"
    assert swot.SWOT_PREPARED_BANDS == ["wse", "wse_qual", "wse_qual_mask"]


def test_swot_quality_config_defaults() -> None:
    config = swot.SwotQualityConfig()
    assert config.mode == "LTE"
    assert config.max_value == 1
    assert config.equal_value == 0
    assert config.allowed_values == (0, 1)
    assert config.apply_jrc_max_extent_mask is False
