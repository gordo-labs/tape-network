/**
 * Bounded NIP-01 event store for mesh events. It is reached only through
 * the node mesh endpoint (mesh.ts): there is no public WebSocket.
 *
 * Accepts only mesh kinds (see protocol/mesh.ts), each signature-verified and
 * expiring. Addressable events replace by (kind, pubkey, d); ephemeral events are
 * handed to the service and never stored. Stored events and filters are bounded.
 */
import {
  checkMeshEvent,
  eventExpiration,
  eventTag,
  isAddressableKind,
  isEphemeralKind,
  type NostrEvent,
} from '../protocol/mesh.js';

export type NostrFilter = {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  '#d'?: string[];
  '#p'?: string[];
  since?: number;
  until?: number;
  limit?: number;
};

export const NOSTR_RELAY_LIMITS = {
  maxStoredEvents: 4000,
  maxFiltersPerQuery: 8,
  maxFilterValues: 64,
  maxLimit: 200,
} as const;

function matchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const name of ['d', 'p'] as const) {
    const wanted = filter[`#${name}`];
    if (wanted && !event.tags.some((tag) => tag[0] === name && wanted.includes(tag[1]))) return false;
  }
  return true;
}

function sanitizeFilter(raw: unknown): NostrFilter | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const filter: NostrFilter = {};
  const strings = (value: unknown, pattern: RegExp): string[] | null | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > NOSTR_RELAY_LIMITS.maxFilterValues) return null;
    return value.every((v) => typeof v === 'string' && pattern.test(v)) ? (value as string[]) : null;
  };
  const hex64 = /^[0-9a-f]{64}$/;
  const ids = strings(input.ids, hex64);
  const authors = strings(input.authors, hex64);
  const d = strings(input['#d'], /^[\x21-\x7e]{1,128}$/);
  const p = strings(input['#p'], hex64);
  if (ids === null || authors === null || d === null || p === null) return null;
  if (ids) filter.ids = ids;
  if (authors) filter.authors = authors;
  if (d) filter['#d'] = d;
  if (p) filter['#p'] = p;
  if (input.kinds !== undefined) {
    if (!Array.isArray(input.kinds) || input.kinds.length > 16 || !input.kinds.every(Number.isSafeInteger)) return null;
    filter.kinds = input.kinds as number[];
  }
  for (const key of ['since', 'until'] as const) {
    if (input[key] !== undefined) {
      if (!Number.isSafeInteger(input[key])) return null;
      filter[key] = input[key] as number;
    }
  }
  const limit = input.limit === undefined ? NOSTR_RELAY_LIMITS.maxLimit : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 0) return null;
  filter.limit = Math.min(limit, NOSTR_RELAY_LIMITS.maxLimit);
  return filter;
}

export type NostrRelayOptions = {
  now?: () => number;
};

export class MeshNostrRelay {
  private readonly events = new Map<string, NostrEvent>();
  /** `${kind}:${pubkey}:${d}` → event id. */
  private readonly addressable = new Map<string, string>();
  private readonly purgeTimer: ReturnType<typeof setInterval>;

  constructor(private readonly options: NostrRelayOptions = {}) {
    this.purgeTimer = setInterval(() => this.purgeExpired(), 30_000);
    this.purgeTimer.unref?.();
  }

  private now(): number {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /** Admission check for any event (local or from a peer). Ephemeral events are checked, never stored. */
  publishLocal(event: unknown): { ok: boolean; reason: string; event?: NostrEvent } {
    const check = checkMeshEvent(event, this.now());
    if (check.ok === false) return { ok: false, reason: check.reason };
    const accepted = check.event;
    if (isEphemeralKind(accepted.kind)) return { ok: true, reason: '', event: accepted };
    if (!isAddressableKind(accepted.kind)) return { ok: false, reason: 'blocked: only addressable and ephemeral mesh kinds' };
    if (this.events.has(accepted.id)) return { ok: true, reason: 'duplicate:', event: accepted };
    const key = `${accepted.kind}:${accepted.pubkey}:${eventTag(accepted, 'd')}`;
    const previousId = this.addressable.get(key);
    const previous = previousId ? this.events.get(previousId) : undefined;
    if (previous && (previous.created_at > accepted.created_at
      || (previous.created_at === accepted.created_at && previous.id < accepted.id))) {
      return { ok: true, reason: 'duplicate: newer version stored', event: accepted };
    }
    if (previous) this.events.delete(previous.id);
    if (this.events.size >= NOSTR_RELAY_LIMITS.maxStoredEvents) {
      this.purgeExpired();
      if (this.events.size >= NOSTR_RELAY_LIMITS.maxStoredEvents) return { ok: false, reason: 'error: store full' };
    }
    this.events.set(accepted.id, accepted);
    this.addressable.set(key, accepted.id);
    return { ok: true, reason: '', event: accepted };
  }

  /** Sanitize untrusted NIP-01 filters; null when any is invalid. */
  sanitizeFilters(raw: unknown[]): NostrFilter[] | null {
    if (raw.length === 0 || raw.length > NOSTR_RELAY_LIMITS.maxFiltersPerQuery) return null;
    const filters = raw.map(sanitizeFilter);
    return filters.some((filter) => filter === null) ? null : (filters as NostrFilter[]);
  }

  query(filters: NostrFilter[]): NostrEvent[] {
    const now = this.now();
    const out = new Map<string, NostrEvent>();
    for (const filter of filters) {
      const matches = [...this.events.values()]
        .filter((event) => (eventExpiration(event) ?? 0) > now && matchesFilter(event, filter))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, filter.limit ?? NOSTR_RELAY_LIMITS.maxLimit);
      for (const event of matches) out.set(event.id, event);
    }
    return [...out.values()];
  }

  close(): void {
    clearInterval(this.purgeTimer);
    this.events.clear();
    this.addressable.clear();
  }

  get storedEventCount(): number {
    return this.events.size;
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [id, event] of this.events) {
      if ((eventExpiration(event) ?? 0) <= now) {
        this.events.delete(id);
        if (isAddressableKind(event.kind)) {
          const key = `${event.kind}:${event.pubkey}:${eventTag(event, 'd')}`;
          if (this.addressable.get(key) === id) this.addressable.delete(key);
        }
      }
    }
  }
}
