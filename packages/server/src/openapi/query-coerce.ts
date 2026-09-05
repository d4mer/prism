import { z, type ZodTypeAny } from "zod";

/**
 * Convert an Express `req.query`-shaped object (every value a string, or
 * absent) into the JS shape a tool's Zod inputSchema expects, by inspecting
 * the schema itself — no per-tool coercion code, so a GET route stays
 * correct automatically as a tool's schema evolves. Handles the shapes
 * CORE_TOOLS actually uses: optional/required strings, numbers, and
 * comma-separated arrays. Unwraps ZodOptional/ZodDefault to find the
 * underlying type.
 */
export function coerceQuery(schema: ZodTypeAny, query: Record<string, unknown>): Record<string, unknown> {
  if (!(schema instanceof z.ZodObject)) return query;
  const shape = schema.shape as Record<string, ZodTypeAny>;
  const out: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(shape)) {
    const raw = query[key];
    if (raw === undefined || raw === "") continue;
    out[key] = coerceValue(unwrap(fieldSchema), raw);
  }
  return out;
}

function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault || current instanceof z.ZodNullable) {
    current = (current as unknown as { _def: { innerType: ZodTypeAny } })._def.innerType;
  }
  return current;
}

function coerceValue(schema: ZodTypeAny, raw: unknown): unknown {
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (schema instanceof z.ZodArray) {
    return String(value)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (schema instanceof z.ZodNumber) {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (schema instanceof z.ZodBoolean) {
    return value === "true" || value === "1";
  }
  return value; // string, or something schema.parse can complain about accurately
}
