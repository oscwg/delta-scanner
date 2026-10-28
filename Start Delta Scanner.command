#!/bin/bash
# Double-click to run Delta Scanner on this Mac: opens http://localhost:8787 and rescans SEC every 10 minutes.
# Keep this window open while you use it; close it (or press Ctrl-C) to stop.
cd "$(dirname "$0")" || exit 1

if [ ! -s .sec-agent ]; then
  echo "The SEC asks every automated tool to identify who is using it (sent only to sec.gov, in the User-Agent header)."
  read -r -p "Your name: " NAME
  read -r -p "Your email: " EMAIL
  if [[ "$EMAIL" != *@* ]]; then echo "That doesn't look like an email address. Double-click to try again."; read -r; exit 1; fi
  echo "DeltaScanner $NAME $EMAIL" > .sec-agent
fi

if command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)'; then
  NODE=node
elif [ -x "/Applications/Claude.app/Contents/MacOS/Claude" ]; then
  # the Claude desktop app ships a modern Node runtime
  export ELECTRON_RUN_AS_NODE=1
  NODE="/Applications/Claude.app/Contents/MacOS/Claude"
else
  echo "Delta Scanner needs Node.js 18 or newer. Install it from https://nodejs.org, then double-click this file again."
  open "https://nodejs.org"; read -r; exit 1
fi

"$NODE" serve.js
