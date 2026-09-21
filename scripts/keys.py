#!/usr/bin/env python3
"""Issue, list, revoke and carry over API keys.

Keys are what make the 100-row cap worth having: anyone can browse, and anyone
who wants the whole corpus asks for a key, which is free and takes a minute to
issue. The point is knowing who has the data, not restricting who can.

Only the SHA-256 hash of a key is ever stored, so a key is shown exactly once
and cannot be recovered -- if a holder loses theirs, issue another and revoke
the old one.

This talks to the database directly over its HTTP API, the same protocol the
Worker uses. Point it at the database with two environment variables:

    export TURSO_URL=libsql://esmd-<org>.turso.io
    export TURSO_TOKEN=...            # turso db tokens create esmd

Then:

    python scripts/keys.py issue --label "A. Researcher, LSE" --email a@lse.ac.uk
    python scripts/keys.py list
    python scripts/keys.py revoke --label "A. Researcher, LSE"
    python scripts/keys.py export --out keys.json      # before rebuilding
    python scripts/keys.py import --file keys.json     # after re-importing
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import secrets
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

KEY_COLUMNS = ["key_hash", "label", "email", "issued_at", "revoked_at", "note"]


class Database:
    """The smallest possible libSQL HTTP client: one statement at a time.

    Deliberately stdlib-only. This is the tool you reach for to issue a key to
    someone who has just emailed you, and needing to fix a pip install first is
    exactly the friction that turns "a minute" into "next week".
    """

    def __init__(self, url: str, token: str):
        self.endpoint = url.replace("libsql:", "https:").rstrip("/") + "/v2/pipeline"
        self.token = token

    @classmethod
    def from_env(cls) -> "Database":
        url = os.environ.get("TURSO_URL")
        token = os.environ.get("TURSO_TOKEN")
        if not url or not token:
            sys.exit(
                "set TURSO_URL and TURSO_TOKEN first:\n"
                "    export TURSO_URL=$(turso db show esmd --url)\n"
                "    export TURSO_TOKEN=$(turso db tokens create esmd)"
            )
        return cls(url, token)

    @staticmethod
    def _encode(value: Any) -> dict:
        if value is None:
            return {"type": "null"}
        if isinstance(value, bool):
            return {"type": "integer", "value": "1" if value else "0"}
        if isinstance(value, int):
            return {"type": "integer", "value": str(value)}
        if isinstance(value, float):
            return {"type": "float", "value": value}
        return {"type": "text", "value": str(value)}

    @staticmethod
    def _decode(cell: dict) -> Any:
        kind = cell.get("type")
        if kind in (None, "null"):
            return None
        if kind == "integer":
            return int(cell["value"])
        if kind == "float":
            return float(cell["value"])
        return cell.get("value")

    def query(self, sql: str, args: list | None = None) -> list[dict]:
        payload = json.dumps({
            "requests": [
                {"type": "execute",
                 "stmt": {"sql": sql, "args": [self._encode(a) for a in (args or [])]}},
                {"type": "close"},
            ]
        }).encode()
        request = urllib.request.Request(
            self.endpoint,
            data=payload,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                body = json.loads(response.read())
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                sys.exit("the database rejected TURSO_TOKEN; mint a new one with "
                         "`turso db tokens create esmd`")
            sys.exit(f"the database returned HTTP {error.code}: "
                     f"{error.read()[:200].decode(errors='replace')}")
        except urllib.error.URLError as error:
            sys.exit(f"could not reach {self.endpoint}: {error.reason}")
        first = body["results"][0]
        if first["type"] == "error":
            sys.exit(f"query failed: {first['error'].get('message')}")
        result = first["response"]["result"]
        columns = [c["name"] for c in result.get("cols", [])]
        return [
            {columns[i]: self._decode(cell) for i, cell in enumerate(row)}
            for row in result.get("rows", [])
        ]


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def cmd_issue(db: Database, args) -> None:
    # 32 bytes of URL-safe randomness; the prefix makes a leaked key findable
    # in logs and recognisable in a support email.
    key = "esmd_" + secrets.token_urlsafe(32)
    key_hash = hashlib.sha256(key.encode()).hexdigest()
    db.query(
        "INSERT INTO api_keys (key_hash, label, email, issued_at, note) "
        "VALUES (?, ?, ?, ?, ?)",
        [key_hash, args.label, args.email, now(), args.note],
    )
    print("\n  Issued and live. Give this to the researcher — it is shown once "
          "and is not recoverable:\n")
    print(f"      {key}\n")
    print("  They use it as:\n")
    print(f"      export LEADERS_TWEETS_KEY={key}")
    print('      python -c "import leaders_tweets as lt; print(lt.get_tweets().shape)"\n')
    print("  Or paste it into the API key box on the website.\n")


def cmd_list(db: Database, args) -> None:
    rows = db.query(
        """SELECT k.label, k.email, k.issued_at, k.revoked_at,
                  (SELECT COUNT(*) FROM download_log d WHERE d.key_hash = k.key_hash) AS downloads,
                  (SELECT MAX(at) FROM download_log d WHERE d.key_hash = k.key_hash) AS last_seen
           FROM api_keys k ORDER BY k.issued_at DESC"""
    )
    if not rows:
        print("no keys issued yet")
        return
    width = max(len(r["label"]) for r in rows)
    print(f"  {'label'.ljust(width)}  {'issued':10}  {'downloads':>9}  last download")
    for row in rows:
        state = "REVOKED" if row["revoked_at"] else ""
        print(f"  {row['label'].ljust(width)}  {row['issued_at'][:10]}  "
              f"{row['downloads']:>9}  {row['last_seen'] or '-'}  {state}")


def cmd_revoke(db: Database, args) -> None:
    matches = db.query("SELECT key_hash, label, revoked_at FROM api_keys WHERE label = ?",
                       [args.label])
    if not matches:
        sys.exit(f"no key labelled {args.label!r}; run `keys.py list` to see them")
    if matches[0]["revoked_at"]:
        print(f"{args.label!r} was already revoked on {matches[0]['revoked_at']}")
        return
    db.query("UPDATE api_keys SET revoked_at = ? WHERE label = ?", [now(), args.label])
    print(f"revoked {args.label!r}; it stops working on the next request")


def cmd_export(db: Database, args) -> None:
    rows = db.query(f"SELECT {', '.join(KEY_COLUMNS)} FROM api_keys ORDER BY issued_at")
    Path(args.out).write_text(json.dumps(rows, indent=2) + "\n")
    print(f"wrote {len(rows)} keys to {args.out}")
    print("Keep this next to the release: a rebuilt database starts with no keys, "
          "and every holder would have to be re-issued one.")


def cmd_import(db: Database, args) -> None:
    rows = json.loads(Path(args.file).read_text())
    placeholders = ", ".join("?" * len(KEY_COLUMNS))
    for row in rows:
        db.query(
            f"INSERT OR REPLACE INTO api_keys ({', '.join(KEY_COLUMNS)}) "
            f"VALUES ({placeholders})",
            [row.get(column) for column in KEY_COLUMNS],
        )
    total = db.query("SELECT COUNT(*) AS n FROM api_keys")[0]["n"]
    print(f"restored {len(rows)} keys; the database now holds {total}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    issue = sub.add_parser("issue", help="mint a key and record it")
    issue.add_argument("--label", required=True, help="who this key is for")
    issue.add_argument("--email", default=None)
    issue.add_argument("--note", default=None)
    issue.set_defaults(func=cmd_issue)

    listing = sub.add_parser("list", help="show every key and its download count")
    listing.set_defaults(func=cmd_list)

    revoke = sub.add_parser("revoke", help="stop a key working")
    revoke.add_argument("--label", required=True)
    revoke.set_defaults(func=cmd_revoke)

    export = sub.add_parser("export", help="save the keys before rebuilding the database")
    export.add_argument("--out", default="keys.json")
    export.set_defaults(func=cmd_export)

    restore = sub.add_parser("import", help="put saved keys into a rebuilt database")
    restore.add_argument("--file", default="keys.json")
    restore.set_defaults(func=cmd_import)

    args = ap.parse_args()
    args.func(Database.from_env(), args)


if __name__ == "__main__":
    main()
