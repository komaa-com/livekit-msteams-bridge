# Voice agent for Teams calls

A minimal LiveKit voice agent the bridge can dispatch onto a Microsoft Teams call:
`worker.py` is an OpenAI STT/LLM/TTS pipeline + silero VAD. The caller talks to
the agent; there is no avatar (for a lip-synced avatar tile see
[`../avatar-agent`](../avatar-agent)).

Any existing LiveKit agent works with the bridge unchanged except for three integration points, all shown in the example:

1. **`agent_name`** in `WorkerOptions` must equal the bridge's `LIVEKIT_AGENT_NAME` (explicit dispatch).
2. **`ctx.job.metadata`** carries per-call JSON from the bridge: `caller_name`, `tenant_id`, `call_direction`, and `user_id` (the caller's AAD id, present only when Teams provides it - use it for per-person memory).
3. **Data topics** (optional): `msteams.context` delivers group-call hints (participant counts, speaker changes, DTMF presses, and the meeting etiquette clause telling the agent to stay quiet unless addressed), `msteams.goodbye` asks the agent to speak a final line because the call is being cut by a time governor, and `msteams.vision` is a byte stream carrying the caller's screen-share/camera as attributed images - this agent feeds them into its chat context. That last one only arrives when the bridge runs with `AMBIENT_VISION=true`.

## Run (uv, recommended)

```bash
cp .env.example .env                 # LIVEKIT_URL/KEY/SECRET, OPENAI_API_KEY
uv lock --upgrade                    # refresh uv.lock (optional; a lock ships in the repo)
uv sync                              # install the environment
uv run python -m livekit.agents download-files      # prefetch model weights (silero VAD etc.)
uv run worker.py dev                 # hot-reloading dev mode; `start` for production
```

Prefer plain pip? `pip install -r requirements.txt && python worker.py dev` works too.

## Run (Docker)

`download-files` is baked at build time so cold starts are fast, and secrets are passed at RUNTIME (never into the image):

```bash
docker build -f Dockerfile -t standin-agent .
docker run --env-file .env standin-agent      # ENTRYPOINT runs `start`
```

## Connect to Teams

Run the bridge (see [`../basic-bridge`](../basic-bridge) or `npx @komaa/livekit-msteams-bridge`) with `LIVEKIT_AGENT_NAME=standin-agent`, point a StandIn identity at it, and call your Teams bot.

Swap the plugins freely - Azure/Google STT+TTS, a LangChain graph through `livekit-plugins-langchain`, an OpenAI Realtime session: the bridge only relays room audio and never sees your model stack.
