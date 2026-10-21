import { ENTITY_TYPES, type EntityType } from "./entity-types";
import type { Entity, EntityKey } from "./entity";
import { formatToken, parseToken } from "./placeholder";
import type { Result } from "./result";

export type LedgerEntry = {
  readonly key: EntityKey;
  readonly token: string;
  readonly restoreTo: string;
};

export type LedgerInput = {
  readonly key: string;
  readonly token: string;
  readonly restoreTo: string;
};

export type LedgerInvariantError =
  | { readonly code: "bad-token" }
  | { readonly code: "bad-key" }
  | { readonly code: "duplicate-key"; readonly token: string }
  | { readonly code: "duplicate-token"; readonly token: string }
  | { readonly code: "type-mismatch"; readonly token: string };

const KEY_TYPES: ReadonlySet<string> = new Set(ENTITY_TYPES);

function brandKey(value: string): EntityKey {
  return value as EntityKey;
}

function classifyKey(key: string, tokenType: EntityType): "ok" | "bad-key" | "type-mismatch" {
  if (key.startsWith("id:")) return key.length > "id:".length ? "ok" : "bad-key";
  const colon = key.indexOf(":");
  if (colon <= 0 || colon >= key.length - 1) return "bad-key";
  const prefix = key.slice(0, colon);
  if (!KEY_TYPES.has(prefix)) return "bad-key";
  if (prefix !== tokenType) return "type-mismatch";
  return "ok";
}

function seqByType(entries: readonly LedgerEntry[]): Map<EntityType, number> {
  const seq = new Map<EntityType, number>();
  for (const entry of entries) {
    const parsed = parseToken(entry.token);
    if (!parsed) throw new Error("ledger token does not parse");
    seq.set(parsed.type, Math.max(seq.get(parsed.type) ?? 0, parsed.seq));
  }
  return seq;
}

export class MappingLedger {
  private constructor(
    private readonly ordered: readonly LedgerEntry[],
    private readonly byKey: ReadonlyMap<EntityKey, LedgerEntry>,
  ) {}

  static empty(): MappingLedger {
    return new MappingLedger([], new Map());
  }

  static fromEntries(drafts: readonly LedgerInput[]): Result<MappingLedger, LedgerInvariantError> {
    const errors: LedgerInvariantError[] = [];
    const entries: LedgerEntry[] = [];
    const seenKeys = new Set<string>();
    const seenSeq = new Set<string>();
    for (const draft of drafts) {
      const parsed = parseToken(draft.token);
      if (!parsed) {
        errors.push({ code: "bad-token" });
        continue;
      }
      const keyShape = classifyKey(draft.key, parsed.type);
      if (keyShape === "bad-key") {
        errors.push({ code: "bad-key" });
        continue;
      }
      if (keyShape === "type-mismatch") {
        errors.push({ code: "type-mismatch", token: draft.token });
        continue;
      }
      if (seenKeys.has(draft.key)) {
        errors.push({ code: "duplicate-key", token: draft.token });
        continue;
      }
      const seqId = `${parsed.type}:${parsed.seq}`;
      if (seenSeq.has(seqId)) {
        errors.push({ code: "duplicate-token", token: draft.token });
        continue;
      }
      seenKeys.add(draft.key);
      seenSeq.add(seqId);
      entries.push({ key: brandKey(draft.key), token: draft.token, restoreTo: draft.restoreTo });
    }
    if (errors.length > 0) return { ok: false, errors };
    return {
      ok: true,
      value: new MappingLedger(entries, new Map(entries.map((entry) => [entry.key, entry]))),
    };
  }

  assign(entities: readonly Entity[]): MappingLedger {
    const seq = seqByType(this.ordered);
    const ordered = this.ordered.slice();
    const byKey = new Map(this.byKey);
    let changed = false;
    for (const entity of entities) {
      const existing = byKey.get(entity.key);
      if (existing) {
        if (existing.restoreTo === entity.restoreTo) continue;
        const updated: LedgerEntry = { key: existing.key, token: existing.token, restoreTo: entity.restoreTo };
        const index = ordered.findIndex((entry) => entry.key === entity.key);
        if (index >= 0) ordered[index] = updated;
        byKey.set(entity.key, updated);
        changed = true;
        continue;
      }
      const nextSeq = (seq.get(entity.type) ?? 0) + 1;
      seq.set(entity.type, nextSeq);
      const created: LedgerEntry = {
        key: entity.key,
        token: formatToken({ type: entity.type, seq: nextSeq }),
        restoreTo: entity.restoreTo,
      };
      ordered.push(created);
      byKey.set(entity.key, created);
      changed = true;
    }
    if (!changed) return this;
    return new MappingLedger(ordered, byKey);
  }

  tokenOf(key: EntityKey): string | undefined {
    return this.byKey.get(key)?.token;
  }

  entries(): readonly LedgerEntry[] {
    return this.ordered.slice();
  }

  size(): number {
    return this.ordered.length;
  }
}
