"""Earth Engine session helpers for Approach3."""

from __future__ import annotations

import ee


# Required/optional parameters for local testing.
DEFAULT_EE_PROJECT: str | None = None
DEFAULT_USE_HIGH_VOLUME_ENDPOINT = False


def initialize_earth_engine(
    project: str | None = DEFAULT_EE_PROJECT,
    use_high_volume_endpoint: bool = DEFAULT_USE_HIGH_VOLUME_ENDPOINT,
) -> None:
    """Initialize Earth Engine for scripts and notebooks.

    Args:
        project: Google Cloud project ID with Earth Engine access.
        use_high_volume_endpoint: Use the high-volume API endpoint for workflows
            with many programmatic requests.
    """
    if not project:
        raise ValueError(
            "A Google Cloud project ID is required. Set project=... or edit "
            "DEFAULT_EE_PROJECT for local testing."
        )

    opt_url = "https://earthengine-highvolume.googleapis.com" if use_high_volume_endpoint else None
    ee.Initialize(project=project, opt_url=opt_url)
