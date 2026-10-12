import type { ConnectorProvider } from "./model";

export function connectorRedirectResponse(target: URL | string) {
  return new Response(null, {
    status: 303,
    headers: { location: target.toString() },
  });
}

export function clearConnectorCallbackCookie(
  response: Response,
  provider: ConnectorProvider,
  secure: boolean,
) {
  const headers = new Headers(response.headers);
  headers.append(
    "set-cookie",
    `auterim_connector_${provider}=; Path=/api/connectors/${provider}/callback; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function vercelIntegrationNextUrl(
  next: string | null,
  expectedConfigurationId: string | null,
) {
  if (!next || !expectedConfigurationId || !/^[A-Za-z0-9_-]{1,200}$/.test(expectedConfigurationId))
    return null;
  try {
    const target = new URL(next);
    if (
      target.protocol !== "https:" ||
      target.hostname !== "vercel.com" ||
      target.port ||
      target.username ||
      target.password ||
      target.search ||
      target.hash
    )
      return null;
    const match = /^\/dashboard\/[A-Za-z0-9_-]{1,100}\/integrations\/([A-Za-z0-9_-]{1,200})$/.exec(
      target.pathname,
    );
    return match?.[1] === expectedConfigurationId ? target : null;
  } catch {
    return null;
  }
}
