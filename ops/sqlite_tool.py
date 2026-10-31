#!/usr/bin/env python3
"""OpenSEO volume helper, run inside a throwaway container (replaces the pruned openseo-backup-tool:1 image).
  sqlite_tool.py backup <TS>   : sqlite-safe copy of /d into /o/openseo-<TS>.tgz (integrity-checked), chown 1000, mode 600
  sqlite_tool.py inflight <rel>: print count of audits pending/running started in the last 50 min (prints 1 on error)
"""
import os, sys, sqlite3, tarfile, shutil, tempfile

def backup(ts):
    src, out = "/d", f"/o/openseo-{ts}.tgz"
    w = tempfile.mkdtemp(prefix="s")
    for root, _dirs, files in os.walk(src):
        for f in files:
            p = os.path.join(root, f); rel = os.path.relpath(p, src); dst = os.path.join(w, rel)
            if f.endswith((".sqlite-wal", ".sqlite-shm")):
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if f.endswith(".sqlite"):
                s = sqlite3.connect(f"file:{p}?mode=ro", uri=True); d = sqlite3.connect(dst)
                s.backup(d); s.close()
                r = d.execute("pragma integrity_check").fetchone()[0]; d.close()
                if r != "ok":
                    print("BAD", rel); sys.exit(1)
            elif os.path.isfile(p) and not os.path.islink(p):
                shutil.copy2(p, dst)
    tmp = out + ".part"
    with tarfile.open(tmp, "w:gz") as t:
        t.add(w, arcname=".")
    os.chown(tmp, 1000, 1000); os.chmod(tmp, 0o600); os.replace(tmp, out)
    shutil.rmtree(w, ignore_errors=True)

def inflight(rel):
    q = ("select count(*) from audits where status in ('pending','running') "
         "and started_at >= datetime('now','-50 minutes')")
    # /d is mounted :ro, where mode=ro can fail to open; fall back to immutable=1 (read-only snapshot)
    for opt in ("mode=ro", "immutable=1"):
        try:
            print(sqlite3.connect(f"file:/d/{rel}?{opt}", uri=True).execute(q).fetchone()[0]); return
        except Exception:
            pass
    print(1)

if __name__ == "__main__":
    {"backup": backup, "inflight": inflight}[sys.argv[1]](sys.argv[2])
