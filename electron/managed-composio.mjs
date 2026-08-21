const TOKEN = /^[0-9a-f]{64}$/;

export function managedComposioAccess(brokerUrl, credentials) {
  const url = typeof brokerUrl === "string" ? brokerUrl.trim().replace(/\/$/, "") : "";
  const token = credentials?.composioBrokerToken;
  if (!url || !TOKEN.test(token ?? "")) return null;
  return { url, token };
}

export async function ensureManagedComposioCredentials({
  brokerUrl,
  credentials,
  fetchImpl = globalThis.fetch,
  saveCredentials,
  log = () => {},
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  existingCredentialTimeoutMs = 8_000,
  registrationTimeoutMs = 15_000,
}) {
  if (!brokerUrl) return credentials;
  if (TOKEN.test(credentials.composioBrokerToken ?? "")) {
    try {
      const check = await fetchImpl(`${brokerUrl}/v1/me`, {
        headers: { authorization: `Bearer ${credentials.composioBrokerToken}` },
        signal: timeoutSignal(existingCredentialTimeoutMs),
      });
      if (check.ok) return credentials;
      // Only a definitive auth failure rotates the credential. A transient
      // outage keeps the existing identity so reconnecting cannot strand the
      // user's already-authorized accounts under a new installation.
      if (check.status !== 401) return credentials;
      delete credentials.composioBrokerToken;
      delete credentials.composioInstallationId;
    } catch {
      return credentials;
    }
  }
  try {
    const response = await fetchImpl(`${brokerUrl}/v1/installations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: timeoutSignal(registrationTimeoutMs),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    if (!TOKEN.test(body?.token ?? "") || typeof body?.installationId !== "string") {
      throw new Error("the connected-apps service returned invalid credentials");
    }
    credentials.composioBrokerToken = body.token;
    credentials.composioInstallationId = body.installationId;
    await saveCredentials(credentials);
    log("connected-apps installation registered");
  } catch (error) {
    // This operation always settles locally. The caller runs it after first
    // paint, so an optional hosted integration cannot delay desktop readiness.
    log(`connected-apps registration failed: ${error?.message ?? error}`);
  }
  return credentials;
}
