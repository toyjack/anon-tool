import { ENTITY_TYPES, type EntityType } from "./entity-types";
import { nfkc } from "./text";

const OPEN = "\u27E6";
const CLOSE = "\u27E7";

const ENTITY_TYPE_SET: ReadonlySet<string> = new Set(ENTITY_TYPES);

export type ParsedToken = {
  readonly type: EntityType;
  readonly seq: number;
};

export type PlaceholderSpan = ParsedToken & {
  readonly start: number;
  readonly end: number;
};

function isEntityType(value: string): value is EntityType {
  return ENTITY_TYPE_SET.has(value);
}

function isInteriorChar(char: string): boolean {
  if (char === "\u200B" || /\s/u.test(char)) return true;
  return /^[A-Za-z0-9_]$/u.test(nfkc(char));
}

function parseInterior(interior: string): ParsedToken | null {
  const compact = nfkc(interior).replace(/[\s\u200B]+/gu, "");
  const match = /^([A-Z]+)_(\d{3,})$/u.exec(compact);
  if (!match) return null;
  const typeName = match[1];
  const digits = match[2];
  if (typeName === undefined || digits === undefined) return null;
  if (!isEntityType(typeName)) return null;
  const seq = Number(digits);
  if (!Number.isSafeInteger(seq) || seq < 1) return null;
  return { type: typeName, seq };
}

export function scanPlaceholders(text: string): PlaceholderSpan[] {
  const spans: PlaceholderSpan[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf(OPEN, cursor);
    if (open < 0) break;
    let interiorEnd = open + OPEN.length;
    while (interiorEnd < text.length) {
      const char = text[interiorEnd];
      if (char === undefined || char === CLOSE || !isInteriorChar(char)) break;
      interiorEnd += 1;
    }
    if (text[interiorEnd] !== CLOSE) {
      cursor = open + OPEN.length;
      continue;
    }
    const end = interiorEnd + CLOSE.length;
    const parsed = parseInterior(text.slice(open + OPEN.length, interiorEnd));
    if (parsed) {
      spans.push({ type: parsed.type, seq: parsed.seq, start: open, end });
    }
    cursor = end;
  }
  return spans;
}

export function parseToken(raw: string): ParsedToken | null {
  const spans = scanPlaceholders(raw);
  const span = spans[0];
  if (spans.length !== 1 || span === undefined) return null;
  if (span.start !== 0 || span.end !== raw.length) return null;
  return { type: span.type, seq: span.seq };
}

export function formatToken(token: ParsedToken): string {
  if (!Number.isSafeInteger(token.seq) || token.seq < 1) {
    throw new RangeError("seq must be an integer >= 1");
  }
  return `${OPEN}${token.type}_${String(token.seq).padStart(3, "0")}${CLOSE}`;
}
