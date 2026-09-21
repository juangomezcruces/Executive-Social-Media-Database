#!/usr/bin/env python3
"""Render schema.md from data/schema.json so the prose can never drift.

    python scripts/make_schema_md.py --data data --out schema.md
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

INTRO = """# Schema

The Executive Social Media Database ships three tables. `leaders` is the
dimension table; `tweets` and `sentiment` both join back to it on `leader_id`,
and `sentiment` joins to `tweets` on `tweet_uid`.

Every table is published as Parquet (canonical, typed) and CSV (readable,
diffable). Both are downloadable in full with a free API key; see the
repository README.

## A note on tweet ids

The raw collection files carry an `id` column, but it is **not** a usable
primary key. In 12 of the 52 source files the same value is attached to several
distinct tweets -- `tweetsModi.csv` is the extreme case, with 3,921 distinct ids
spread across 56,941 distinct tweets. The cause appears to be a collector that
wrote something other than the tweet id (a conversation id or a paging cursor)
for those runs.

Rows are therefore keyed on **`tweet_uid`**, a BLAKE2b-64 digest of
`leader_id | created_at | text`. The raw value is preserved as
`source_tweet_id`, and `source_id_reliable` tells you whether it can be trusted
for that leader -- check it before using ids to rehydrate against the X API.

"""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", default=Path("data"), type=Path)
    ap.add_argument("--out", default=Path("schema.md"), type=Path)
    args = ap.parse_args()

    schema = json.loads((args.data / "schema.json").read_text())
    # The release version comes from the manifest, not from schema.json: the
    # manifest is what every client reads and what defines a release, and a
    # release can ship the same tables under a new version -- v2.0.0 changed
    # how the data is reached, not a single row of it.
    manifest_path = args.data / "manifest.json"
    version = (json.loads(manifest_path.read_text()).get("version")
               if manifest_path.exists() else schema.get("version", "unreleased"))
    lines = [INTRO]
    lines.append(f"*Generated from `data/schema.json` for release `{version}`.*\n")

    for name, table in schema["tables"].items():
        lines.append(f"## `{name}`\n")
        lines.append(f"{table['rows']:,} rows.\n")
        lines.append("| column | type | description |")
        lines.append("| --- | --- | --- |")
        for col in table["columns"]:
            desc = col["description"].replace("|", "\\|")
            lines.append(f"| `{col['name']}` | `{col['type']}` | {desc} |")
        lines.append("")

    args.out.write_text("\n".join(lines))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
