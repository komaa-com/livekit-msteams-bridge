# Contributing

Thanks for your interest in improving `@komaa/livekit-msteams-bridge`. This guide covers local
setup, the conventions we follow, and how releases work.

## Prerequisites

- Node.js `>= 20` and npm.
- For running a real call end to end: a LiveKit server (Cloud project or self-hosted) with an API
  key/secret, a LiveKit agent, and a StandIn identity (the [sandbox](https://standin.komaa.com) is
  enough to get a call).

## Local setup

```bash
git clone https://github.com/komaa-com/livekit-msteams-bridge
cd livekit-msteams-bridge
npm ci
npm run typecheck   # tsc --noEmit (strict, noUnusedLocals/noUnusedParameters)
npm test            # node:test suites (HMAC vectors, protocol, full relay via FakeRoom)
npm run build       # tsc -> dist/
```

The package is authored in TypeScript under `src/` and compiled to `dist/`. `dist/` is **not**
committed; `prepublishOnly` runs typecheck + tests + build, so what ships is always freshly built
from the reviewed source.

## Working on it

- `npm run dev` runs the CLI from source (`tsx src/cli.ts`), entirely env-configured; copy
  `.env.example` and fill in the required values.
- The tests drive a full fake call (HMAC upgrade, session start, audio relay both ways, governors,
  teardown) without any network dependency - a `FakeRoom` injected through
  `startServer(cfg, connector)` stands in for LiveKit, so the native `@livekit/rtc-node` module is
  never loaded in tests. Add or extend tests alongside behavior changes; lifecycle edge cases
  (teardown paths, timers, dead-peer, reconnects) especially need them.
- The wire contract with the StandIn media bridge is fixed - message shapes in `src/protocol.ts`
  must not change field names or casing. New OUTBOUND capabilities are additive.
- Keep the transport hardening intact (caps before crypto, replay guard, dead-peer, 409 dedup,
  drain) and audio at 16 kHz mono PCM16 end to end.

## Branches and pull requests

- Branch from `main`; use a short prefixed name, e.g. `feat/…`, `fix/…`, `docs/…`, `ci/…`.
- CI runs typecheck, tests, and build on Node 20 and 22, plus `npm pack --dry-run`.
- Keep changes focused and describe the behavior they change.

## Releases

Publishing is by version tag: bump `version` in `package.json`, tag `vX.Y.Z` matching it, and push
the tag. The `publish.yml` workflow runs `prepublishOnly` and publishes to npm with provenance. The
docs site (`website/`) deploys to GitHub Pages on any change under `website/`.

Bugs and feature requests: [GitHub issues](https://github.com/komaa-com/livekit-msteams-bridge/issues).
