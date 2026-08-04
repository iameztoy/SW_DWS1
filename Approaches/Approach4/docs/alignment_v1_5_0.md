# Approach4 logic comparison and v1.5.0 alignment

## Scope

This comparison covered:

- `DW_OPERA_hierarchical_fusion_v1_4_0.txt`;
- `DW_OPERA_fusion_process_inspector_v1_4_0.txt`; and
- `DW_water_retrieval_annual_dynamics_tabs_v6_9.txt`.

The annual application has a different purpose: it converts dated source
observations into annual timing, duration, frequency, episode, provenance, and
diagnostic metrics. The paired fusion scripts create or inspect one strict
hierarchical classification per temporal window. Alignment therefore applies
to shared source identity, native classes, observation validity, same-day
handling, and priority—not to purpose-specific products or interfaces.

## Inconsistencies corrected

### HLS platform identification

The v1.4.0 pair selected the Landsat HLS branch with `SENSOR = OLI`. The annual
v6.9 metadata audit demonstrated that many genuine Sentinel-2 HLS assets also
carry `SENSOR = OLI`. Version 1.5.0 uses `SPACECRAFT_NAME` operationally:

- values beginning with `Landsat-` enter the HLS-Landsat branch;
- values beginning with `Sentinel-2` enter the HLS-Sentinel-2 branch; and
- `SENSOR` is diagnostic metadata only.

Assets without either recognized `SPACECRAFT_NAME` prefix do not enter these
processing branches.

### Missing HLS-Sentinel-2 hierarchy stage

The synchronized priority is now:

```text
Dynamic World
  -> OPERA DSWx-HLS Landsat
  -> OPERA DSWx-HLS Sentinel-2
  -> OPERA DSWx-S1
```

Both HLS branches accept native classes 0, 1, and 2. Class 0 is valid non-water
evidence; it resolves the current gap and blocks every lower-priority source.
HLS-Sentinel-2 receives only gaps remaining after HLS-Landsat. S1 receives only
gaps remaining after both HLS branches.

### Same-day weighting

Version 1.4.0 could allow overlapping tiles or duplicate assets from the same
source and UTC date to contribute more than once to a window count or temporal
mode. Version 1.5.0 collapses every source independently to one typed mosaic per
UTC date before the existing window aggregation. This applies to Dynamic World,
HLS-Landsat, HLS-Sentinel-2, and S1.

This change does not import the annual application's cross-source
`Any selected water wins` rule. Cross-source fusion in the paired scripts
remains strictly hierarchical at the window level.

### HLS-Sentinel-2 same-day Dynamic World gaps

`HLS_SENTINEL2_SAME_DAY_DW_GAP_ONLY` defaults to `true`. Before calculating the
HLS-Sentinel-2 window mode, a daily HLS-Sentinel-2 pixel is retained only when
the official Dynamic World label is invalid at that pixel on the same UTC date.

The paired workflow already prevents any HLS source from filling a pixel that
has a valid Dynamic World result anywhere in the complete window. That
window-level condition is stronger for the final fused class. The explicit
same-day filter is retained so HLS-Sentinel-2 native-mode diagnostics follow the
same observation-eligibility rule as the annual application.

## Codes and validity

The harmonized classification remains unchanged:

| Value | Meaning |
|---:|---|
| 0 | Valid non-water / other |
| 1 | Open water |
| 2 | Inundated vegetation or partial surface water |
| 3 | Both Dynamic World water components in the window, when enabled |
| 255 | Unresolved NoData |

Native validity remains:

- HLS: 0 non-water, 1 open water, and 2 partial surface water are valid.
- S1: 0 non-water, 1 open water, and 3 inundated vegetation are valid.
- S1 250, 251, 254, and 255 are mask/fill outcomes and never fill a gap.

Exclusive decision-source identifiers now use the same single-bit identity
space as the annual application:

| Value | Source |
|---:|---|
| 1 | Dynamic World |
| 2 | HLS-Landsat |
| 4 | HLS-Sentinel-2 |
| 8 | OPERA-S1 |
| 255 | Unresolved NoData |

Although only one value is stored per pixel in `water_source`, the powers of
two preserve consistent source identity. This deliberately changes S1 from
value 3 in v1.4.0 to value 8 in v1.5.0.

## NoData QA changes

Production NoData evaluation now records:

```text
NoData after Dynamic World
  -> NoData after HLS-Landsat
  -> NoData after both HLS branches
  -> final NoData after S1
```

Landsat and Sentinel-2 HLS resolution are each divided into water and non-water
contributions. Aggregate HLS totals remain available. CSV metadata distinguishes
raw source-asset counts from collapsed UTC-date counts.

The existing `nodata_after_hls` name now means NoData after both HLS branches.
The new `nodata_after_hls_landsat` band preserves the intermediate stage.

## Intentional differences retained

- The paired scripts keep their probability/count/frequency Dynamic World
  rules. The annual application uses official per-acquisition label classes as
  selectable annual target evidence.
- The paired scripts keep strict window-level priority. The annual application
  also offers a daily union mode because it measures selected-class dynamics.
- The annual application's selected versus unselected-water state is not a
  harmonized class in the paired products.
- The paired scripts materialize harmonized value 255. The annual application
  generally uses masks and explicit validity bands for dated observations.
- Optional HAND correction remains a post-fusion paired-script feature,
  disabled by default. It does not participate in source selection or create
  NoData.
- The inspector remains a single-window visual verification tool and does not
  duplicate production exports or CSV analysis.

## Version and compatibility

This is a synchronized v1.5.0 release of the production and inspector pair.
The changes can alter output where v1.4.0 admitted misidentified HLS assets,
where HLS-Sentinel-2 fills an additional gap, or where duplicate same-day assets
previously affected a count or mode. Consumers of `water_source` must also
adopt the new 1/2/4/8 source values.
