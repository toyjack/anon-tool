import type { EntityType } from "./entity-types";
import { nfkc, type Nfkc } from "./text";

export const DICTIONARY_TYPES = ["PERSON", "PLACE", "ORG", "ID"] as const satisfies readonly EntityType[];
export type DictionaryType = (typeof DICTIONARY_TYPES)[number];

export const DETECTOR_KINDS = ["email", "phone", "studentId"] as const;
export type DetectorKind = (typeof DETECTOR_KINDS)[number];

declare const entityKeyBrand: unique symbol;
export type EntityKey = string & { readonly [entityKeyBrand]: "EntityKey" };

export type Entity = {
  readonly key: EntityKey;
  readonly type: EntityType;
  readonly restoreTo: string;
};

export type DictionaryEntity = {
  readonly type: DictionaryType;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly id?: string;
};

export type DetectorConfig = {
  readonly email: boolean;
  readonly phone: boolean;
  readonly studentId: string | null;
};

export type Dictionary = {
  readonly entities: readonly DictionaryEntity[];
  readonly detectors: DetectorConfig;
};

declare const matcherBrand: unique symbol;
export type Matcher = { readonly [matcherBrand]: "Matcher" };

export type SpanSource =
  | { readonly kind: "dictionary" }
  | { readonly kind: "detector"; readonly detector: DetectorKind };

export type Span = {
  readonly start: number;
  readonly end: number;
  readonly entity: Entity;
  readonly source: SpanSource;
};

type Surface = {
  readonly raw: string;
  readonly target: Nfkc;
  readonly guardStart: boolean;
  readonly guardEnd: boolean;
  readonly entity: Entity;
};

type CompiledDetector = {
  readonly kind: DetectorKind;
  readonly type: EntityType;
  readonly pattern: RegExp;
};

type Compiled = {
  readonly surfaces: readonly Surface[];
  readonly detectors: readonly CompiledDetector[];
};

const DICTIONARY_SOURCE: SpanSource = { kind: "dictionary" };

const EMAIL_ASCII = String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`;
const PHONE_SEPARATOR_GROUPS = String.raw`(?:\+\d{1,3}[\s.-]?)?\d{2,4}[\s.-]\d{2,4}[\s.-]\d{3,4}`;

const BUILTIN_DETECTORS = [
  { kind: "email", type: "EMAIL", source: EMAIL_ASCII },
  { kind: "phone", type: "PHONE", source: PHONE_SEPARATOR_GROUPS },
] as const satisfies readonly { kind: DetectorKind; type: EntityType; source: string }[];

const compiledByMatcher = new WeakMap<Matcher, Compiled>();

function brandKey(value: string): EntityKey {
  return value as EntityKey;
}

export function entityKeyForDictionary(input: {
  readonly type: DictionaryType;
  readonly name: string;
  readonly id?: string;
}): EntityKey {
  // Prefix stable ids so they do not collide with type-and-name keys.
  if (input.id !== undefined) return brandKey(`id:${nfkc(input.id)}`);
  return brandKey(`${input.type}:${nfkc(input.name)}`);
}

function entityKeyForDetector(type: EntityType, matched: string): EntityKey {
  const folded = type === "EMAIL" ? nfkc(matched).toLowerCase() : nfkc(matched);
  return brandKey(`${type}:${folded}`);
}

function isAsciiAlnum(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function compilePattern(source: string): RegExp {
  if (source.length === 0 || source.includes("^") || source.includes("$")) {
    throw new Error("invalid detector pattern");
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, "y");
  } catch {
    throw new Error("invalid detector pattern");
  }
  pattern.lastIndex = 0;
  const empty = pattern.exec("");
  const emptyMatch = empty?.[0];
  if (empty !== null && (emptyMatch === undefined || emptyMatch.length === 0)) {
    throw new Error("invalid detector pattern");
  }
  pattern.lastIndex = 0;
  return pattern;
}

function compileDetectors(config: DetectorConfig): CompiledDetector[] {
  const detectors: CompiledDetector[] = [];
  for (const builtin of BUILTIN_DETECTORS) {
    const enabled = builtin.kind === "email" ? config.email : config.phone;
    if (!enabled) continue;
    detectors.push({
      kind: builtin.kind,
      type: builtin.type,
      pattern: compilePattern(builtin.source),
    });
  }
  if (config.studentId !== null) {
    detectors.push({
      kind: "studentId",
      type: "ID",
      pattern: compilePattern(config.studentId),
    });
  }
  return detectors;
}

export function compileMatcher(dictionary: Dictionary): Matcher {
  const surfaces: Surface[] = [];
  for (const entry of dictionary.entities) {
    const entity: Entity = {
      key: entityKeyForDictionary(entry),
      type: entry.type,
      restoreTo: entry.name,
    };
    for (const raw of [entry.name, ...entry.aliases]) {
      const target = nfkc(raw);
      if (target.length === 0) continue;
      surfaces.push({
        raw,
        target,
        guardStart: isAsciiAlnum(target.charCodeAt(0)),
        guardEnd: isAsciiAlnum(target.charCodeAt(target.length - 1)),
        entity,
      });
    }
  }
  const matcher = {} as Matcher;
  compiledByMatcher.set(matcher, { surfaces, detectors: compileDetectors(dictionary.detectors) });
  return matcher;
}

function openMatcher(matcher: Matcher): Compiled {
  const compiled = compiledByMatcher.get(matcher);
  if (compiled === undefined) throw new Error("unknown matcher");
  return compiled;
}

function matchEnd(text: string, start: number, surface: Surface): number | null {
  const target = surface.target;
  const limit = Math.min(text.length, start + surface.raw.length * 4);
  let found: number | null = null;
  for (let end = start + 1; end <= limit; end += 1) {
    const folded = nfkc(text.slice(start, end));
    if (folded === target) {
      found = end;
      break;
    }
    // A following combiner can hold the folded length flat, so keep going until the fold is longer than the target.
    if (folded.length > target.length) break;
  }
  if (text.startsWith(surface.raw, start)) {
    const exactEnd = start + surface.raw.length;
    if (found === null || exactEnd < found) return exactEnd;
  }
  return found;
}

function edgesOk(text: string, start: number, end: number, guardStart: boolean, guardEnd: boolean): boolean {
  if (guardStart && start > 0 && isAsciiAlnum(text.charCodeAt(start - 1))) return false;
  if (guardEnd && end < text.length && isAsciiAlnum(text.charCodeAt(end))) return false;
  return true;
}

function detectorAt(text: string, start: number, detector: CompiledDetector): Span | null {
  detector.pattern.lastIndex = start;
  const match = detector.pattern.exec(text);
  if (match === null || match.index !== start) return null;
  const raw = match[0];
  if (raw === undefined || raw.length === 0) return null;
  const end = start + raw.length;
  const guardStart = isAsciiAlnum(raw.charCodeAt(0));
  const guardEnd = isAsciiAlnum(raw.charCodeAt(raw.length - 1));
  if (!edgesOk(text, start, end, guardStart, guardEnd)) return null;
  return {
    start,
    end,
    entity: {
      key: entityKeyForDetector(detector.type, raw),
      type: detector.type,
      restoreTo: raw,
    },
    source: { kind: "detector", detector: detector.kind },
  };
}

function overlaps(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start < right.end && right.start < left.end;
}

function sourceRank(source: SpanSource): number {
  return source.kind === "dictionary" ? 0 : 1;
}

function selectSpans(
  candidates: readonly Span[],
  blocked: readonly { readonly start: number; readonly end: number }[],
): Span[] {
  const ordered = [...candidates].sort((left, right) => {
    const byLength = right.end - right.start - (left.end - left.start);
    if (byLength !== 0) return byLength;
    if (left.start !== right.start) return left.start - right.start;
    return sourceRank(left.source) - sourceRank(right.source);
  });
  const accepted: Span[] = [];
  for (const candidate of ordered) {
    if (accepted.some((span) => overlaps(span, candidate))) continue;
    if (blocked.some((span) => overlaps(span, candidate))) continue;
    accepted.push(candidate);
  }
  accepted.sort((left, right) => left.start - right.start);
  return accepted;
}

export function findSpans(
  text: string,
  matcher: Matcher,
  blocked: readonly { readonly start: number; readonly end: number }[],
): readonly Span[] {
  const compiled = openMatcher(matcher);
  const candidates: Span[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (isLowSurrogate(text.charCodeAt(start))) continue;
    for (const surface of compiled.surfaces) {
      const end = matchEnd(text, start, surface);
      if (end === null) continue;
      if (!edgesOk(text, start, end, surface.guardStart, surface.guardEnd)) continue;
      candidates.push({ start, end, entity: surface.entity, source: DICTIONARY_SOURCE });
    }
    for (const detector of compiled.detectors) {
      const span = detectorAt(text, start, detector);
      if (span) candidates.push(span);
    }
  }
  return selectSpans(candidates, blocked);
}
