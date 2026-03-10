const readline = require("readline");

let _callId = 0;
const _pendingCalls = new Map();
let _stdinReader = null;

function _startReader() {
  _stdinReader = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  _stdinReader.on("line", (line) => {
    try {
      const response = JSON.parse(line);
      _handleResponse(response);
    } catch (e) {
      process.stderr.write(`JSON decode error: ${e}\n`);
    }
  });
}

function _handleResponse(response) {
  const callId = response.id;
  if (callId && _pendingCalls.has(callId)) {
    const pending = _pendingCalls.get(callId);
    _pendingCalls.delete(callId);
    if (response.error) {
      pending.reject(new Error(response.error));
    } else {
      pending.resolve(response.content ?? []);
    }
  }
}

async function _rpc_call(tool, params) {
  _callId++;
  const callId = `call_${_callId}`;

  const request = {
    type: "tool_call",
    id: callId,
    tool,
    params,
  };
  process.stdout.write(JSON.stringify(request) + "\n");

  return new Promise((resolve, reject) => {
    _pendingCalls.set(callId, { resolve, reject });

    setTimeout(() => {
      if (_pendingCalls.has(callId)) {
        _pendingCalls.delete(callId);
        reject(new Error(`Tool call '${tool}' timed out`));
      }
    }, 300000);
  });
}

function _cleanupRpc() {
  if (_stdinReader) {
    _stdinReader.close();
    _stdinReader = null;
  }
}
