"""SWOT helpers for Approach3 comparison workflows."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import ee

from .datasets import JRC_GLOBAL_SURFACE_WATER


DEFAULT_SWOT_COLLECTION_ASSET = "projects/hardy-tenure-383607/assets/WaterSurface/SWOT_HR100m"
DEFAULT_SWOT_WSE_BAND = "b1"
DEFAULT_SWOT_QUALITY_BAND = "b2"
SWOT_PREPARED_BANDS = ["wse", "wse_qual", "wse_qual_mask"]

SwotQualityMode = Literal["LTE", "EQ", "LIST", "NONE"]


@dataclass(frozen=True)
class SwotQualityConfig:
    """Optional SWOT WSE quality and range filtering settings."""

    mode: SwotQualityMode = "LTE"
    max_value: int = 1
    equal_value: int = 0
    allowed_values: tuple[int, ...] = (0, 1)
    apply_jrc_max_extent_mask: bool = False
    wse_min: float | None = None
    wse_max: float | None = None


def swot_collection(
    *,
    asset: str = DEFAULT_SWOT_COLLECTION_ASSET,
    aoi: ee.Geometry | ee.FeatureCollection | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> ee.ImageCollection:
    """Return a filtered SWOT WSE collection with temporal metadata present."""
    collection = ee.ImageCollection(asset).filter(ee.Filter.notNull(["system:time_start"]))
    if aoi is not None:
        collection = collection.filterBounds(aoi)
    if start_date is not None and end_date is not None:
        collection = collection.filterDate(start_date, end_date)
    elif start_date is not None or end_date is not None:
        raise ValueError("Provide both start_date and end_date, or neither.")
    return collection


def prepare_swot_collection(
    collection: ee.ImageCollection,
    *,
    config: SwotQualityConfig = SwotQualityConfig(),
    wse_band: str = DEFAULT_SWOT_WSE_BAND,
    quality_band: str = DEFAULT_SWOT_QUALITY_BAND,
) -> ee.ImageCollection:
    """Prepare a SWOT collection for comparison with Approach3 products."""
    return ee.ImageCollection(
        collection.map(
            lambda image: prepare_swot_image(
                ee.Image(image),
                config=config,
                wse_band=wse_band,
                quality_band=quality_band,
            )
        )
    )


def prepare_swot_image(
    image: ee.Image,
    *,
    config: SwotQualityConfig = SwotQualityConfig(),
    wse_band: str = DEFAULT_SWOT_WSE_BAND,
    quality_band: str = DEFAULT_SWOT_QUALITY_BAND,
) -> ee.Image:
    """Rename, quality-mask, and tag one SWOT WSE image."""
    wse = image.select(wse_band).rename("wse")
    wse_qual = image.select(quality_band).rename("wse_qual")

    if config.apply_jrc_max_extent_mask:
        jrc_mask = jrc_max_extent_mask()
        wse = wse.updateMask(jrc_mask)
        wse_qual = wse_qual.updateMask(jrc_mask)

    quality_mask = build_wse_quality_mask(wse_qual, config)
    wse = wse.updateMask(quality_mask)

    if config.wse_min is not None:
        wse = wse.updateMask(wse.gte(config.wse_min))
    if config.wse_max is not None:
        wse = wse.updateMask(wse.lte(config.wse_max))

    date = ee.Date(image.get("system:time_start"))
    return (
        wse.addBands(wse_qual)
        .addBands(quality_mask)
        .copyProperties(image, image.propertyNames())
        .set(
            {
                "year": date.get("year"),
                "month": date.get("month"),
                "year_month": date.format("YYYY-MM"),
                "swot_date_yyyymmdd": date.format("YYYYMMdd"),
            }
        )
    )


def build_wse_quality_mask(quality: ee.Image, config: SwotQualityConfig) -> ee.Image:
    """Build a SWOT WSE quality mask."""
    mode = config.mode.upper()
    if mode == "LTE":
        mask = quality.lte(config.max_value)
    elif mode == "EQ":
        mask = quality.eq(config.equal_value)
    elif mode == "LIST":
        mask = ee.Image.constant(0)
        for value in config.allowed_values:
            mask = mask.Or(quality.eq(value))
    elif mode == "NONE":
        mask = ee.Image.constant(1)
    else:
        raise ValueError('SWOT quality mode must be "LTE", "EQ", "LIST", or "NONE".')
    return mask.rename("wse_qual_mask")


def jrc_max_extent_mask() -> ee.Image:
    """Return JRC maximum water extent as a self-masked Boolean image."""
    return (
        ee.Image(JRC_GLOBAL_SURFACE_WATER)
        .select("max_extent")
        .eq(1)
        .selfMask()
        .rename("jrc_max_extent")
    )


def swot_for_period(
    *,
    aoi: ee.Geometry,
    start_date: str,
    end_date: str,
    config: SwotQualityConfig = SwotQualityConfig(),
    asset: str = DEFAULT_SWOT_COLLECTION_ASSET,
) -> ee.ImageCollection:
    """Load and prepare SWOT images for an Approach3 period window."""
    return prepare_swot_collection(
        swot_collection(asset=asset, aoi=aoi, start_date=start_date, end_date=end_date),
        config=config,
    )


def swot_wse_summary(collection: ee.ImageCollection) -> ee.Image:
    """Return compact WSE summary bands for a prepared SWOT collection."""
    reducer = (
        ee.Reducer.mean()
        .combine(reducer2=ee.Reducer.median(), sharedInputs=True)
        .combine(reducer2=ee.Reducer.minMax(), sharedInputs=True)
        .combine(reducer2=ee.Reducer.count(), sharedInputs=True)
    )
    summary = collection.select("wse").reduce(reducer)
    wse_range = summary.select("wse_max").subtract(summary.select("wse_min")).rename("wse_range")
    return summary.addBands(wse_range)
