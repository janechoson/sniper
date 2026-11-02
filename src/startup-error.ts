import { safeError } from "./util.js";

/** Startup errors may contain RPC URLs/credentials. Print controlled codes only. */
export function startupErrorCode(error: unknown) {
  const code = safeError(error);
  if (code !== "OPERATION_FAILED") return code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message))
    return error.message;
  return "INVALID_CONFIGURATION_OR_STARTUP_FAILURE";
}
