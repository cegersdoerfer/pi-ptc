import asyncio
import json
import sys
from typing import Dict, Any, List, Optional

class RpcClient:
    """RPC client for calling tools from Python code"""

    def __init__(self):
        self.call_id = 0
        self.pending_calls: Dict[str, asyncio.Future] = {}
        self.reader_task: Optional[asyncio.Task] = None

    async def start_reader(self):
        """Start background task to read responses from stdin"""
        self.reader_task = asyncio.create_task(self._stdin_reader())

    async def _stdin_reader(self):
        """Read responses from stdin and dispatch to pending calls"""
        try:
            loop = asyncio.get_event_loop()
            reader = asyncio.StreamReader()
            protocol = asyncio.StreamReaderProtocol(reader)
            await loop.connect_read_pipe(lambda: protocol, sys.stdin)

            while True:
                line = await reader.readline()
                if not line:
                    break

                try:
                    response = json.loads(line.decode().strip())
                    self._handle_response(response)
                except json.JSONDecodeError as e:
                    print(f"JSON decode error: {e}", file=sys.stderr)
                except Exception as e:
                    print(f"Error handling response: {e}", file=sys.stderr)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"stdin reader error: {e}", file=sys.stderr)

    def _handle_response(self, response: dict):
        """Called when stdin receives a response"""
        call_id = response.get("id")
        if call_id and call_id in self.pending_calls:
            future = self.pending_calls[call_id]
            if not future.done():
                if response.get("error"):
                    future.set_exception(Exception(response["error"]))
                else:
                    future.set_result(response.get("content", []))
            del self.pending_calls[call_id]

    async def call(self, tool: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Call a tool via RPC and wait for the result"""
        self.call_id += 1
        call_id = f"call_{self.call_id}"

        # Send request to stdout
        request = {
            "type": "tool_call",
            "id": call_id,
            "tool": tool,
            "params": params
        }
        print(json.dumps(request), flush=True)

        # Wait for response
        future = asyncio.Future()
        self.pending_calls[call_id] = future

        try:
            result = await asyncio.wait_for(future, timeout=300.0)  # 5 minute timeout
            return result
        except asyncio.TimeoutError:
            if call_id in self.pending_calls:
                del self.pending_calls[call_id]
            raise Exception(f"Tool call '{tool}' timed out")

    async def cleanup(self):
        """Clean up resources"""
        if self.reader_task:
            self.reader_task.cancel()
            try:
                await self.reader_task
            except asyncio.CancelledError:
                pass

# Global RPC client instance
_rpc = RpcClient()

async def _rpc_call(tool: str, params: dict):
    """Call a tool via RPC (used by generated wrapper functions)"""
    return await _rpc.call(tool, params)
