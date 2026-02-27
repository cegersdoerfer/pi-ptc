import asyncio
import json
import sys
import traceback
from typing import Any, Callable, Coroutine

# Global state for execution tracking
_current_line = 0
_total_lines = 0
_user_main_code = None

def _trace_lines(frame, event, arg):
    """
    Trace function to track line-by-line execution of user code

    This function is called by sys.settrace() for each line executed.
    It sends execution_progress messages to show which line is currently running.
    """
    global _current_line

    # Only track 'line' events (not 'call', 'return', 'exception')
    if event != 'line':
        return _trace_lines

    # Only track lines inside the user_main function
    if frame.f_code.co_name == 'user_main':
        lineno = frame.f_lineno
        _current_line = lineno

        # Send execution progress update
        # Note: total_lines is set to 0 here, will be calculated on TypeScript side
        try:
            update = {
                "type": "execution_progress",
                "line": lineno,
                "total_lines": 0
            }
            print(json.dumps(update), flush=True)
        except Exception:
            # Don't let trace errors break execution
            pass

    return _trace_lines

async def _runtime_main(user_main: Callable[[], Coroutine[Any, Any, Any]]):
    """
    Runtime entry point that executes user code with RPC support

    Args:
        user_main: User's async main function to execute
    """
    try:
        # Start stdin reader for RPC responses
        await _rpc.start_reader()

        # Install line tracer before execution
        sys.settrace(_trace_lines)

        # Execute user's main function
        output = await user_main()

        # Remove tracer after successful execution
        sys.settrace(None)

        # Send completion message
        result = {
            "type": "complete",
            "output": str(output) if output is not None else ""
        }
        print(json.dumps(result), flush=True)

    except Exception as e:
        # Ensure tracer is removed on error
        sys.settrace(None)

        # Send error message
        error_msg = {
            "type": "error",
            "message": str(e),
            "traceback": traceback.format_exc()
        }
        print(json.dumps(error_msg), flush=True)
        sys.exit(1)

    finally:
        # Cleanup RPC client
        await _rpc.cleanup()
