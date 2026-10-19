#!/usr/bin/env bash
# Regenerate (or just check) the pixel baselines of frontend/tests/visual.spec.ts
# in the same environment CI compares them in: the official Playwright image for
# the installed @playwright/test version, on linux/amd64 like GitHub's runners.
#
#   scripts/visual-baselines.sh            # --update-snapshots, writes the PNGs
#   scripts/visual-baselines.sh --check    # compare only, as CI would
#   scripts/visual-baselines.sh --update -g "prism"   # anything after the mode goes to Playwright
#
# Needs Docker (OrbStack / Docker Desktop; Apple silicon runs the amd64 image
# under emulation, which is slower but pixel-identical to CI). The working tree
# is copied into the container — your node_modules are for your OS, not Linux —
# and installed fresh there; npm's cache is kept in a named volume so the
# second run is quick. No backend is needed: the spec scripts its own rooms.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:---update}"
shift || true
extra="$*"
version="$(node -p "require('$root/package-lock.json').packages['frontend/node_modules/@playwright/test']?.version ?? require('$root/package-lock.json').packages['node_modules/@playwright/test'].version")"
image="mcr.microsoft.com/playwright:v${version}-noble"
update='--update-snapshots'
[[ "$mode" == "--check" ]] && update=''

echo "Using $image"
mkdir -p "$root/frontend/tests/__screenshots__"

docker run --rm --platform linux/amd64 --ipc=host \
  -e CI=1 -e WRANGLER_SEND_METRICS=false \
  -v "$root:/src:ro" \
  -v "$root/frontend/tests/__screenshots__:/out" \
  -v games-visual-npm:/root/.npm \
  "$image" bash -euo pipefail -c "
    mkdir -p /work && cd /src
    tar --exclude=node_modules --exclude=dist --exclude=test-results --exclude=playwright-report \
        --exclude=.wrangler --exclude=videos --exclude=.git -cf - . | tar -xf - -C /work
    cd /work && npm ci --no-audit --no-fund --loglevel=error
    cd frontend
    rm -rf tests/__screenshots__ && ln -s /out tests/__screenshots__
    # Only the built site: the visual spec answers its own sockets and API calls.
    cat > /tmp/visual.config.ts <<'EOF'
import base from '/work/frontend/playwright.config'
import { defineConfig } from '@playwright/test'
export default defineConfig({
  ...base,
  testDir: '/work/frontend/tests',
  retries: 0,
  reporter: 'list',
  webServer: {
    command: 'npx vite build --logLevel warn && npx vite preview --port 5173 --host 127.0.0.1 --strictPort',
    cwd: '/work/frontend',
    url: 'http://127.0.0.1:5173',
    timeout: 300000,
  },
})
EOF
    cp /tmp/visual.config.ts ./visual.config.ts
    npx playwright test --config ./visual.config.ts tests/visual.spec.ts $update $extra
  "
