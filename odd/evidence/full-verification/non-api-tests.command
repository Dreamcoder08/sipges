timeout --kill-after=10s 600s pnpm -r --workspace-concurrency=1 --filter '!@sipges/api' run test
