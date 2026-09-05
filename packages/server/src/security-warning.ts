const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * PRISM-19: a clear, loud warning the moment the server is reachable from
 * outside this machine with no credentials required — tenet 9's
 * proportionality ("open on localhost, secured the moment it is exposed")
 * only holds if something actually says so at the moment it stops holding.
 * Returns null when nothing needs saying: a token is configured, or the
 * bind address is loopback-only.
 */
export function exposureWarning(host: string, authToken: string | undefined, port: number): string | null {
  if (authToken) return null;
  if (isLoopbackHost(host)) return null;
  return (
    `[prism] \u26a0 SECURITY: listening on ${host}:${port} with no AUTH_TOKEN set. ` +
    "This address is reachable from outside this machine \u2014 anyone who can reach it can read AND write " +
    "your knowledge base with no credentials. Set AUTH_TOKEN (see README, Auth section) before exposing this " +
    "beyond localhost, or set HOST=127.0.0.1 for a strictly local setup."
  );
}
