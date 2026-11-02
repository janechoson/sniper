# Kronos workspace preferences

## Temporary test artifacts

- User preference: after verification, delete generated test data and test images to reclaim disk space. Do not retain screenshots, fixture databases/WAL/SHM, mock payload dumps, test logs, or isolated verification builds as permanent project evidence.
- Keep test source code and regression fixtures that are part of the test suite. Summarize verification results briefly in the final response or an existing report instead of retaining bulky generated artifacts.
- Use an explicitly named temporary directory and clean it in `finally`/test teardown whenever practical. Check and remove leftover artifacts after failed or interrupted verification too; do not delete artifacts belonging to another currently running test.
- Before deletion, resolve each target, verify it stays inside the intended project/test directory, and reject symlink/junction traversal. Use native PowerShell file operations end-to-end on Windows.
- Never include the active database/WAL/SHM, live trade history, real backups, `.env`, keys/credentials, model/tokenizer weights, Python runtime, dependencies, production `dist`, or application assets in a test cleanup.
- Do not pause or restart Kronos or BOT B for UI work or artifact cleanup. Do not perform real trades as verification.
