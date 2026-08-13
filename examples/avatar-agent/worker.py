"""LiveKit avatar agent (bitHuman) answering Microsoft Teams calls via
@komaa/livekit-msteams-bridge.

A minimal voice pipeline (OpenAI STT/LLM/TTS + silero VAD) plus a bitHuman
AvatarSession, following LiveKit's avatar example
(https://github.com/livekit/agents/tree/main/examples/avatar_agents/bithuman).
The Teams caller HEARS the avatar's synchronized voice; the avatar's video
stays in the LiveKit room in v1 (the Teams video tile is rendered by the
StandIn media bridge's own animated avatar).

Run:  python worker.py dev
Env:  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, OPENAI_API_KEY,
      BITHUMAN_API_SECRET, BITHUMAN_MODEL_PATH (an .imx avatar model)
"""

import asyncio
import base64
import json
import os

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents.llm import ImageContent
from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    JobProcess,
    WorkerOptions,
    WorkerType,
    cli,
)
from bithuman import AsyncBithuman
from livekit.plugins import bithuman, openai, silero

load_dotenv()

AGENT_NAME = "standin-agent"  # must equal the bridge's LIVEKIT_AGENT_NAME


def prewarm(proc: JobProcess):
    # VAD loads here, in the prewarmed process, so a dispatch never waits on it.
    proc.userdata["vad"] = silero.VAD.load()
    # The bitHuman runtime is created in the entrypoint: its factory is a coroutine and prewarm is
    # sync. It is cached on the process, so the ~2 min first .imx conversion is paid once per worker
    # process rather than once per call.
    proc.userdata["bithuman"] = None


async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_ALL)

    meta = json.loads(ctx.job.metadata) if ctx.job.metadata else {}
    caller_name = meta.get("caller_name", "caller")

    # Azure realtime first where a deployment exists: it is speech-to-speech, so it needs no separate
    # whisper/tts deployments - an Azure OpenAI resource commonly has neither. Realtime is served from
    # <res>.cognitiveservices.azure.com, NOT <res>.openai.azure.com, which 404s the websocket.
    # The avatar lip-syncs whatever audio the session produces, so it works with either pipeline.
    az_ep = os.environ.get("AZURE_OPENAI_ENDPOINT")
    az_key = os.environ.get("AZURE_OPENAI_API_KEY")
    rt_deployment = os.environ.get("AZURE_OPENAI_REALTIME_DEPLOYMENT")

    if az_ep and az_key and rt_deployment:
        session = AgentSession(
            llm=openai.realtime.RealtimeModel.with_azure(
                azure_deployment=rt_deployment,
                azure_endpoint=os.environ.get("AZURE_OPENAI_REALTIME_ENDPOINT", az_ep),
                api_key=az_key,
                api_version=os.environ.get("AZURE_OPENAI_REALTIME_API_VERSION")
                or os.environ.get("AZURE_OPENAI_API_VERSION"),
                voice=os.environ.get("AZURE_OPENAI_REALTIME_VOICE", "cedar"),
            ),
        )
    else:
        session = AgentSession(
            stt=openai.STT(),
            llm=openai.LLM(model="gpt-4o-mini"),
            tts=openai.TTS(voice="alloy"),
            vad=ctx.proc.userdata["vad"],
        )

    # the avatar runtime lip-syncs the session's TTS and publishes
    # synchronized audio+video into the room; the bridge relays the audio to Teams.
    # Reuse the runtime prewarmed above so this call starts instantly.
    if ctx.proc.userdata.get("bithuman") is None:
        ctx.proc.userdata["bithuman"] = await AsyncBithuman.create(
            model_path=os.environ["BITHUMAN_MODEL_PATH"],
            api_secret=os.environ["BITHUMAN_API_SECRET"],
        )

    avatar = bithuman.AvatarSession(
        model_path=os.environ["BITHUMAN_MODEL_PATH"],
        api_secret=os.environ["BITHUMAN_API_SECRET"],
        runtime=ctx.proc.userdata["bithuman"],
    )
    await avatar.start(session, room=ctx.room)

    @ctx.room.on("data_received")
    def on_data(packet: rtc.DataPacket):
        try:
            payload = json.loads(packet.data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return
        if packet.topic == "msteams.goodbye":
            session.say(payload.get("text", "Goodbye!"), allow_interruptions=False)


    # Ambient vision (only when the bridge runs with AMBIENT_VISION=true). One image per stream,
    # already attributed: attributes carry source / owner / caption / width / height / ts. The bridge
    # sends only CHANGED frames and caps the rate, so this stays cheap - but every image kept is
    # tokens on the next turn, so each one is dropped into the context and left to age out rather
    # than pinning a gallery.
    #
    # Without this the agent has no picture at all, and a model asked "what is on my screen?" answers
    # confidently from nothing. Ported from ../voice-agent, whose README this file used to defer to.
    def on_vision(reader: rtc.ByteStreamReader, participant_identity: str):
        async def consume():
            attrs = reader.info.attributes or {}
            data = b"".join([chunk async for chunk in reader])
            mime = reader.info.mime_type or "image/jpeg"
            caption = attrs.get("caption", "Live frame of the call.")
            print(f"[msteams.vision] {caption} ({len(data)} bytes, {attrs.get('source')})")
            # Nothing here asks the agent to speak: the image is context for its NEXT turn.
            agent = session.current_agent
            chat_ctx = agent.chat_ctx.copy()
            chat_ctx.add_message(
                role="user",
                content=[
                    caption,
                    ImageContent(image=f"data:{mime};base64,{base64.b64encode(data).decode()}"),
                ],
            )
            await agent.update_chat_ctx(chat_ctx)

        asyncio.create_task(consume())

    ctx.room.register_byte_stream_handler("msteams.vision", on_vision)

    await session.start(
        agent=Agent(
            instructions=(
                f"You are a friendly avatar assistant on a Microsoft Teams call with {caller_name}. "
                "Keep answers short and natural."
            ),
        ),
        room=ctx.room,
    )

    await session.generate_reply(
        instructions=f"Greet {caller_name} briefly. Under 25 words.",
        allow_interruptions=False,
    )


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
            worker_type=WorkerType.ROOM,
            agent_name=AGENT_NAME,
            # The one-time .imx conversion can take minutes; the default 60s
            # process-init deadline would kill the worker mid-load.
            initialize_process_timeout=300,
            # Keep one process warm so avatar dispatch is instant, not a cold load.
            num_idle_processes=1,
        ),
    )
