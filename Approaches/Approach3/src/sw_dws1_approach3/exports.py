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
    scale_m: int = 30
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
