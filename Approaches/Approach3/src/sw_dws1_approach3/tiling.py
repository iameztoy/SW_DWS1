"""Earth Engine covering-grid helpers for tiled Approach3 exports."""

from __future__ import annotations

from dataclasses import dataclass

import ee


@dataclass(frozen=True)
class TileGridConfig:
    """Client-side tiling settings."""

    enabled: bool = False
    tile_scale_m: int = 50_000
    crs: str = "EPSG:3857"
    max_preview_tiles: int = 12
    max_export_tiles: int = 1


@dataclass(frozen=True)
class ExportRegion:
    """One region to pass to an Earth Engine export task."""

    label_suffix: str
    region: ee.Geometry


def build_covering_grid(aoi: ee.Geometry, config: TileGridConfig) -> ee.FeatureCollection:
    """Build a covering grid over an AOI using Earth Engine Geometry.coveringGrid."""
    projection = ee.Projection(config.crs)
    grid = aoi.coveringGrid(projection, config.tile_scale_m)
    return ee.FeatureCollection(grid).filterBounds(aoi)


def grid_summary(aoi: ee.Geometry, grid: ee.FeatureCollection) -> ee.Dictionary:
    """Return compact grid diagnostics for notebook/script previews."""
    return ee.Dictionary(
        {
            "tile_count": grid.size(),
            "aoi_area_km2": aoi.area(maxError=1).divide(1_000_000),
        }
    )


def preview_grid(grid: ee.FeatureCollection, max_tiles: int) -> ee.FeatureCollection:
    """Return a small grid subset for display."""
    return ee.FeatureCollection(grid.limit(max_tiles))


def export_regions(
    *,
    aoi: ee.Geometry,
    use_tiling: bool,
    grid: ee.FeatureCollection | None = None,
    max_tiles: int = 1,
) -> list[ExportRegion]:
    """Return client-side export regions for one AOI or the first grid tiles.

    This intentionally materializes only tile indexes, not geometries, on the
    client. The geometries remain server-side `ee.Geometry` objects used by
    Earth Engine export tasks.
    """
    if not use_tiling:
        return [ExportRegion(label_suffix="aoi", region=aoi)]
    if grid is None:
        raise ValueError("grid is required when use_tiling=True.")

    tile_count = int(grid.size().getInfo())
    selected_count = min(tile_count, max_tiles)
    tile_list = grid.toList(selected_count)
    regions: list[ExportRegion] = []
    for index in range(selected_count):
        tile = ee.Feature(tile_list.get(index))
        region = tile.geometry().intersection(aoi, ee.ErrorMargin(1))
        regions.append(ExportRegion(label_suffix=f"tile_{index + 1:04d}", region=region))
    return regions
