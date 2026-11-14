#!/usr/bin/env python3
"""Read local R2 object metadata; hashed blob filenames are not object keys."""
import argparse
import datetime as dt
import json
import pathlib
import sqlite3
import subprocess
import urllib.request


def inspect_snapshots(state_dir: pathlib.Path) -> dict:
    candidates = sorted((state_dir / "r2").glob("*/*.sqlite"))
    candidates = [p for p in candidates if p.name != "metadata.sqlite"]
    if len(candidates) != 1:
        raise RuntimeError("Expected one local R2 metadata database")
    now = dt.datetime.now(dt.timezone.utc)
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    with sqlite3.connect(candidates[0].as_uri() + "?mode=ro", uri=True, timeout=5) as db:
        db.execute("PRAGMA query_only=ON")
        total, today, newest = db.execute(
            "SELECT COUNT(*), COALESCE(SUM(uploaded >= ?), 0), MAX(uploaded) "
            "FROM _mf_objects WHERE key LIKE 'bing-webmaster/v1/%'",
            (int(day.timestamp() * 1000),),
        ).fetchone()
    return {
        "snapshots_total": total,
        "snapshots_today": today,
        "newest_snapshot": (
            dt.datetime.fromtimestamp(newest / 1000, dt.timezone.utc).isoformat()
            if newest is not None else None
        ),
        "utc_day": day.date().isoformat(),
        "storage": "ok",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--state-dir", type=pathlib.Path,
        default=pathlib.Path("/var/lib/docker/volumes/openseo_open_seo_data/_data/state/v3"),
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    record = {"checked_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    try:
        record.update(inspect_snapshots(args.state_dir.resolve()))
    except (OSError, sqlite3.Error, RuntimeError, ValueError) as error:
        record.update(storage="error", snapshots_today=None, snapshots_total=None,
                      error=type(error).__name__ + ": local R2 metadata unavailable")
    try:
        with urllib.request.urlopen("http://127.0.0.1:3001/api/health", timeout=15) as response:
            record["health"] = response.status
    except Exception:
        record["health"] = "unavailable"
    logs = subprocess.run(
        ["docker", "logs", "--since", "6h", "openseo-open-seo-1"],
        capture_output=True, text=True, timeout=30, check=False,
    )
    if logs.returncode == 0:
        text = logs.stdout + logs.stderr
        # These count log lines, not all provider attempts or remaining quota.
        record["throttle_logs_6h"] = text.count("[bing] throttled")
        record["budget_logs_6h"] = text.count("daily call budget")
    else:
        record["throttle_logs_6h"] = None
        record["budget_logs_6h"] = None
    if args.json:
        print(json.dumps(record, sort_keys=True))
    else:
        def display(value):
            return "unknown" if value is None else str(value)
        print(" ".join(f"{key}={display(value)}" for key, value in record.items()))
    return 0 if record["storage"] == "ok" and record["health"] == 200 else 1


if __name__ == "__main__":
    raise SystemExit(main())
