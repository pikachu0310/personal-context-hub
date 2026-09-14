export function browserApi(base: string, session?: string) {
  let csrf = "";
  return async function request<T>(
    path: string,
    input?: Record<string, unknown>,
  ): Promise<T> {
    if (session && !csrf) {
      const response = await fetch(session);
      if (!response.ok) throw new Error("LOGIN_REQUIRED");
      csrf = (await response.json()).csrf;
    }
    const response = await fetch(base + path, {
      method: input ? "POST" : "GET",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: input ? JSON.stringify(input) : undefined,
    });
    const result = await response.json();
    if (result.csrf) csrf = result.csrf;
    if (!response.ok) {
      if (response.status === 401 || result.error === "CSRF_REQUIRED")
        csrf = "";
      throw new Error(result.error ?? "REQUEST_FAILED");
    }
    return result as T;
  };
}
