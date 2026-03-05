#!/bin/bash
# Check for approved requests — zero tokens if empty
# Run via cron every 5 min

API_URL="${PAGER_API_URL:-http://localhost:3100}"
API_KEY="${PAGER_API_KEY}"

if [ -z "$API_KEY" ]; then
  echo "PAGER_API_KEY not set"
  exit 1
fi

response=$(curl -sf -H "Authorization: Bearer $API_KEY" "$API_URL/requests?status=approved" 2>/dev/null)
if [ $? -ne 0 ]; then
  exit 1
fi

count=$(echo "$response" | jq 'length' 2>/dev/null)
if [ "$count" -gt "0" ]; then
  openclaw system event --text "📧 $count approved request(s) to execute: $(echo "$response" | jq -r '.[].summary' | head -3 | tr '\n' '; ')" --mode now
fi
