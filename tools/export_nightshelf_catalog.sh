#!/bin/bash
# Export the app's full volumes, complete selections, and prepared Originals.
# No story text or private saved stories are read by the metadata exporter.
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 || ( $# -eq 2 && "$2" != "--check" ) ]]; then
  echo "Usage: $0 /path/to/Nightshelf-repository [--check]" >&2
  exit 2
fi
SITE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_REPO="$(cd "$1" && pwd)"
SOURCE="$APP_REPO/Nightshelf/Nightshelf"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
swiftc -O -parse-as-library \
  "$SOURCE/BookText.swift" "$SOURCE/SleepCatalog.swift" \
  "$SOURCE/BedtimeSelections.swift" "$SOURCE/OriginalStories.swift" \
  "$APP_REPO/scripts/booktext_probe/Stubs.swift" \
  "$SITE/tools/export_nightshelf_catalog.swift" \
  -o "$BUILD/export-catalog"
"$BUILD/export-catalog" > "$BUILD/shared-book-catalog.js"
if [[ "${2:-}" == "--check" ]]; then
  if ! cmp -s "$BUILD/shared-book-catalog.js" "$SITE/nightshelf/shared-book-catalog.js"; then
    echo "Shared catalog differs from the supplied app source." >&2
    exit 1
  fi
  echo "PASS: shared catalog matches the supplied app source."
else
  cat "$BUILD/shared-book-catalog.js"
fi
