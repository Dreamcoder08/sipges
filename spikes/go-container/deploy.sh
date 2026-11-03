#!/usr/bin/env bash
# Builds the image locally, pushes it to the Cloudflare registry and deploys the
# spike Worker with that exact image. Works without `docker buildx`, which
# `wrangler deploy` needs when it builds the Dockerfile itself.
# Secrets are set separately, after the first deploy:
#   printf %s "$URL" | npx wrangler secret put DATABASE_URL        (and DATABASE_URL_POOLED, SPIKE_TOKEN)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tag="sipges-go-spike:$(git -C "$here" rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)"

docker build --target runtime -t "$tag" "$here"
cd "$here/worker"
image=$(npx wrangler containers push "$tag" | sed -n 's/^Pushed image: //p')
[[ -n "$image" ]] || { echo "push did not report an image reference" >&2; exit 1; }

# Same config, image replaced by the pushed reference (file is git-ignored).
node -e '
  const fs = require("node:fs");
  const text = fs.readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "");
  const config = JSON.parse(text);
  config.containers[0].image = process.argv[1];
  delete config.containers[0].image_build_context;
  fs.writeFileSync(".wrangler.generated.json", JSON.stringify(config, null, 2));
' "$image"
npx wrangler deploy -c .wrangler.generated.json
