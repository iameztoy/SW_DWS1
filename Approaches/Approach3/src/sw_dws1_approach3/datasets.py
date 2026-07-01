"""Dataset constants and source normalizers for Approach3."""

from __future__ import annotations

from dataclasses import dataclass

import ee


DYNAMIC_WORLD_COLLECTION = "GOOGLE/DYNAMICWORLD/V1"
OPERA_DSWX_HLS_COLLECTION = "OPERA/DSWX/L3_V1/HLS"
OPERA_DSWX_S1_COLLECTION = "OPERA/DSWX/L3_V1/S1"
JRC_GLOBAL_SURFACE_WATER = "JRC/GSW1_4/GlobalSurfaceWater"


@dataclass(frozen=True)
class DynamicWorldThresholds:
    """Thresholds matching the current JavaScript baseline defaults."""

    water: float = 0.5
    nonwater: float = 0.05
    flooded_vegetation: float = 0.3


class WaterClass:
    """Common water-class codes."""

    VALID_NONWATER = 0
    OPEN_WATER = 1
    INUNDATED_OR_PARTIAL = 2
    BOTH_WATER_TYPES = 3


class SourceCode:
    """Class-specific source/provenance codes."""

    NO_SOURCE = 0
    DW_OPEN_WATER = 1
    DW_FLOODED_VEGETATION = 2
    DW_BOTH_WATER_TYPES = 3
    HLS_OPEN_WATER = 4
    HLS_PARTIAL_SURFACE_WATER = 5
    S1_OPEN_WATER = 6
    S1_INUNDATED_VEGETATION = 7
    DW_VALID_NONWATER = 8
    HLS_VALID_NONWATER = 9
    S1_VALID_NONWATER = 10


class SourceRank:
    """Hierarchical source rank for selected pixels."""

    DYNAMIC_WORLD = 1
    OPERA_DSWX_HLS = 2
    OPERA_DSWX_S1 = 3


class SourceBit:
    """Diagnostic bitmask values for products with valid observations."""

    DYNAMIC_WORLD_VALID = 1
    HLS_LANDSAT_VALID = 2
    HLS_SENTINEL2_DIAGNOSTIC_VALID = 4
    HLS_MIXED_VALID = 6
    S1_VALID = 8


class GapStatus:
    """Gap-fill status codes."""

    RESOLVED_BY_DW = 0
    FILLED_BY_HLS = 1
    FILLED_BY_S1 = 2
    UNRESOLVED = 3


DECISION_BANDS = [
    "water",
    "water_class",
    "source",
    "source_rank",
    "source_date_yyyymmdd",
    "source_doy",
    "gap_status",
]

COMPONENT_BANDS = ["open_water", "inundated_or_partial"]
NORMALIZED_BANDS = COMPONENT_BANDS + DECISION_BANDS + ["valid", "source_bits"]


def dynamic_world_collection(
    aoi: ee.Geometry | ee.FeatureCollection | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> ee.ImageCollection:
    """Return a filtered Dynamic World collection."""
    return _filtered_collection(DYNAMIC_WORLD_COLLECTION, aoi, start_date, end_date)


def opera_dswx_hls_collection(
    aoi: ee.Geometry | ee.FeatureCollection | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    include_sentinel2: bool = False,
) -> ee.ImageCollection:
    """Return a filtered OPERA DSWx-HLS collection.

    By default this keeps Landsat-derived HLS only. Dynamic World is already
    Sentinel-2-derived, so HLS MSI scenes should not be normal gap-fill inputs.
    """
    collection = _filtered_collection(OPERA_DSWX_HLS_COLLECTION, aoi, start_date, end_date)
    if not include_sentinel2:
        collection = collection.filter(ee.Filter.neq("SENSOR", "MSI"))
    return collection


def opera_dswx_s1_collection(
    aoi: ee.Geometry | ee.FeatureCollection | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> ee.ImageCollection:
    """Return a filtered OPERA DSWx-S1 collection."""
    return _filtered_collection(OPERA_DSWX_S1_COLLECTION, aoi, start_date, end_date)


def normalize_dynamic_world_image(
    image: ee.Image,
    thresholds: DynamicWorldThresholds = DynamicWorldThresholds(),
) -> ee.Image:
    """Normalize one Dynamic World image to the common Approach3 bands."""
    water_probability = image.select("water")
    flooded_probability = image.select("flooded_vegetation")

    open_water = water_probability.gt(thresholds.water)
    inundated = flooded_probability.gt(thresholds.flooded_vegetation)
    valid_nonwater = water_probability.lte(thresholds.nonwater).And(inundated.Not())
    valid = open_water.Or(inundated).Or(valid_nonwater)

    water = open_water.Or(inundated).rename("water").toByte().updateMask(valid)
    water_class = _class_image(open_water, inundated, valid)
    source = _source_image(
        valid_nonwater=valid_nonwater,
        open_water=open_water,
        inundated_or_partial=inundated,
        both_code=SourceCode.DW_BOTH_WATER_TYPES,
        open_code=SourceCode.DW_OPEN_WATER,
        inundated_code=SourceCode.DW_FLOODED_VEGETATION,
        nonwater_code=SourceCode.DW_VALID_NONWATER,
        valid=valid,
    )

    return _add_common_bands(
        image=image,
        bands=[_component_bands(open_water, inundated, valid), water, water_class, source],
        valid=valid,
        source_rank=SourceRank.DYNAMIC_WORLD,
        source_bit=SourceBit.DYNAMIC_WORLD_VALID,
        gap_status=GapStatus.RESOLVED_BY_DW,
    )


def normalize_opera_hls_image(
    image: ee.Image,
    source_bit: int = SourceBit.HLS_LANDSAT_VALID,
) -> ee.Image:
    """Normalize one OPERA DSWx-HLS image to the common Approach3 bands."""
    wtr = image.select("WTR_Water_classification")

    open_water = wtr.eq(1)
    partial = wtr.eq(2)
    valid_nonwater = wtr.eq(0)
    valid = wtr.lt(252)

    water = open_water.Or(partial).rename("water").toByte().updateMask(valid)
    water_class = _class_image(open_water, partial, valid)
    source = _source_image(
        valid_nonwater=valid_nonwater,
        open_water=open_water,
        inundated_or_partial=partial,
        both_code=SourceCode.HLS_PARTIAL_SURFACE_WATER,
        open_code=SourceCode.HLS_OPEN_WATER,
        inundated_code=SourceCode.HLS_PARTIAL_SURFACE_WATER,
        nonwater_code=SourceCode.HLS_VALID_NONWATER,
        valid=valid,
    )

    return _add_common_bands(
        image=image,
        bands=[_component_bands(open_water, partial, valid), water, water_class, source],
        valid=valid,
        source_rank=SourceRank.OPERA_DSWX_HLS,
        source_bit=source_bit,
        gap_status=GapStatus.FILLED_BY_HLS,
    )


def normalize_opera_s1_image(image: ee.Image) -> ee.Image:
    """Normalize one OPERA DSWx-S1 image to the common Approach3 bands."""
    wtr = image.select("WTR_Water_classification")

    open_water = wtr.eq(1)
    inundated = wtr.eq(3)
    valid_nonwater = wtr.eq(0)
    valid = wtr.lt(250)

    water = open_water.Or(inundated).rename("water").toByte().updateMask(valid)
    water_class = _class_image(open_water, inundated, valid)
    source = _source_image(
        valid_nonwater=valid_nonwater,
        open_water=open_water,
        inundated_or_partial=inundated,
        both_code=SourceCode.S1_INUNDATED_VEGETATION,
        open_code=SourceCode.S1_OPEN_WATER,
        inundated_code=SourceCode.S1_INUNDATED_VEGETATION,
        nonwater_code=SourceCode.S1_VALID_NONWATER,
        valid=valid,
    )

    return _add_common_bands(
        image=image,
        bands=[_component_bands(open_water, inundated, valid), water, water_class, source],
        valid=valid,
        source_rank=SourceRank.OPERA_DSWX_S1,
        source_bit=SourceBit.S1_VALID,
        gap_status=GapStatus.FILLED_BY_S1,
    )


def merge_priority_sources(
    dynamic_world: ee.Image,
    opera_hls: ee.Image | None = None,
    opera_s1: ee.Image | None = None,
) -> ee.Image:
    """Merge normalized source images using the Approach3 strict priority order.

    The merge only fills pixels where all higher-priority sources are invalid.
    It uses `unmask(0)` only on validity/diagnostic bands, not on class bands.
    """
    selected = _masked_decision_bands(dynamic_world)
    valid_final = dynamic_world.select("valid").unmask(0).eq(1)
    source_bits = dynamic_world.select("source_bits").unmask(0).toByte()

    for fill in [opera_hls, opera_s1]:
        if fill is None:
            continue

        fill_valid = fill.select("valid").unmask(0).eq(1)
        use_fill = valid_final.Not().And(fill_valid)
        selected = selected.blend(fill.select(DECISION_BANDS).updateMask(use_fill))
        valid_final = valid_final.Or(use_fill)
        source_bits = source_bits.bitwiseOr(fill.select("source_bits").unmask(0).toByte())

    valid_final = valid_final.rename("valid_final").toByte()
    unresolved = valid_final.Not().rename("unresolved").toByte()
    final_gap_status = (
        selected.select("gap_status")
        .unmask(GapStatus.UNRESOLVED)
        .where(unresolved, GapStatus.UNRESOLVED)
        .rename("gap_status")
        .toByte()
    )

    selected = selected.select([band for band in DECISION_BANDS if band != "gap_status"])
    return (
        selected.addBands(final_gap_status.updateMask(valid_final.Or(unresolved)))
        .addBands(valid_final)
        .addBands(source_bits.rename("source_bits"))
    )


def compose_normalized_source(
    *,
    open_water: ee.Image,
    inundated_or_partial: ee.Image,
    valid_nonwater: ee.Image,
    valid: ee.Image,
    source_rank: int,
    source_bit: int,
    gap_status: int,
    open_code: int,
    inundated_code: int,
    both_code: int,
    nonwater_code: int,
    source_date_yyyymmdd: ee.Image,
    source_doy: ee.Image,
) -> ee.Image:
    """Compose common normalized bands from already-derived source components."""
    water = open_water.Or(inundated_or_partial).rename("water").toByte().updateMask(valid)
    water_class = _class_image(open_water, inundated_or_partial, valid)
    source = _source_image(
        valid_nonwater=valid_nonwater,
        open_water=open_water,
        inundated_or_partial=inundated_or_partial,
        both_code=both_code,
        open_code=open_code,
        inundated_code=inundated_code,
        nonwater_code=nonwater_code,
        valid=valid,
    )
    rank = ee.Image.constant(source_rank).rename("source_rank").toByte().updateMask(valid)
    gap = ee.Image.constant(gap_status).rename("gap_status").toByte().updateMask(valid)
    valid_band = valid.rename("valid").toByte()
    bits = ee.Image.constant(source_bit).rename("source_bits").toByte().updateMask(valid)

    return ee.Image.cat(
        [
            _component_bands(open_water, inundated_or_partial, valid),
            water,
            water_class,
            source,
            rank,
            source_date_yyyymmdd.rename("source_date_yyyymmdd").toInt32().updateMask(valid),
            source_doy.rename("source_doy").toUint16().updateMask(valid),
            gap,
            valid_band,
            bits,
        ]
    ).select(NORMALIZED_BANDS)


def empty_normalized_image() -> ee.Image:
    """Return a normalized image with no valid source pixels.

    Use this for optional lower-priority sources when no image is available in
    the pairing window. Decision bands stay masked; validity and source bits are
    explicit zeros.
    """
    masked_zero = ee.Image.constant(0).updateMask(ee.Image.constant(0))
    valid = ee.Image.constant(0).rename("valid").toByte()
    source_bits = ee.Image.constant(0).rename("source_bits").toByte()
    bands = [
        masked_zero.rename("open_water").toByte(),
        masked_zero.rename("inundated_or_partial").toByte(),
        masked_zero.rename("water").toByte(),
        masked_zero.rename("water_class").toByte(),
        masked_zero.rename("source").toByte(),
        masked_zero.rename("source_rank").toByte(),
        masked_zero.rename("source_date_yyyymmdd").toInt32(),
        masked_zero.rename("source_doy").toUint16(),
        masked_zero.rename("gap_status").toByte(),
        valid,
        source_bits,
    ]
    return ee.Image.cat(bands).select(NORMALIZED_BANDS)


def _filtered_collection(
    collection_id: str,
    aoi: ee.Geometry | ee.FeatureCollection | None,
    start_date: str | None,
    end_date: str | None,
) -> ee.ImageCollection:
    collection = ee.ImageCollection(collection_id)
    if aoi is not None:
        collection = collection.filterBounds(aoi)
    if start_date is not None and end_date is not None:
        collection = collection.filterDate(start_date, end_date)
    elif start_date is not None or end_date is not None:
        raise ValueError("Provide both start_date and end_date, or neither.")
    return collection


def _class_image(open_water: ee.Image, inundated_or_partial: ee.Image, valid: ee.Image) -> ee.Image:
    both = open_water.And(inundated_or_partial)
    return (
        ee.Image.constant(WaterClass.VALID_NONWATER)
        .where(open_water, WaterClass.OPEN_WATER)
        .where(inundated_or_partial, WaterClass.INUNDATED_OR_PARTIAL)
        .where(both, WaterClass.BOTH_WATER_TYPES)
        .rename("water_class")
        .toByte()
        .updateMask(valid)
    )


def _component_bands(
    open_water: ee.Image,
    inundated_or_partial: ee.Image,
    valid: ee.Image,
) -> ee.Image:
    return ee.Image.cat(
        [
            open_water.rename("open_water").toByte().updateMask(valid),
            inundated_or_partial.rename("inundated_or_partial").toByte().updateMask(valid),
        ]
    )


def _source_image(
    *,
    valid_nonwater: ee.Image,
    open_water: ee.Image,
    inundated_or_partial: ee.Image,
    both_code: int,
    open_code: int,
    inundated_code: int,
    nonwater_code: int,
    valid: ee.Image,
) -> ee.Image:
    both = open_water.And(inundated_or_partial)
    return (
        ee.Image.constant(SourceCode.NO_SOURCE)
        .where(valid_nonwater, nonwater_code)
        .where(open_water, open_code)
        .where(inundated_or_partial, inundated_code)
        .where(both, both_code)
        .rename("source")
        .toByte()
        .updateMask(valid)
    )


def _add_common_bands(
    *,
    image: ee.Image,
    bands: list[ee.Image],
    valid: ee.Image,
    source_rank: int,
    source_bit: int,
    gap_status: int,
) -> ee.Image:
    source_date = _source_date_yyyymmdd(image).updateMask(valid)
    source_doy = _source_doy(image).updateMask(valid)
    rank = ee.Image.constant(source_rank).rename("source_rank").toByte().updateMask(valid)
    gap = ee.Image.constant(gap_status).rename("gap_status").toByte().updateMask(valid)
    valid_band = valid.rename("valid").toByte()
    bits = ee.Image.constant(source_bit).rename("source_bits").toByte().updateMask(valid)

    return ee.Image(
        ee.Image.cat([*bands, rank, source_date, source_doy, gap, valid_band, bits])
        .select(NORMALIZED_BANDS)
        .copyProperties(image, image.propertyNames())
    )


def _source_date_yyyymmdd(image: ee.Image) -> ee.Image:
    value = ee.Number.parse(ee.Date(image.get("system:time_start")).format("YYYYMMdd"))
    return ee.Image.constant(value).rename("source_date_yyyymmdd").toInt32()


def _source_doy(image: ee.Image) -> ee.Image:
    value = ee.Number.parse(ee.Date(image.get("system:time_start")).format("D"))
    return ee.Image.constant(value).rename("source_doy").toUint16()


def _masked_decision_bands(image: ee.Image) -> ee.Image:
    valid = image.select("valid").unmask(0).eq(1)
    return image.select(DECISION_BANDS).updateMask(valid)
