#!/usr/bin/env python3
"""Point every client at the deployed API.

Three files hold the API address, because each is the entry point for a client
that has nothing else to go on: the web app, the Python package and the R
package. They must agree, and a half-finished edit is the kind of mistake that
looks fine locally and 404s for everyone else, so this rewrites all three and
refuses to leave any of them behind.

    python scripts/set_api_url.py https://esmd-api.jgc.workers.dev/v1

Run it once after `wrangler deploy` prints the Worker's URL, then commit the
three files. Running it again with a new URL is how you move the API.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# (file, regex with one group holding the URL)
TARGETS = [
    (Path("webapp/src/config.js"),
     re.compile(r"(?<=^export const API_BASE = ')[^']+(?=';$)", re.M)),
    (Path("python-package/src/leaders_tweets/core.py"),
     re.compile(r'(?<=^API_BASE = ")[^"]+(?="$)', re.M)),
    (Path("r-package/R/core.R"),
     re.compile(r'(?<=^API_BASE <- ")[^"]+(?="$)', re.M)),
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("url", help="the Worker's URL including /v1, no trailing slash")
    ap.add_argument("--root", default=Path("."), type=Path)
    ap.add_argument("--check", action="store_true",
                    help="report the current values and change nothing")
    args = ap.parse_args()

    url = args.url.rstrip("/")
    if not args.check:
        if not url.startswith("https://"):
            sys.exit("the API URL must be https://")
        if not url.endswith("/v1"):
            sys.exit("the API URL must end in /v1 — that is the versioned prefix "
                     "every client appends its path to")

    failures = []
    for path, pattern in TARGETS:
        full = args.root / path
        if not full.exists():
            failures.append(f"{path}: missing")
            continue
        text = full.read_text()
        found = pattern.search(text)
        if not found:
            failures.append(f"{path}: no API_BASE line matched — has it been renamed?")
            continue
        if args.check:
            print(f"  {path}: {found.group(0)}")
            continue
        full.write_text(pattern.sub(url, text, count=1))
        print(f"  {path}: {found.group(0)} -> {url}")

    if failures:
        print("\n".join(f"  ! {f}" for f in failures), file=sys.stderr)
        sys.exit("refusing to leave the clients pointing at different addresses")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
