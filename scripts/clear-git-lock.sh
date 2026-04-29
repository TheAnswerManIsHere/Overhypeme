#!/bin/bash
LOCK=/home/runner/workspace/.git/index.lock
if [ -f "$LOCK" ] && [ ! -s "$LOCK" ]; then
  echo "Removing stale 0-byte git lock file..."
  rm "$LOCK"
  echo "Done."
else
  echo "No stale lock file found (or it has content — not removing)."
fi
