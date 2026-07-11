---
title: Contributing
description: How to build, test, and propose changes to the bridge.
---

Contributions are welcome. The bridge is deliberately small and dependency-light; the bar is that a change keeps the transport hardening intact and ships with tests.

## Develop

```bash
git clone https://github.com/komaa-com/livekit-msteams-bridge
cd livekit-msteams-bridge
npm install
```

```bash
npm run dev        # run from source (tsx), env-configured
npm run typecheck  # tsc --noEmit (strict, noUnusedLocals/Parameters)
npm test           # node:test suites (FakeRoom - no network, no native module)
npm run build      # emit dist/
```

The test suites drive full calls against a `FakeRoom` injected through `startServer(cfg, connector)`, so they run without LiveKit or the native `@livekit/rtc-node` module. Add tests the same way when you touch the session or transport.

## Guidelines

- **Keep the hardening.** The transport checks (caps before crypto, replay guard, dead-peer, 409 dedup, drain) are load-bearing - don't regress them, and add a test if you extend them.
- **Types are strict.** `strict` plus `noUnusedLocals`/`noUnusedParameters` are on; dead code fails the typecheck.
- **Audio stays 16 kHz mono PCM16** end to end. If you change the room connector, keep the sample rate.
- **One JSON object per WS frame**, discriminated on `type` - see [Wire Protocol](/livekit-msteams-bridge/wire-protocol/).

## Submitting

Open a pull request against `main`. CI runs typecheck, tests, and build on Node 20 and 22, plus `npm pack --dry-run`. Keep the change focused and describe the behavior it changes.

Bugs and feature requests: [GitHub issues](https://github.com/komaa-com/livekit-msteams-bridge/issues).
