from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import Callable

from fastapi.responses import StreamingResponse


def sse_event(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def make_sse_response(
    worker: Callable[[Callable[[dict], None]], None],
) -> StreamingResponse:
    """Create an SSE StreamingResponse that runs worker in a background thread.

    worker(send) is called in a daemon thread. Call send(event_dict) to push
    events. Unhandled exceptions become {"type": "error"} events. The stream
    closes automatically when worker returns.
    """
    async def event_gen():
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        def send(data: dict) -> None:
            asyncio.run_coroutine_threadsafe(queue.put(data), loop)

        def run() -> None:
            try:
                worker(send)
            except Exception as e:
                send({"type": "error", "content": str(e)})
            finally:
                asyncio.run_coroutine_threadsafe(queue.put(None), loop)

        threading.Thread(target=run, daemon=True).start()
        while True:
            msg = await queue.get()
            if msg is None:
                break
            yield sse_event(msg)

    return StreamingResponse(event_gen(), media_type="text/event-stream")
