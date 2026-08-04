# Approach4

Approach4 is an independent development track for hierarchical surface-water
fusion in Google Earth Engine. It is isolated from Approach1, Approach2, and
Approach3: similarities may be compared explicitly, but changes must not be
transferred between approaches unless requested.

## Current baseline

The current synchronized pair is v1.5.0:

- `scripts/DW_OPERA_hierarchical_fusion_v1_5_0.txt` — production workflow for
  temporal-window processing, preview, image export, and NoData QA CSV export.
- `scripts/DW_OPERA_fusion_process_inspector_v1_5_0.txt` — single-window visual
  inspector for verifying the successive fusion stages and supporting masks.

`scripts/DW_water_retrieval_annual_dynamics_tabs_v6_9.txt` is a related but
purpose-specific annual observation-dynamics application. It remains separate
from the synchronized production/inspector version sequence.

The imported contexts are preserved under `docs/`. See
`docs/alignment_v1_5_0.md` for the comparison, alignment decisions, and
compatibility changes introduced in v1.5.0. The untouched paired v1.4.0 scripts
are retained under `scripts/legacy/`.

The original imported v1.4.0 pair, annual v6.9 script, and context files are
preserved without content changes.

## Shared method contract

The paired scripts share the following scientific logic:

1. Source priority is strict: Dynamic World, HLS-Landsat, HLS-Sentinel-2, then
   OPERA DSWx-S1. HLS platforms are identified operationally from
   `SPACECRAFT_NAME`; `SENSOR` is diagnostic only.
2. HLS native classes 0, 1, and 2 are valid. S1 native classes 0, 1, and 3 are
   valid. A valid class 0 is a non-water decision that resolves the gap and
   blocks lower-priority sources.
3. S1 values 250, 251, 254, and 255 are mask/fill outcomes and do not resolve a
   gap.
4. Harmonized classes are 0 (valid non-water), 1 (open water), 2 (inundated
   vegetation or partial water), optional DW-only 3 (both DW components), and
   255 (unresolved NoData).
5. The optional HAND correction is post-fusion only. It can reclassify a
   water-related result to valid non-water under the documented S1 conditions,
   but it does not participate in source selection or create NoData.
6. Temporal-window end dates are exclusive.
7. Each source is collapsed to one typed observation per UTC date before
   counts or temporal modes.

## Paired versioning rule

Future work must first distinguish shared fusion logic from script-specific
functionality. Any change to shared class definitions, source priority,
temporal decisions, validity, NoData handling, or HAND/class-3 behavior must be
evaluated in both scripts and, when applicable, released under the same next
version in both filenames and internal version variables. The inspector remains
a visual verification tool and does not need to duplicate production-only
export or statistical features.

## Structure

```text
Approaches/Approach4/
├─ README.md
├─ docs/
│  ├─ alignment_v1_5_0.md
│  ├─ annual_water_dynamics_context_v6_9.txt
│  └─ development_context_v1_4_0.txt
└─ scripts/
   ├─ DW_OPERA_fusion_process_inspector_v1_5_0.txt
   ├─ DW_OPERA_hierarchical_fusion_v1_5_0.txt
   ├─ DW_water_retrieval_annual_dynamics_tabs_v6_9.txt
   └─ legacy/
      ├─ DW_OPERA_fusion_process_inspector_v1_4_0.txt
      └─ DW_OPERA_hierarchical_fusion_v1_4_0.txt
```
