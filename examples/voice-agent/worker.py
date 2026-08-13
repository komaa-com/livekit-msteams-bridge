"""Minimal LiveKit voice agent that answers Microsoft Teams calls via
@komaa/livekit-msteams-bridge.

Nothing here is Teams-specific except three small things the bridge gives you:
  1. agent_name        - the bridge dispatches you by this name (explicit dispatch)
  2. ctx.job.metadata  - per-call JSON: caller_name, tenant_id, call_direction,
                         user_id (caller AAD id, present only when Teams knows it)
  3. data topics       - "msteams.context" (participants/DTMF hints), "msteams.goodbye"
                         (speak this line, the call is ending), and "msteams.vision"
                         (a byte stream: the caller's screen/camera, when the bridge
                         runs with AMBIENT_VISION=true)

Swap the STT/LLM/TTS plugins for any stack you like (Azure, Google, Deepgram,
OpenAI realtime, a LangChain graph via livekit-plugins-langchain, ...) - the
bridge does not care, it only relays room audio.

Run:  python worker.py dev
Env:  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, OPENAI_API_KEY
"""

import asyncio
import base64
import json
import os

from dotenv import load_dotenv
from livekit import rtc
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
from livekit.agents.llm import ImageContent
from livekit.plugins import openai, silero

load_dotenv()

AGENT_NAME = "standin-agent"  # must equal the bridge's LIVEKIT_AGENT_NAME


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()


async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    # Per-call context from the bridge (all fields are strings; user_id may be absent)
    meta = json.loads(ctx.job.metadata) if ctx.job.metadata else {}
    caller_name = meta.get("caller_name", "caller")

    # Three ways to build the pipeline, picked from what the environment actually offers.
    #
    # AZURE_OPENAI_REALTIME_DEPLOYMENT is preferred where it exists: a speech-to-speech model needs
    # NO separate STT and TTS deployments. That matters because an Azure OpenAI resource commonly has
    # only chat models deployed - this one has gpt-realtime and two dozen chat models but no `whisper`
    # and no `tts-1` - and the STT/LLM/TTS pipeline then fails with 404 DeploymentNotFound on the two
    # speech legs while the LLM leg works, which reads as "the agent answers but never speaks".
    az_ep = os.environ.get("AZURE_OPENAI_ENDPOINT")
    az_key = os.environ.get("AZURE_OPENAI_API_KEY")
    rt_deployment = os.environ.get("AZURE_OPENAI_REALTIME_DEPLOYMENT")

    if az_ep and az_key and rt_deployment:
        session = AgentSession(
            llm=openai.realtime.RealtimeModel.with_azure(
                azure_deployment=rt_deployment,
                # Realtime is served from a DIFFERENT host and api-version than the chat/embeddings
                # deployments on the same Azure resource: wss://<res>.cognitiveservices.azure.com,
                # not <res>.openai.azure.com, which 404s the websocket handshake. Overridable, and
                # defaulted from the general values so a resource that does serve both still works.
                azure_endpoint=os.environ.get("AZURE_OPENAI_REALTIME_ENDPOINT", az_ep),
                api_key=az_key,
                api_version=os.environ.get("AZURE_OPENAI_REALTIME_API_VERSION")
                or os.environ.get("AZURE_OPENAI_API_VERSION"),
                voice=os.environ.get("AZURE_OPENAI_REALTIME_VOICE", "marin"),
            ),
        )
    elif az_ep and az_key:
        # Azure with separate speech deployments. Only works if the resource actually has them.
        az = dict(azure_endpoint=az_ep, api_key=az_key,
                  api_version=os.environ.get("AZURE_OPENAI_API_VERSION"))
        session = AgentSession(
            stt=openai.STT.with_azure(model=os.environ.get("AZURE_OPENAI_STT_DEPLOYMENT", "whisper"), **az),
            llm=openai.LLM.with_azure(model=os.environ.get("AZURE_OPENAI_MODEL_NAME", "gpt-4o-mini"), **az),
            tts=openai.TTS.with_azure(model=os.environ.get("AZURE_OPENAI_TTS_DEPLOYMENT", "tts-1"),
                                      voice=os.environ.get("AZURE_OPENAI_TTS_VOICE", "alloy"), **az),
            vad=ctx.proc.userdata["vad"],
        )
    else:
        session = AgentSession(
            stt=openai.STT(),
            llm=openai.LLM(model="gpt-4o-mini"),
            tts=openai.TTS(voice="alloy"),
            vad=ctx.proc.userdata["vad"],
        )


    # Bridge data topics: group-call context and the governor goodbye
    @ctx.room.on("data_received")
    def on_data(packet: rtc.DataPacket):
        try:
            payload = json.loads(packet.data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return
        if packet.topic == "msteams.context":
            # non-interrupting hints ("3 humans on the call", "caller pressed 5");
            # use them however fits your agent (steer behavior, log, drive an IVR)
            print(f"[msteams.context] {payload.get('text', '')}")
        elif packet.topic == "msteams.goodbye":
            # the call is being cut (time limit): say this line now
            session.say(payload.get("text", "Goodbye!"), allow_interruptions=False)

    # Ambient vision (only when the bridge runs with AMBIENT_VISION=true). One image per
    # stream, already attributed: attributes carry source / owner / caption / width / height / ts.
    # The bridge sends ONLY changed frames and caps the rate, so this stays cheap - but every
    # image you keep is tokens on the next turn, so this drops each one into the context and
    # lets it age out naturally rather than pinning a gallery.
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
                f"You are a helpful voice assistant on a Microsoft Teams call with {caller_name}. "
                "Keep answers short and conversational; the caller hears you, they do not read you."
            ),
        ),
        room=ctx.room,
    )

    await session.generate_reply(
        instructions=f"Greet {caller_name} briefly and ask how you can help. Under 25 words.",
        allow_interruptions=False,
    )


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
            worker_type=WorkerType.ROOM,
            agent_name=AGENT_NAME,
        ),
    )
