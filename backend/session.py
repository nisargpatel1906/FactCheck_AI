import asyncio

class SessionState:
    """
    Manages the active state and rolling transcript buffer for an individual client connection.
    """
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.active = True
        self._buffer = []
        self._lock = asyncio.Lock()

    async def append_text(self, text: str):
        """
        Appends a new phrase or text segment to the rolling buffer.
        """
        if not text.strip():
            return
        async with self._lock:
            self._buffer.append(text.strip())

    async def pop_buffer(self) -> str:
        """
        Retrieves the consolidated transcript buffer contents and clears the buffer.
        """
        async with self._lock:
            content = " ".join(self._buffer)
            self._buffer.clear()
            return content

    async def close(self):
        """
        Closes the session state.
        """
        self.active = False
