import { MappingLedger } from "./ledger";
import { formatToken, parseToken, scanPlaceholders } from "./placeholder";
import { positionOf, type TextPosition } from "./text";

export type UnknownPlaceholder = {
  readonly token: string;
  readonly position: TextPosition;
};

export type RestoreResult =
  | {
      readonly kind: "restored";
      readonly text: string;
      readonly counts: ReadonlyMap<string, number>;
    }
  | {
      readonly kind: "unknown-placeholders";
      readonly unknown: readonly UnknownPlaceholder[];
      readonly counts: ReadonlyMap<string, number>;
    };

function indexByCanonicalToken(ledger: MappingLedger): Map<string, string> {
  const byToken = new Map<string, string>();
  for (const entry of ledger.entries()) {
    const parsed = parseToken(entry.token);
    if (parsed === null) continue;
    byToken.set(formatToken(parsed), entry.restoreTo);
  }
  return byToken;
}

export function restore(text: string, ledger: MappingLedger): RestoreResult {
  const byToken = indexByCanonicalToken(ledger);
  const counts = new Map<string, number>();
  const known: { start: number; end: number; restoreTo: string }[] = [];
  const unknown: UnknownPlaceholder[] = [];
  for (const span of scanPlaceholders(text)) {
    const token = formatToken({ type: span.type, seq: span.seq });
    counts.set(token, (counts.get(token) ?? 0) + 1);
    const restoreTo = byToken.get(token);
    if (restoreTo === undefined) {
      unknown.push({ token, position: positionOf(text, span.start) });
      continue;
    }
    known.push({ start: span.start, end: span.end, restoreTo });
  }
  if (unknown.length > 0) return { kind: "unknown-placeholders", unknown, counts };
  const parts: string[] = [];
  let cursor = 0;
  for (const hit of known) {
    parts.push(text.slice(cursor, hit.start));
    parts.push(hit.restoreTo);
    cursor = hit.end;
  }
  parts.push(text.slice(cursor));
  return { kind: "restored", text: parts.join(""), counts };
}
