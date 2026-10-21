import type { EntityType } from "./entity-types";
import { findSpans, type Entity, type Matcher, type Span, type SpanSource } from "./entity";
import { MappingLedger } from "./ledger";
import { scanPlaceholders } from "./placeholder";
import { positionOf, type TextPosition } from "./text";

export type Leak = {
  readonly type: EntityType;
  readonly source: SpanSource;
  readonly at: TextPosition;
};

export type CheckReport = {
  readonly leaks: readonly Leak[];
};

export type MaskResult = {
  readonly masked: string;
  readonly ledger: MappingLedger;
  readonly counts: ReadonlyMap<string, number>;
  readonly newTokens: ReadonlySet<string>;
};

function spansIn(text: string, matcher: Matcher): readonly Span[] {
  return findSpans(text, matcher, scanPlaceholders(text));
}

export function mask(text: string, matcher: Matcher, ledger: MappingLedger): MaskResult {
  const spans = spansIn(text, matcher);
  const seen = new Set<string>();
  const entities: Entity[] = [];
  for (const span of spans) {
    if (seen.has(span.entity.key)) continue;
    seen.add(span.entity.key);
    entities.push(span.entity);
  }
  const next = ledger.assign(entities);
  const counts = new Map<string, number>();
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    const token = next.tokenOf(span.entity.key);
    if (token === undefined) throw new Error("assigned entity has no token");
    parts.push(text.slice(cursor, span.start));
    parts.push(token);
    counts.set(token, (counts.get(token) ?? 0) + 1);
    cursor = span.end;
  }
  parts.push(text.slice(cursor));
  const newTokens = new Set<string>();
  for (const entity of entities) {
    if (ledger.tokenOf(entity.key) !== undefined) continue;
    const token = next.tokenOf(entity.key);
    if (token !== undefined) newTokens.add(token);
  }
  return { masked: parts.join(""), ledger: next, counts, newTokens };
}

export function check(text: string, matcher: Matcher): CheckReport {
  return {
    leaks: spansIn(text, matcher).map((span) => ({
      type: span.entity.type,
      source: span.source,
      at: positionOf(text, span.start),
    })),
  };
}
