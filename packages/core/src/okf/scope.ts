/**
 * Directory-aligned path scoping, shared by every tool that takes a `scope`
 * (PRISM-53 changes_since, PRISM-54 search). "/clients/acme" matches
 * "/clients/acme/x.md" and "/clients/acme/sub/y.md" but NOT
 * "/clients/acme-corp/x.md" — a plain startsWith would bleed across sibling
 * folders that share a name prefix, which for a consultant can mean one
 * client's notes showing up in another client's answer.
 */

/** "/emea/cmo/" -> "/emea/cmo"; "", "/" or undefined -> undefined (whole bundle). */
export function normalizeScope(scope: string | undefined): string | undefined {
  if (scope === undefined) return undefined;
  const parts = scope.trim().split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  if (parts.some((p) => p === "." || p === "..")) {
    throw new Error(`scope must be a plain bundle-relative directory: ${scope}`);
  }
  return "/" + parts.join("/");
}

/** True when bundle path `p` lies inside `scope` (already normalized). */
export function inScope(p: string, scope: string | undefined): boolean {
  if (!scope) return true;
  return p === scope || p.startsWith(scope + "/");
}
