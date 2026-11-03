/** CLI child preload. Relay only allowlisted response metadata, never request data. */
import { rateLimitMetadata } from "./gmgn-rate-metadata.js";
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (response.status === 429)
    process.stderr.write(
      `GMGN_RATE_METADATA:${JSON.stringify(rateLimitMetadata(response))}\n`,
    );
  return response;
};
