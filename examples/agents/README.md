# Example LiveKit agents for Teams calls

Two ready-made agents the bridge can dispatch onto a Microsoft Teams call:

| File | What it is |
|---|---|
| `voice_agent.py` | Minimal voice pipeline (OpenAI STT/LLM/TTS + silero VAD). Start here. |
| `avatar_agent.py` | Same, plus a [bitHuman](https://github.com/livekit/agents/tree/main/examples/avatar_agents/bithuman) avatar - the caller hears the avatar's synchronized voice. |

Any existing LiveKit agent works with the bridge unchanged except for three integration points, all shown in the examples:

1. **`agent_name`** in `WorkerOptions` must equal the bridge's `LIVEKIT_AGENT_NAME` (explicit dispatch).
2. **`ctx.job.metadata`** carries per-call JSON from the bridge: `caller_name`, `tenant_id`, `call_direction`, and `user_id` (the caller's AAD id, present only when Teams provides it - use it for per-person memory).
3. **Data topics** (optional): `teams.context` delivers group-call hints (participant counts, DTMF presses) and `teams.goodbye` asks the agent to speak a final line because the call is being cut by a time governor.

## Run (uv, recommended)

```bash
cp .env.example .env                     # LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, OPENAI_API_KEY
uv lock --upgrade                        # refresh uv.lock (optional; a lock ships in the repo)
uv sync                                  # install the environment
uv run voice_agent.py download-files    # prefetch model weights (silero VAD etc.)
uv run voice_agent.py dev               # hot-reloading dev mode; `start` for production
```

Same flow for the avatar: `uv run avatar_agent.py download-files && uv run avatar_agent.py dev` (also needs `BITHUMAN_API_SECRET` + `BITHUMAN_MODEL_PATH` in `.env`).

Prefer plain pip? `pip install -r requirements.txt && python voice_agent.py dev` works too.

## Run (Docker)

Each agent has its own Dockerfile; `download-files` is baked at build time so cold starts are fast, and secrets are passed at RUNTIME (never into the image):

```bash
docker build -f Dockerfile.voice_agent -t standin-voice-agent .
docker run --env-file .env standin-voice-agent           # ENTRYPOINT runs `start`

docker build -f Dockerfile.avatar_agent -t standin-avatar-agent .
docker run --env-file .env \
  -v ./avatar.imx:/models/avatar.imx \
  -e BITHUMAN_MODEL_PATH=/models/avatar.imx \
  standin-avatar-agent
```

## Connect to Teams

Run the bridge (see [`../basic-bridge`](../basic-bridge) or `npx @komaa/livekit-msteams-bridge`) with `LIVEKIT_AGENT_NAME=standin-voice-agent` (or `standin-avatar-agent`), point a StandIn identity at it, and call your Teams bot.

Swap the plugins freely - Azure/Google STT+TTS, a LangChain graph through `livekit-plugins-langchain`, an OpenAI Realtime session: the bridge only relays room audio and never sees your model stack.
