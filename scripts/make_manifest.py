#!/usr/bin/env python3
"""Write data/manifest.json -- the version pointer every client reads.

The web app and both packages resolve the dataset through

    https://github.com/<owner>/<repo>/releases/latest/download/manifest.json

which GitHub redirects to the newest release without costing an API call, so
there is no rate limit to hit and no tag hardcoded anywhere. The manifest names
the release, the tables, their row counts and their SHA-256 digests; clients
cache downloaded tables under the manifest's version and re-download only when
that version changes.

    python scripts/make_manifest.py --data data --version v1.0.0
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path

import pandas as pd

TABLES = ("leaders", "tweets", "sentiment")


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

    base = f"https://github.com/{args.repo}/releases/latest/download"
    tables = {}
    for name in TABLES:
        pq = args.data / f"{name}.parquet"
        if not pq.exists():
            raise FileNotFoundError(pq)
        tables[name] = {
            "parquet": f"{base}/{name}.parquet",
            "csv": f"{base}/{name}.csv",
            "rows": int(len(pd.read_parquet(pq, columns=["leader_id"]))),
            "bytes": pq.stat().st_size,
            "sha256": sha256(pq),
        }

    manifest = {
        "dataset": "Executive Social Media Database",
        "version": args.version,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "repo": f"https://github.com/{args.repo}",
        "schema": f"{base}/schema.json",
        "tables": tables,
    }
    out = args.data / "manifest.json"
    out.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))
    print(f"\nwritten to {out}")


if __name__ == "__main__":
    main()
