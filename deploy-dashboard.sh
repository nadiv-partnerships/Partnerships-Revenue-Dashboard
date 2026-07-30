#!/bin/bash
DASH=$(find "$HOME/Library/Application Support/Claude" -name "partner-dashboard.html" 2>/dev/null | head -1)
[ -z "$DASH" ] && echo "File not found" >> /tmp/rillet-deploy.log && exit 1
cp "$DASH" "$HOME/Desktop/rillet/index.html"
cd "$HOME/Desktop/rillet"
vercel --prod --yes --token vcp_1YKETtdbHRbnA9PuKKUmR9ArHAemn5004m2ACZCxlWPjNefuOv0b0qkY >> /tmp/rillet-deploy.log 2>&1
echo "Deployed at $(date)" >> /tmp/rillet-deploy.log
