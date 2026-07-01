"""Local date-window helpers for Approach3 batch workflows."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class PeriodWindow:
    """A half-open date window: start is inclusive, end is exclusive."""

    start_date: str
    end_date: str
    label: str


def parse_iso_date(value: str) -> date:
    """Parse an ISO `YYYY-MM-DD` date string."""
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"Invalid date {value!r}; expected YYYY-MM-DD.") from exc


def validate_date_window(start_date: str, end_date: str) -> None:
    """Validate a half-open date window."""
    start = parse_iso_date(start_date)
    end = parse_iso_date(end_date)
    if end <= start:
        raise ValueError("end_date must be after start_date.")


def monthly_windows(start_date: str, end_date: str) -> list[PeriodWindow]:
    """Split a half-open date range into calendar-month windows."""
    start = parse_iso_date(start_date)
    end = parse_iso_date(end_date)
    if end <= start:
        raise ValueError("end_date must be after start_date.")

    windows: list[PeriodWindow] = []
    cursor = start
    while cursor < end:
        next_month = _first_day_next_month(cursor)
        window_end = min(next_month, end)
        windows.append(
            PeriodWindow(
                start_date=cursor.isoformat(),
                end_date=window_end.isoformat(),
                label=month_label(cursor),
            )
        )
        cursor = window_end
    return windows


def month_label(value: date | str) -> str:
    """Return a stable `YYYY_MM` label for the month containing a date."""
    parsed = parse_iso_date(value) if isinstance(value, str) else value
    return f"{parsed.year:04d}_{parsed.month:02d}"


def default_export_label(
    *,
    product_mode: str,
    start_date: str,
    end_date: str,
    hybas_id: int,
    prefix: str = "approach3",
) -> str:
    """Return a stable default export label for a product window."""
    validate_date_window(start_date, end_date)
    mode = product_mode.lower().strip()
    if mode == "monthly":
        period = month_label(start_date)
    elif mode == "acquisition":
        period = parse_iso_date(start_date).strftime("%Y_%m_%d")
    else:
        raise ValueError('product_mode must be "monthly" or "acquisition".')
    return f"{prefix}_{mode}_{period}_hybas_{hybas_id}"


def _first_day_next_month(value: date) -> date:
    if value.month == 12:
        return date(value.year + 1, 1, 1)
    return date(value.year, value.month + 1, 1)
