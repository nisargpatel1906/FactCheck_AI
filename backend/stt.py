import base64
import httpx
import logging
import api_keys

logger = logging.getLogger("backend.stt")

async def transcribe_audio(audio_base64: str) -> str:
    """
    Decodes a base64 audio chunk and transcribes it using Groq's Whisper API.
    Rotates through GROQ_API_KEY_1 … GROQ_API_KEY_8 on any failure.
    """
    if not api_keys.groq_keys:
        logger.error("No Groq API keys configured.")
        return ""

    audio_bytes = base64.b64decode(audio_base64)

    for _ in range(len(api_keys.groq_keys)):
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    "https://api.groq.com/openai/v1/audio/translations",
                    headers={"Authorization": f"Bearer {api_keys.groq_keys.current}"},
                    files={"file": ("audio.webm", audio_bytes, "audio/webm")},
                    data={"model": "whisper-large-v3", "response_format": "json"},
                    timeout=30.0,
                )

            if response.status_code == 200:
                return response.json().get("text", "").strip()

            logger.error(
                f"Groq ASR error {response.status_code} "
                f"(key #{api_keys.groq_keys.active_index}): {response.text}"
            )
        except Exception as e:
            logger.error(
                f"Groq transcription exception "
                f"(key #{api_keys.groq_keys.active_index}): {e}"
            )

        if not api_keys.groq_keys.rotate():
            break   # all keys exhausted

    logger.error("Audio transcription failed on all Groq API keys.")
    return ""
