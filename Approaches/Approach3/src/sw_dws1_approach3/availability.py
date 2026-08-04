"""Source availability helpers for Approach3 preflight checks."""

from __future__ import annotations

from .periods import parse_iso_date


OPERA_DSWX_HLS_START_DATE = "2023-04-04"
OPERA_DSWX_S1_START_DATE = "2024-08-01"


def date_window_overlaps(start_date: str, end_date: str, available_start_date: str) -> bool:
    """Return True when [start_date, end_date) overlaps a source availability window."""
    start = parse_iso_date(start_date)
    end = parse_iso_date(end_date)
    available_start = parse_iso_date(available_start_date)
    return end > available_start and end > start


def source_availability_flags(start_date: str, end_date: str) -> dict[str, bool | str]:
    """Return expected source availability flags for a user date window."""
    return {
        "dynamic_world_expected": True,
        "opera_hls_expected": date_window_overlaps(
            start_date,
            end_date,
            OPERA_DSWX_HLS_START_DATE,
        ),
        "opera_s1_expected": date_window_overlaps(
            start_date,
            end_date,
            OPERA_DSWX_S1_START_DATE,
        ),
        "opera_hls_start_date": OPERA_DSWX_HLS_START_DATE,
        "opera_s1_start_date": OPERA_DSWX_S1_START_DATE,
    }
