// Which `Host` the server answers without auth: browsers do not talk across origins and DNS
// rebinding defeats that, so `Host` is what gives the attacker away. With auth the browser sends
// no credentials to a foreign origin, and behind a proxy `Host` is the public domain.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

/** The `Host` header name, without port, without brackets and lowercased. */
export function hostName(header: string | undefined): string | undefined {
  if (!header) return undefined;
  let name = header.trim().toLowerCase();
  if (name.startsWith("[")) {
    name = name.slice(1, name.indexOf("]"));
  } else {
    const colon = name.lastIndexOf(":");
    if (colon >= 0) name = name.slice(0, colon);
  }
  name = name.replace(/\.$/, "");
  return name || undefined;
}

/** `MISMEM_ALLOWED_HOSTS`: comma-separated names. */
export function parseHostList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((part) => hostName(part))
    .filter((part): part is string => Boolean(part));
}

export function hostAllowed(
  header: string | undefined,
  opts: { auth: boolean; extra: readonly string[] },
): boolean {
  if (opts.auth) return true;
  const name = hostName(header);
  if (!name) return false;
  return LOOPBACK.has(name) || name.endsWith(".localhost") || opts.extra.includes(name);
}
