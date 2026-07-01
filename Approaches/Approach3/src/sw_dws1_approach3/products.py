"""Prototype product builders for the Approach3 hierarchy."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import ee

from .aoi import DEFAULT_TANGANYIKA_HYBAS_ID, HYDROBASINS_LEVEL4_COLLECTION, basin_aoi
from .datasets import (
    DynamicWorldThresholds,
    SourceBit,
    SourceCode,
    SourceRank,
    GapStatus,
    compose_normalized_source,
    empty_normalized_image,
    dynamic_world_collection,
    merge_priority_sources,
    normalize_dynamic_world_image,
    normalize_opera_hls_image,
    normalize_opera_s1_image,
    opera_dswx_hls_collection,
    opera_dswx_s1_collection,
)


MONTHLY_SOURCE_DATE_BANDS = ["source_first_yyyymmdd", "source_last_yyyymmdd"]
MONTHLY_DIAGNOSTIC_BANDS = [
    "obs_count",
    "valid_count",
    "open_count",
    "inundated_or_partial_count",
]


@dataclass(frozen=True)
class PairingConfig:
    """Optional pairing settings for acquisition-date products."""

    hls_pair_window_days: int = 1
    s1_pair_window_days: int = 3
    include_opera_hls_sentinel2: bool = False


@dataclass(frozen=True)
class ProductConfig:
    """Optional processing settings shared by prototype product builders."""

    thresholds: DynamicWorldThresholds = field(default_factory=DynamicWorldThresholds)
    pairing: PairingConfig = field(default_factory=PairingConfig)


def tanganyika_basin_aoi(hybas_id: int = DEFAULT_TANGANYIKA_HYBAS_ID) -> ee.Geometry:
    """Return the HydroBASINS level-4 Tanganyika AOI used by the JS baseline."""
    return basin_aoi(hybas_id)


def candidate_counts(
    *,
    aoi: ee.Geometry,
    start_date: str,
    end_date: str,
    include_opera_hls_sentinel2: bool = False,
) -> ee.Dictionary:
    """Return image counts for the three source collections in a period."""
    dw = dynamic_world_collection(aoi, start_date, end_date)
    hls = opera_dswx_hls_collection(
        aoi,
        start_date,
        end_date,
        include_sentinel2=include_opera_hls_sentinel2,
    )
    s1 = opera_dswx_s1_collection(aoi, start_date, end_date)
    return ee.Dictionary(
        {
            "dynamic_world": dw.size(),
            "opera_hls": hls.size(),
            "opera_s1": s1.size(),
        }
    )


def hls_source_bit(include_opera_hls_sentinel2: bool) -> int:
    """Return the HLS diagnostic source bit for the configured HLS stream."""
    if include_opera_hls_sentinel2:
        return SourceBit.HLS_MIXED_VALID
    return SourceBit.HLS_LANDSAT_VALID


def nearest_collection_by_time(
    collection: ee.ImageCollection,
    target_date: ee.Date | str,
    window_days: int,
) -> ee.ImageCollection:
    """Return images within a time window, sorted by absolute time delta."""
    target = ee.Date(target_date)
    target_millis = target.millis()
    windowed = collection.filterDate(
        target.advance(-window_days, "day"),
        target.advance(window_days, "day"),
    )

    def add_delta(image: ee.Image) -> ee.Image:
        delta = ee.Number(image.get("system:time_start")).subtract(target_millis).abs()
        return image.set("approach3_time_delta_ms", delta)

    return ee.ImageCollection(windowed.map(add_delta)).sort("approach3_time_delta_ms")


def normalize_first_or_empty(
    collection: ee.ImageCollection,
    normalizer: Callable[[ee.Image], ee.Image],
) -> ee.Image:
    """Normalize the first image in a collection, or return an empty source."""
    normalized = ee.ImageCollection(collection.map(lambda image: normalizer(ee.Image(image))))
    template = empty_normalized_image().set("approach3_time_delta_ms", 1e30)
    return ee.Image(
        _with_template_image(normalized, template).sort("approach3_time_delta_ms").first()
    )


def build_acquisition_product(
    dynamic_world_image: ee.Image,
    *,
    aoi: ee.Geometry,
    config: ProductConfig = ProductConfig(),
) -> ee.Image:
    """Build one strict-priority product anchored on a Dynamic World image."""
    anchor_date = ee.Date(dynamic_world_image.get("system:time_start"))
    anchor_footprint = dynamic_world_image.geometry()
    pairing = config.pairing

    hls_candidates = nearest_collection_by_time(
        opera_dswx_hls_collection(
            anchor_footprint,
            include_sentinel2=pairing.include_opera_hls_sentinel2,
        ),
        anchor_date,
        pairing.hls_pair_window_days,
    )
    s1_candidates = nearest_collection_by_time(
        opera_dswx_s1_collection(anchor_footprint),
        anchor_date,
        pairing.s1_pair_window_days,
    )
    hls_bit = hls_source_bit(pairing.include_opera_hls_sentinel2)

    dynamic_world = normalize_dynamic_world_image(dynamic_world_image, config.thresholds)
    hls = normalize_first_or_empty(
        hls_candidates,
        lambda image: normalize_opera_hls_image(image, source_bit=hls_bit),
    )
    s1 = normalize_first_or_empty(s1_candidates, normalize_opera_s1_image)

    return (
        merge_priority_sources(dynamic_world, hls, s1)
        .clip(aoi)
        .set(
            {
                "approach3_mode": "acquisition",
                "anchor_date": anchor_date.format("YYYY-MM-dd"),
                "hls_pair_window_days": pairing.hls_pair_window_days,
                "s1_pair_window_days": pairing.s1_pair_window_days,
                "include_opera_hls_sentinel2": pairing.include_opera_hls_sentinel2,
                "hls_candidate_count": hls_candidates.size(),
                "s1_candidate_count": s1_candidates.size(),
                "dynamic_world_source_id": dynamic_world_image.get("system:index"),
            }
        )
    )


def build_monthly_product(
    *,
    aoi: ee.Geometry,
    start_date: str,
    end_date: str,
    config: ProductConfig = ProductConfig(),
) -> ee.Image:
    """Build one monthly strict-priority product for a calendar-like period."""
    pairing = config.pairing

    dw_collection = dynamic_world_collection(aoi, start_date, end_date)
    hls_collection = opera_dswx_hls_collection(
        aoi,
        start_date,
        end_date,
        include_sentinel2=pairing.include_opera_hls_sentinel2,
    )
    s1_collection = opera_dswx_s1_collection(aoi, start_date, end_date)

    dw = aggregate_dynamic_world_monthly(dw_collection, config.thresholds)
    hls_bit = hls_source_bit(pairing.include_opera_hls_sentinel2)
    hls = aggregate_normalized_monthly(
        hls_collection,
        normalize_opera_hls_image,
        source_rank=SourceRank.OPERA_DSWX_HLS,
        source_bit=hls_bit,
        gap_status=GapStatus.FILLED_BY_HLS,
        open_code=SourceCode.HLS_OPEN_WATER,
        inundated_code=SourceCode.HLS_PARTIAL_SURFACE_WATER,
        both_code=SourceCode.HLS_PARTIAL_SURFACE_WATER,
        nonwater_code=SourceCode.HLS_VALID_NONWATER,
    )
    s1 = aggregate_normalized_monthly(
        s1_collection,
        normalize_opera_s1_image,
        source_rank=SourceRank.OPERA_DSWX_S1,
        source_bit=SourceBit.S1_VALID,
        gap_status=GapStatus.FILLED_BY_S1,
        open_code=SourceCode.S1_OPEN_WATER,
        inundated_code=SourceCode.S1_INUNDATED_VEGETATION,
        both_code=SourceCode.S1_INUNDATED_VEGETATION,
        nonwater_code=SourceCode.S1_VALID_NONWATER,
    )

    merged = merge_priority_sources(dw, hls, s1)
    source_first = _monthly_selected_date(merged, dw, hls, s1, "source_date_yyyymmdd")
    source_last = _monthly_selected_date(merged, dw, hls, s1, "source_last_yyyymmdd")

    diagnostics = ee.Image.cat(
        [
            _prefixed_monthly_diagnostics(dw, "dw"),
            _prefixed_monthly_diagnostics(hls, "hls"),
            _prefixed_monthly_diagnostics(s1, "s1"),
        ]
    )

    return (
        merged.addBands(source_first.rename("source_first_yyyymmdd"))
        .addBands(source_last.rename("source_last_yyyymmdd"))
        .addBands(diagnostics)
        .clip(aoi)
        .set(
            {
                "approach3_mode": "monthly",
                "period_start": start_date,
                "period_end": end_date,
                "monthly_reduce_method": "water_if_any_valid_water",
                "include_opera_hls_sentinel2": pairing.include_opera_hls_sentinel2,
                "dynamic_world_count": dw_collection.size(),
                "hls_count": hls_collection.size(),
                "s1_count": s1_collection.size(),
            }
        )
    )


def aggregate_dynamic_world_monthly(
    collection: ee.ImageCollection,
    thresholds: DynamicWorldThresholds = DynamicWorldThresholds(),
) -> ee.Image:
    """Aggregate Dynamic World over a period using the JS baseline semantics."""
    source_collection = _with_template_image(collection, _empty_dynamic_world_observation())
    normalized = _with_template_image(
        ee.ImageCollection(
            collection.map(lambda image: normalize_dynamic_world_image(ee.Image(image), thresholds))
        ),
        empty_normalized_image(),
    )
    obs_count = source_collection.select("water").count().unmask(0).rename("obs_count").toUint16()
    open_count = normalized.select("open_water").sum().unmask(0).rename("open_count").toUint16()
    valid_count = normalized.select("valid").sum().unmask(0).rename("valid_count").toUint16()
    inundated_count = (
        normalized.select("inundated_or_partial")
        .sum()
        .unmask(0)
        .rename("inundated_or_partial_count")
        .toUint16()
    )

    open_water = open_count.gt(0).unmask(0)
    inundated_or_partial = (
        source_collection.select("flooded_vegetation")
        .mean()
        .gt(thresholds.flooded_vegetation)
        .unmask(0)
    )
    valid = open_water.Or(inundated_or_partial).Or(valid_count.gt(0)).unmask(0)
    valid_nonwater = valid.And(open_water.Not()).And(inundated_or_partial.Not())

    first_date = normalized.select("source_date_yyyymmdd").min()
    last_date = normalized.select("source_date_yyyymmdd").max()
    first_doy = normalized.select("source_doy").min()

    source = compose_normalized_source(
        open_water=open_water,
        inundated_or_partial=inundated_or_partial,
        valid_nonwater=valid_nonwater,
        valid=valid,
        source_rank=SourceRank.DYNAMIC_WORLD,
        source_bit=SourceBit.DYNAMIC_WORLD_VALID,
        gap_status=GapStatus.RESOLVED_BY_DW,
        open_code=SourceCode.DW_OPEN_WATER,
        inundated_code=SourceCode.DW_FLOODED_VEGETATION,
        both_code=SourceCode.DW_BOTH_WATER_TYPES,
        nonwater_code=SourceCode.DW_VALID_NONWATER,
        source_date_yyyymmdd=first_date,
        source_doy=first_doy,
    )
    return source.addBands(last_date.rename("source_last_yyyymmdd").toInt32()).addBands(
        ee.Image.cat([obs_count, valid_count, open_count, inundated_count])
    )


def aggregate_normalized_monthly(
    collection: ee.ImageCollection,
    normalizer: Callable[[ee.Image], ee.Image],
    *,
    source_rank: int,
    source_bit: int,
    gap_status: int,
    open_code: int,
    inundated_code: int,
    both_code: int,
    nonwater_code: int,
) -> ee.Image:
    """Aggregate an OPERA source over a period as water observed at least once."""
    source_collection = _with_template_image(collection, _empty_opera_observation())
    normalized = _with_template_image(
        ee.ImageCollection(collection.map(lambda image: normalizer(ee.Image(image)))),
        empty_normalized_image(),
    )
    obs_count = (
        source_collection.select("WTR_Water_classification")
        .count()
        .unmask(0)
        .rename("obs_count")
        .toUint16()
    )
    valid_count = normalized.select("valid").sum().unmask(0).rename("valid_count").toUint16()
    open_count = normalized.select("open_water").sum().unmask(0).rename("open_count").toUint16()
    inundated_count = (
        normalized.select("inundated_or_partial")
        .sum()
        .unmask(0)
        .rename("inundated_or_partial_count")
        .toUint16()
    )

    open_water = open_count.gt(0).unmask(0)
    inundated_or_partial = inundated_count.gt(0).unmask(0)
    valid = valid_count.gt(0).unmask(0)
    valid_nonwater = valid.And(open_water.Not()).And(inundated_or_partial.Not())

    source = compose_normalized_source(
        open_water=open_water,
        inundated_or_partial=inundated_or_partial,
        valid_nonwater=valid_nonwater,
        valid=valid,
        source_rank=source_rank,
        source_bit=source_bit,
        gap_status=gap_status,
        open_code=open_code,
        inundated_code=inundated_code,
        both_code=both_code,
        nonwater_code=nonwater_code,
        source_date_yyyymmdd=normalized.select("source_date_yyyymmdd").min(),
        source_doy=normalized.select("source_doy").min(),
    )
    return source.addBands(
        normalized.select("source_date_yyyymmdd").max().rename("source_last_yyyymmdd").toInt32()
    ).addBands(ee.Image.cat([obs_count, valid_count, open_count, inundated_count]))


def first_dynamic_world_image(
    *,
    aoi: ee.Geometry,
    start_date: str,
    end_date: str,
) -> ee.Image:
    """Return the first Dynamic World image in a period.

    Caller should check `candidate_counts(...).get("dynamic_world")` before
    evaluating this image in Earth Engine.
    """
    return ee.Image(
        dynamic_world_collection(aoi, start_date, end_date)
        .sort("system:time_start")
        .first()
    )


def _with_template_image(collection: ee.ImageCollection, image: ee.Image) -> ee.ImageCollection:
    return ee.ImageCollection(collection).merge(ee.ImageCollection([image]))


def _empty_dynamic_world_observation() -> ee.Image:
    masked_zero = ee.Image.constant(0).updateMask(ee.Image.constant(0))
    return ee.Image.cat(
        [
            masked_zero.rename("water").toFloat(),
            masked_zero.rename("flooded_vegetation").toFloat(),
        ]
    )


def _empty_opera_observation() -> ee.Image:
    masked_zero = ee.Image.constant(0).updateMask(ee.Image.constant(0))
    return masked_zero.rename("WTR_Water_classification").toUint16()


def _monthly_selected_date(
    merged: ee.Image,
    dw: ee.Image,
    hls: ee.Image,
    s1: ee.Image,
    band_name: str,
) -> ee.Image:
    rank = merged.select("source_rank")
    valid = merged.select("valid_final").eq(1)
    return (
        ee.Image.constant(0)
        .where(rank.eq(SourceRank.DYNAMIC_WORLD), dw.select(band_name))
        .where(rank.eq(SourceRank.OPERA_DSWX_HLS), hls.select(band_name))
        .where(rank.eq(SourceRank.OPERA_DSWX_S1), s1.select(band_name))
        .toInt32()
        .updateMask(valid)
    )


def _prefixed_monthly_diagnostics(image: ee.Image, prefix: str) -> ee.Image:
    return image.select(
        MONTHLY_DIAGNOSTIC_BANDS,
        [f"{prefix}_{band}" for band in MONTHLY_DIAGNOSTIC_BANDS],
    )
