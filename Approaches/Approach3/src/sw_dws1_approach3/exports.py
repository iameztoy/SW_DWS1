"""Export helpers for Approach3 Earth Engine products."""

from __future__ import annotations

from dataclasses import dataclass
import re

import ee


ACQUISITION_EXPORT_BANDS = [
    "water",
    "water_class",
    "source",
    "source_rank",
    "source_date_yyyymmdd",
    "source_doy",
    "gap_status",
    "valid_final",
    "source_bits",
]

ENCODED_SUMMARY_BAND = "encoded_class_source_date"
ENCODED_EXPORT_BANDS = [ENCODED_SUMMARY_BAND]

MONTHLY_EXPORT_BANDS = ACQUISITION_EXPORT_BANDS + [
    "source_first_yyyymmdd",
    "source_last_yyyymmdd",
    "dw_obs_count",
    "dw_valid_count",
    "dw_open_count",
    "dw_inundated_or_partial_count",
    "hls_obs_count",
    "hls_valid_count",
    "hls_open_count",
    "hls_inundated_or_partial_count",
    "s1_obs_count",
    "s1_valid_count",
    "s1_open_count",
    "s1_inundated_or_partial_count",
]


@dataclass(frozen=True)
class ExportConfig:
    """Optional raster export settings."""

    asset_root: str | None = None
    description_prefix: str = "approach3"
    scale_m: int = 10
    crs: str = "EPSG:4326"
    max_pixels: float = 1e13
    pyramiding_policy: str = "mode"


def safe_task_label(value: str) -> str:
    """Return a conservative Earth Engine task/asset label component."""
    label = re.sub(r"[^A-Za-z0-9_-]+", "_", value.strip())
    label = re.sub(r"_+", "_", label).strip("_")
    if not label:
        raise ValueError("Export label cannot be empty.")
    return label


def build_asset_id(asset_root: str, label: str) -> str:
    """Build an asset ID from a root folder and a safe label."""
    return f"{asset_root.rstrip('/')}/{safe_task_label(label)}"


def build_task_description(prefix: str, label: str) -> str:
    """Build an Earth Engine task description."""
    return safe_task_label(f"{prefix}_{label}")


def add_encoded_summary_band(
    image: ee.Image,
    *,
    date_band: str = "source_date_yyyymmdd",
    band_name: str = ENCODED_SUMMARY_BAND,
) -> ee.Image:
    """Add a compact integer band encoding class, source, and source date.

    The encoded value is `CSSYYYYMMDD`:
    - `C`: class code (`1=open water`, `2=inundated/partial`, `3=both`, `4=valid non-water`,
      `0=unresolved/no source`);
    - `S`: source rank (`1=Dynamic World`, `2=OPERA HLS`, `3=OPERA S1`, `0=no source`);
    - `YYYYMMDD`: source date from `date_band`.

    The default multi-band export remains the scientific product. This encoded
    band is a convenience output for compact QA or systems that strongly prefer
    one-band categorical rasters.
    """
    water_class = image.select("water_class").unmask(0)
    valid = image.select("valid_final").unmask(0).eq(1)
    class_digit = (
        ee.Image.constant(0)
        .where(valid.And(water_class.eq(1)), 1)
        .where(valid.And(water_class.eq(2)), 2)
        .where(valid.And(water_class.eq(3)), 3)
        .where(valid.And(water_class.eq(0)), 4)
        .toInt64()
    )
    source_digit = image.select("source_rank").unmask(0).toInt64()
    date_value = image.select(date_band).unmask(0).toInt64()
    encoded = (
        class_digit.multiply(1_000_000_000)
        .add(source_digit.multiply(100_000_000))
        .add(date_value)
        .rename(band_name)
        .toInt64()
    )
    return image.addBands(encoded)


def export_bands_for_profile(
    *,
    product_mode: str,
    output_profile: str,
) -> list[str]:
    """Return export bands for a product mode and output profile."""
    if product_mode == "acquisition":
        standard_bands = ACQUISITION_EXPORT_BANDS
    elif product_mode in {"monthly", "monthly_batch"}:
        standard_bands = MONTHLY_EXPORT_BANDS
    else:
        raise ValueError('product_mode must be "acquisition", "monthly", or "monthly_batch".')

    if output_profile == "standard":
        return standard_bands
    if output_profile == "encoded":
        return ENCODED_EXPORT_BANDS
    if output_profile == "standard_plus_encoded":
        return standard_bands + ENCODED_EXPORT_BANDS
    raise ValueError('output_profile must be "standard", "encoded", or "standard_plus_encoded".')


def export_image_to_asset(
    *,
    image: ee.Image,
    region: ee.Geometry,
    label: str,
    config: ExportConfig,
    bands: list[str],
) -> ee.batch.Task:
    """Create, but do not start, an Earth Engine image-to-asset export task."""
    if not config.asset_root:
        raise ValueError("ExportConfig.asset_root is required for asset exports.")

    return ee.batch.Export.image.toAsset(
        image=image.select(bands),
        description=build_task_description(config.description_prefix, label),
        assetId=build_asset_id(config.asset_root, label),
        region=region,
        scale=config.scale_m,
        crs=config.crs,
        maxPixels=config.max_pixels,
        pyramidingPolicy={".default": config.pyramiding_policy},
    )
