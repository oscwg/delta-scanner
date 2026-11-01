#!/usr/bin/env bash
# Used by the GitHub Actions workflow to rescan SEC every 10 minutes inside one long run.
#   bash tools/loop.sh once   -> one scan, then publish it
#   bash tools/loop.sh        -> keep scanning at each 10-minute mark until LOOP_MINUTES have passed
# Each successful scan's flags.json is force-pushed as a single commit to the `data` branch, which the website reads
# (no history builds up, so the repo stays small). A failed scan publishes nothing; the previous data stays live.
set -uo pipefail
EVERY=${SCAN_EVERY_SECONDS:-600}
END=$(( $(date +%s) + ${LOOP_MINUTES:-50} * 60 ))

publish() {
  local tmp; tmp=$(mktemp -d)
  cp docs/data/flags.json "$tmp/" && (
    cd "$tmp" && git init -q && git checkout -q -b data && git add flags.json &&
    git -c user.name="delta-scanner-bot" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit -qm "Scan $(date -u +%Y-%m-%dT%H:%MZ)" &&
    git push -qf "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" data
  ) && echo "Published scan to the data branch."
  rm -rf "$tmp"
}

scan() {
  echo "::group::Scan $(date -u +%H:%M:%S)"
  local ok=1
  node scan.js 2>&1 | tee -a docs/data/scan-log.txt || ok=0
  echo "::endgroup::"
  [ "$ok" = 1 ] && publish
}

if [ "${1:-}" = "once" ]; then scan; exit 0; fi

while :; do
  now=$(date +%s); next=$(( (now / EVERY + 1) * EVERY ))
  # stop when the next scan could not finish (~4 min) before this run's time is up
  [ $(( next + 240 )) -gt "$END" ] && { echo "Time window used; the next scheduled run takes over."; break; }
  sleep $(( next - now ))
  scan
done
exit 0
