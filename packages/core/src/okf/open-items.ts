/**
 * PRISM-56: open items — the consultant's action log / RAID list, living in
 * the knowledge store next to the context that produced each item. Any
 * concept with a `status` field is a tracked item; `owner` and `due` are
 * optional. Deterministic, zero LLM.
 *
 * "Overdue" compares the due DATE with today's date in UTC — a deliberate
 * simplification (no per-user timezone yet), so an item due today only
 * becomes overdue at the next UTC midnight.
 */
import type { Bundle } from "./bundle.js";
import { ITEM_STATUSES, RESOLVED_STATUSES, type ItemStatus } from "./fields.js";
import { inScope, normalizeScope } from "./scope.js";
import { isValidIsoDate } from "./temporal.js";

export interface OpenItem {
  path: string;
  title?: string;
  type?: string;
  status: ItemStatus;
  owner?: string;
  /** YYYY-MM-DD */
  due?: string;
  overdue: boolean;
  /** Whole days past due; present only when overdue. */
  days_overdue?: number;
}

export interface OpenItemsReport {
  items: OpenItem[];
  counts: { total: number; overdue: number; by_status: Partial<Record<ItemStatus, number>> };
  truncated: boolean;
}

export interface OpenItemsOptions {
  /** Statuses to include. Default: every unresolved status (not decided/closed). */
  status?: ItemStatus[];
  /** Case-insensitive substring match on owner ("priya" matches "Priya S."). */
  owner?: string;
  scope?: string;
  overdueOnly?: boolean;
  limit?: number;
  /** Injected clock for tests. */
  now?: Date;
}

const DAY_MS = 86_400_000;

export async function listOpenItems(bundle: Bundle, options: OpenItemsOptions = {}): Promise<OpenItemsReport> {
  const scope = normalizeScope(options.scope);
  const wanted = new Set<ItemStatus>(
    options.status?.length ? options.status : ITEM_STATUSES.filter((s) => !RESOLVED_STATUSES.includes(s))
  );
  const owner = options.owner?.trim().toLowerCase();
  const today = (options.now ?? new Date()).toISOString().slice(0, 10);
  const limit = options.limit ?? 100;

  const items: OpenItem[] = [];
  for (const p of await bundle.listConceptPaths()) {
    if (!inScope(p, scope)) continue;
    let fm;
    try {
      ({ frontmatter: fm } = await bundle.readConcept(p));
    } catch {
      continue;
    }
    const status = fm.status as ItemStatus | undefined;
    if (!status || !(ITEM_STATUSES as readonly string[]).includes(status)) continue; // untracked or malformed
    if (typeof fm.superseded_by === "string" && fm.superseded_by) continue; // current beliefs only (PRISM-24)
    if (!wanted.has(status)) continue;
    const itemOwner = typeof fm.owner === "string" ? fm.owner : undefined;
    if (owner && !(itemOwner ?? "").toLowerCase().includes(owner)) continue;

    const due = isValidIsoDate(fm.due) ? fm.due.slice(0, 10) : undefined;
    const overdue = !!due && due < today && !RESOLVED_STATUSES.includes(status);
    if (options.overdueOnly && !overdue) continue;

    const item: OpenItem = {
      path: p,
      title: typeof fm.title === "string" ? fm.title : undefined,
      type: typeof fm.type === "string" ? fm.type : undefined,
      status,
      owner: itemOwner,
      due,
      overdue,
    };
    if (overdue) item.days_overdue = Math.round((Date.parse(today) - Date.parse(due!)) / DAY_MS);
    items.push(item);
  }

  // Overdue first (most overdue first), then by due date, undated last.
  items.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
    if (!!a.due !== !!b.due) return a.due ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  const by_status: Partial<Record<ItemStatus, number>> = {};
  for (const i of items) by_status[i.status] = (by_status[i.status] ?? 0) + 1;
  return {
    items: items.slice(0, limit),
    counts: { total: items.length, overdue: items.filter((i) => i.overdue).length, by_status },
    truncated: items.length > limit,
  };
}
