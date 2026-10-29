#!/bin/bash
# mcp.sh <tool> '<json args>'  -> raw JSON-RPC result from local OpenSEO /mcp
curl -s -m ${MCP_TIMEOUT:-120} -X POST http://127.0.0.1:3001/mcp -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":${2:-{\}}}}"
