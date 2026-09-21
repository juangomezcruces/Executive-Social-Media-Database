#!/usr/bin/env python3
"""Write data/manifest.json -- the version pointer every client reads.

The web app and both packages resolve the dataset through the API:

    GET <api>/manifest

which is served from R2 and needs no key, so a client can always tell which
release is current and whether its cache is stale before asking for anything
that does need one.

The manifest deliberately carries no download URLs. Each client already knows
the API root -- it has to, to fetch this file -- and builds
``<api>/download/<table>.<format>`` itself. One address per client, not two,
so a redeployed Worker cannot leave a stale URL embedded in the data.

What it does carry is a digest per file, which is how a truncated or corrupted
download is caught at the point of download rather than three lines into
someone's analysis.

    python scripts/make_manifest.py --data data --version v2.0.0
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path

import pandas as pd

TABLES = ("leaders", "tweets", "sentiment")
FORMATS = ("parquet", "csv")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", default=Path("data"), type=Path)
    ap.add_argument("--version", required=True)
    ap.add_argument("--repo", default="juangomezcruces/Executive-Social-Media-Database")
    args = ap.parse_args()

    tables = {}
    for name in TABLES:
        pq = args.data / f"{name}.parquet"
        if not pq.exists():
            raise FileNotFoundError(pq)
        entry = {"rows": int(len(pd.read_parquet(pq, columns=["leader_id"])))}
        for fmt in FORMATS:
            path = args.data / f"{name}.{fmt}"
            if not path.exists():
                raise FileNotFoundError(path)
            entry[fmt] = {"bytes": path.stat().st_size, "sha256": sha256(path)}
        tables[name] = entry

    manifest = {
        "dataset": "Executive Social Media Database",
        "version": args.version,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "repo": f"https://github.com/{args.repo}",
        "schema": f"https://github.com/{args.repo}/blob/main/schema.md",
        "access": (
            "Row-level browsing is open and capped at 100 rows per request. "
            "Whole tables require a free API key: "
            f"https://github.com/{args.repo}#api-keys"
        ),
        "tables": tables,
    }
    out = args.data / "manifest.json"
    out.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))
    print(f"\nwritten to {out}")


if __name__ == "__main__":
    main()
