#!/usr/bin/env python3
"""Combine all CSV files inside a ZIP exported from Google Earth Engine into one CSV.

Usage:
    python combine_gee_csvs.py \
        --zip /path/to/EarthEngine-export.zip \
        --out /path/to/combined_thresholds.csv

Optional:
    --dedupe month_key     # remove duplicates based on one or more columns
    --keep last            # keep 'first' or 'last' duplicate row
    --no-source-file       # do not add source_file column
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path
from typing import List

import pandas as pd


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", dest="zip_path", required=True, help="Input ZIP file containing CSVs")
    parser.add_argument("--out", dest="out_csv", required=True, help="Output merged CSV file")
    parser.add_argument(
        "--dedupe",
        nargs="+",
        default=["month_key"],
        help="Columns used to detect duplicate rows. Default: month_key",
    )
    parser.add_argument(
        "--keep",
        choices=["first", "last", "none"],
        default="first",
        help="Which duplicate row to keep. Use 'none' to keep all rows. Default: first",
    )
    parser.add_argument(
        "--no-source-file",
        action="store_true",
        help="Do not append the source_file column to the merged table",
    )
    return parser.parse_args()


def read_csvs_from_zip(zip_path: Path, add_source_file: bool = True) -> List[pd.DataFrame]:
    dataframes: List[pd.DataFrame] = []
    with zipfile.ZipFile(zip_path) as zf:
        csv_names = sorted(name for name in zf.namelist() if name.lower().endswith(".csv"))
        if not csv_names:
            raise FileNotFoundError("No CSV files were found inside the ZIP archive.")

        print(f"Found {len(csv_names)} CSV file(s) inside: {zip_path}")
        for name in csv_names:
            with zf.open(name) as f:
                df = pd.read_csv(f)
                if add_source_file:
                    df["source_file"] = name
                dataframes.append(df)
                print(f"  - {name}: {len(df)} row(s), {len(df.columns)} column(s)")
    return dataframes


def sort_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    sort_cols = [c for c in ["year", "month", "month_key", "source_file"] if c in df.columns]
    if sort_cols:
        df = df.sort_values(sort_cols, kind="stable")
    return df.reset_index(drop=True)


def main() -> int:
    args = parse_args()
    zip_path = Path(args.zip_path)
    out_csv = Path(args.out_csv)

    if not zip_path.exists():
        print(f"ERROR: ZIP file not found: {zip_path}", file=sys.stderr)
        return 1

    dfs = read_csvs_from_zip(zip_path, add_source_file=not args.no_source_file)
    merged = pd.concat(dfs, ignore_index=True, sort=False)
    merged = sort_dataframe(merged)

    print(f"\nMerged rows before duplicate handling: {len(merged)}")

    if args.keep != "none":
        missing_cols = [c for c in args.dedupe if c not in merged.columns]
        if missing_cols:
            print(
                f"ERROR: Cannot deduplicate because these columns are missing: {missing_cols}",
                file=sys.stderr,
            )
            return 1

        dup_mask = merged.duplicated(subset=args.dedupe, keep=False)
        dup_count = int(dup_mask.sum())
        if dup_count > 0:
            print(f"Duplicate rows detected using {args.dedupe}: {dup_count}")
            merged = merged.drop_duplicates(subset=args.dedupe, keep=args.keep)
            merged = sort_dataframe(merged)
            print(f"Rows after keeping '{args.keep}' duplicates: {len(merged)}")
        else:
            print(f"No duplicates detected using {args.dedupe}.")
    else:
        print("Duplicate handling disabled; all rows will be kept.")

    out_csv.parent.mkdir(parents=True, exist_ok=True)
    merged.to_csv(out_csv, index=False)

    print(f"\nMerged CSV written to: {out_csv}")
    print(f"Final shape: {merged.shape[0]} row(s) x {merged.shape[1]} column(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
