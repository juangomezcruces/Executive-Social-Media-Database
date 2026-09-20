#!/usr/bin/env python3
"""Static file server with HTTP Range support, for previewing the web app.

`python -m http.server` does not implement Range requests, and DuckDB-Wasm
depends on them to read Parquet without downloading the whole file -- so it
fails locally in a way it never would on GitHub Pages. This serves the same
files with ranges, so a local preview behaves like the deployed site.

    python scripts/serve_site.py _site --port 8000
"""

from __future__ import annotations

import argparse
import functools
import http.server
import os
import re
import socketserver


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        range_header = self.headers.get("Range")
        if not range_header:
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            handle = open(path, "rb")
        except OSError:
            self.send_error(404)
            return None

        size = os.fstat(handle.fileno()).st_size
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
        if not match:
            handle.close()
            self.send_error(400, "malformed Range")
            return None

        start_raw, end_raw = match.groups()
        if start_raw:
            start = int(start_raw)
            end = int(end_raw) if end_raw else size - 1
        else:  # suffix range: bytes=-N
            start = max(0, size - int(end_raw))
            end = size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            handle.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None

        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        handle.seek(start)
        self._remaining = end - start + 1
        return handle

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        self._remaining = None
        while remaining > 0:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def log_message(self, *args):  # keep the console quiet
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("directory", nargs="?", default="_site")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    handler = functools.partial(RangeHandler, directory=args.directory)
    with Server(("127.0.0.1", args.port), handler) as httpd:
        print(f"serving {args.directory} on http://127.0.0.1:{args.port}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
