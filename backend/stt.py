import base64
import httpx
import logging
import config

logger = logging.getLogger("backend.stt")

async def transcribe_audio(audio_base64: str) -> str:
    """
    Decodes a base64 audio chunk and transcribes it using Groq's Whisper API.
    """
    if not config.GROQ_API_KEY:
        logger.error("GROQ_API_KEY is not configured.")
        return ""

    try:
        # Decode the base64 WAV payload
        audio_bytes = base64.b64decode(audio_base64)
        
        # Groq Whisper API endpoint
        url = "https://api.groq.com/openai/v1/audio/transcriptions"
        headers = {
            "Authorization": f"Bearer {config.GROQ_API_KEY}"
        }
        
        # httpx files payload expects (filename, file_bytes, content_type)
        files = {
            "file": ("audio.wav", audio_bytes, "audio/wav")
        }
        
        data = {
            "model": "whisper-large-v3-turbo",
            "language": "en",
            "response_format": "json"
        }
        
        async with httpx.AsyncClient() as client:
            response = await client.post(url, headers=headers, files=files, data=data, timeout=30.0)
            
        if response.status_code != 200:
            logger.error(f"Groq ASR API returned error {response.status_code}: {response.text}")
            return ""
            
        result = response.json()
        transcript = result.get("text", "").strip()
        return transcript

    except Exception as e:
        logger.error(f"Failed to transcribe audio chunk: {e}")
        return ""
