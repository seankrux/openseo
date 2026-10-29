#!/bin/bash
# Exit 0 only if health, /overview, GSC and GA4 for casselberrycrawlspacerepair.com work.
P=03bc260c-5af8-452c-94af-5a22e6537336; D=$(dirname $0); fail=0
curl -sf -m 20 http://127.0.0.1:3001/api/health | grep -q '"status":"ok"' && echo "health ok" || { echo "health FAIL"; fail=1; }
c=$(curl -s -o /dev/null -w '%{http_code}' -m 60 http://127.0.0.1:3001/overview); [ "$c" = 200 ] && echo "overview 200" || { echo "overview $c FAIL"; fail=1; }
g=$($D/mcp.sh get_search_console_performance "{\"projectId\":\"$P\",\"dimensions\":[\"date\"],\"rowLimit\":5}")
echo "$g" | grep -q '"isError":true\|"connected":false\|"ok":false' || ! echo "$g" | grep -q 'clicks' && { echo "GSC FAIL: ${g:0:300}"; fail=1; } || echo "gsc ok"
a=$($D/mcp.sh get_google_analytics_organic_overview "{\"projectId\":\"$P\"}")
echo "$a" | grep -q '"isError":true\|"connected":false' && { echo "GA4 FAIL: ${a:0:300}"; fail=1; } || { echo "$a" | grep -q '"status":"ok"' && echo "ga4 ok" || { echo "GA4 FAIL: ${a:0:300}"; fail=1; }; }
exit $fail
