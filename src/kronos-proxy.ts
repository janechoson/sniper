/** Fixed localhost relay only. Does not construct a Lab, touch its DB or execute. */
export async function kronosProxy(control?: unknown) {
  try {
    const data = control as { csrf?: string } | undefined;
    const response = await fetch(
      "http://127.0.0.1:8792/" + (control ? "control" : "state"),
      {
        method: control ? "POST" : "GET",
        redirect: "error",
        signal: AbortSignal.timeout(2000),
        headers: control
          ? {
              "Content-Type": "application/json",
              Origin: "http://127.0.0.1:8792",
              "X-Kronos-CSRF": data?.csrf ?? "",
            }
          : undefined,
        body: control ? JSON.stringify(control) : undefined,
      },
    );
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw Error("LAB_RESPONSE_TOO_LARGE");
    return { code: response.status, value: JSON.parse(text) };
  } catch {
    return {
      code: 503,
      value: {
        paperOnly: true,
        available: false,
        error: "KRONOS_LAB_OFFLINE",
        records: [],
        limitations: [
          "Start standalone Kronos Lab; production trading continues independently",
        ],
      },
    };
  }
}
