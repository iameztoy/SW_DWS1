"""Area-of-interest helpers for Approach3."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path

import ee


HYDROBASINS_LEVEL4_COLLECTION = "WWF/HydroSHEDS/v1/Basins/hybas_4"
DEFAULT_TANGANYIKA_HYBAS_ID = 1041259950


@dataclass(frozen=True)
class AoiConfig:
    """Client-side AOI settings for scripts and notebooks."""

    mode: str = "basin"
    hybas_id: int = DEFAULT_TANGANYIKA_HYBAS_ID
    bbox: tuple[float, float, float, float] | None = None
    point_lon: float = 29.75
    point_lat: float = -6.5
    point_buffer_m: int = 20_000
    geojson_path: str | None = None


def basin_feature_collection(
    hybas_id: int = DEFAULT_TANGANYIKA_HYBAS_ID,
    collection_id: str = HYDROBASINS_LEVEL4_COLLECTION,
) -> ee.FeatureCollection:
    """Return HydroBASINS features for one HYBAS_ID."""
    return ee.FeatureCollection(collection_id).filter(ee.Filter.eq("HYBAS_ID", hybas_id))


def basin_aoi(
    hybas_id: int = DEFAULT_TANGANYIKA_HYBAS_ID,
    collection_id: str = HYDROBASINS_LEVEL4_COLLECTION,
) -> ee.Geometry:
    """Return the basin geometry used by the JavaScript baseline."""
    return basin_feature_collection(hybas_id, collection_id).geometry()


def bbox_aoi(west: float, south: float, east: float, north: float) -> ee.Geometry:
    """Return a rectangular test AOI from lon/lat bounds."""
    return ee.Geometry.Rectangle([west, south, east, north], proj="EPSG:4326", geodesic=False)


def point_buffer_aoi(lon: float, lat: float, buffer_m: int) -> ee.Geometry:
    """Return a small test AOI from a lon/lat point and buffer distance."""
    return ee.Geometry.Point([lon, lat]).buffer(buffer_m)


def geojson_aoi(path: str | Path) -> ee.Geometry:
    """Load a local GeoJSON geometry or feature and return its Earth Engine geometry."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    geojson_type = data.get("type")
    if geojson_type == "FeatureCollection":
        return ee.FeatureCollection(data).geometry()
    if geojson_type == "Feature":
        return ee.Feature(data).geometry()
    if geojson_type:
        return ee.Geometry(data)
    raise ValueError(f"Unsupported GeoJSON AOI in {path!s}.")


def resolve_aoi(config: AoiConfig, custom_geometry: ee.Geometry | None = None) -> ee.Geometry:
    """Resolve an AOI from configured basin, test geometry, GeoJSON, or drawn geometry."""
    mode = config.mode.strip().lower()
    if mode == "basin":
        return basin_aoi(config.hybas_id)
    if mode == "point_buffer":
        return point_buffer_aoi(config.point_lon, config.point_lat, config.point_buffer_m)
    if mode == "bbox":
        if config.bbox is None:
            raise ValueError("AoiConfig.bbox is required when mode='bbox'.")
        return bbox_aoi(*config.bbox)
    if mode == "geojson":
        if config.geojson_path is None:
            raise ValueError("AoiConfig.geojson_path is required when mode='geojson'.")
        return geojson_aoi(config.geojson_path)
    if mode == "drawn":
        if custom_geometry is None:
            raise ValueError("custom_geometry is required when mode='drawn'.")
        return custom_geometry
    raise ValueError("AOI mode must be basin, point_buffer, bbox, geojson, or drawn.")


def aoi_summary(aoi: ee.Geometry) -> ee.Dictionary:
    """Return compact server-side AOI diagnostics."""
    area_m2 = aoi.area(maxError=1)
    return ee.Dictionary(
        {
            "area_km2": area_m2.divide(1_000_000),
            "bounds": aoi.bounds(maxError=1).coordinates(),
        }
    )
