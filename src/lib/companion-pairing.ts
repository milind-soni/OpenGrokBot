interface CompanionPairingLinkOptions {
  address: string;
  port: number;
  code: string;
  name?: string;
}

/**
 * A short-lived handoff from the trusted desktop pairing panel to the mobile
 * app. The code still has to be redeemed with the companion; putting it in
 * the link does not create or expose the long-lived device token.
 */
export function companionPairingLink({ address, port, code, name }: CompanionPairingLinkOptions): string | null {
  const host = address.trim();
  if (!host || !/^\d{6}$/.test(code) || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const dialableHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

  const url = new URL("openmausbot://pair");
  url.searchParams.set("address", `${dialableHost}:${port}`);
  url.searchParams.set("code", code);
  if (name?.trim()) url.searchParams.set("name", name.trim());
  return url.toString();
}
