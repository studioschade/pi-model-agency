#!/usr/bin/env bash
# Deterministic tests (no model/network). Install dependencies with `npm ci` first.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1 || ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=19)?0:1)' ; then
  echo 'run.sh: Node >=22.19 is required on PATH' >&2
  exit 1
fi
if ! node --input-type=module -e "import('typebox')" >/dev/null 2>&1; then
  echo "run.sh: typebox is not installed — run 'npm ci' in the project root" >&2
  exit 1
fi

# Harness imports ./ext-copy.ts so the copy resolves TypeBox from this package.
cp ../extension.ts ext-copy.ts
trap 'rm -f ext-copy.ts' EXIT
node --experimental-strip-types harness.mjs
