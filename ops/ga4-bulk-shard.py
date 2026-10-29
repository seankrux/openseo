#!/usr/bin/env python3
"""Drive GA4 setup for one shard of missing projects through the local OpenSEO MCP.

Sequential per shard; shards use disjoint projectIds so nothing is created twice.
Writes one JSONL line per site and stops the shard if errors become systemic.
"""
import json, os, sys, time, urllib.request, urllib.error

MCP = "http://127.0.0.1:3001/mcp"
CHUNK = int(os.environ.get("CHUNK", "30"))
BREAKER = int(os.environ.get("BREAKER", "8"))
OUT = os.environ.get("OUT", "/mnt/gdrive/tokyo/Outputs/ga4-bulk")


def call(name, arguments, timeout=1800):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": name, "arguments": arguments}}).encode()
    req = urllib.request.Request(MCP, data=body, headers={
        "content-type": "application/json", "accept": "application/json, text/event-stream"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode()
    return json.loads(raw)["result"]["structuredContent"]


def main():
    shard = int(sys.argv[1])
    ids = json.load(open(f"/tmp/openseo2/shards/{shard}.json"))
    os.makedirs(OUT, exist_ok=True)
    log = open(f"{OUT}/shard{shard}.jsonl", "a")
    consecutive = 0
    done = 0
    for i in range(0, len(ids), CHUNK):
        chunk = ids[i:i + CHUNK]
        t0 = time.time()
        try:
            res = call("ga4_setup_missing", {"limit": len(chunk), "projectIds": chunk,
                                             "apply": True, "confirm": True})
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError) as e:
            print(f"[shard {shard}] chunk {i} transport error: {str(e)[:200]}", flush=True)
            time.sleep(30)
            continue
        for x in res.get("results", []):
            log.write(json.dumps({"t": time.strftime("%FT%T"), **x}) + "\n")
            log.flush()
            done += 1
            if x.get("final") == "error":
                consecutive += 1
            else:
                consecutive = 0
            if x.get("final") == "error":
                det = next((s.get("detail", "") for s in x.get("steps", []) if s.get("status") == "error"), "")
                print(f"[shard {shard}] ERROR {x['domain']}: {det[:160]}", flush=True)
        print(f"[shard {shard}] {done}/{len(ids)} missing={res.get('missingTotal')} "
              f"chunk={time.time() - t0:.0f}s", flush=True)
        if consecutive >= BREAKER:
            print(f"[shard {shard}] circuit breaker: {consecutive} consecutive errors, stopping", flush=True)
            break
        time.sleep(2)
    log.close()
    print(f"[shard {shard}] finished {done}/{len(ids)}", flush=True)


if __name__ == "__main__":
    main()
