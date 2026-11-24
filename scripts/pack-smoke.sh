#!/bin/sh
# Packs the package the way npm publishes it, installs the tarball in an empty project and runs the
# library and the `open-sb` CLI from it, so a broken `files`, `exports` or `bin` fails here, not for users.
set -eu
root=$(pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

rm -rf dist
pnpm run build
tarball=$(npm pack --silent --pack-destination "$work" | tail -n 1)

cd "$work"
npm init -y >/dev/null
npm install --no-audit --no-fund --silent "$work/$tarball"
cat > sandbox.config.mjs <<'EOF'
import { defineConfig } from "@invertix/open-sb";
import { docker } from "@invertix/open-sb/docker";

export default defineConfig({ requires: ["pause"], providers: [docker()] });
EOF
npx --no-install open-sb check
node --input-type=module -e 'import { failover } from "@invertix/open-sb"; import { conformance } from "@invertix/open-sb/conformance"; if (typeof failover !== "function" || typeof conformance !== "function") process.exit(1);'
echo "pack smoke test passed ($tarball)"
cd "$root"
