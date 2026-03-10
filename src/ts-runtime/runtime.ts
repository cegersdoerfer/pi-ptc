function _reportProgress(line, totalLines) {
  try {
    const update = {
      type: "execution_progress",
      line,
      total_lines: totalLines,
    };
    process.stdout.write(JSON.stringify(update) + "\n");
  } catch (e) {
    // Don't let progress reporting break execution
  }
}

async function _runtime_main(userMain) {
  try {
    _startReader();

    const output = await userMain();

    const result = {
      type: "complete",
      output: output != null ? String(output) : "",
    };
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (e) {
    const errorMsg = {
      type: "error",
      message: String(e && e.message ? e.message : e),
      traceback: e && e.stack ? e.stack : "",
    };
    process.stdout.write(JSON.stringify(errorMsg) + "\n");
    process.exitCode = 1;
  } finally {
    _cleanupRpc();
  }
}
