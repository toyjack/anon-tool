import { YAML } from "bun";
import { DICTIONARY_TYPES, nfkc, type DetectorConfig, type Dictionary, type DictionaryEntity, type DictionaryType, type Result } from "../core";

export type DictionaryError =
  | { readonly code: "yaml-syntax"; readonly line: number }
  | { readonly code: "unsupported-version" }
  | { readonly code: "bad-shape"; readonly scope: "root" | "entities" | "detectors" }
  | { readonly code: "bad-entry"; readonly entry: number }
  | { readonly code: "bad-type"; readonly entry: number }
  | { readonly code: "bad-id"; readonly entry: number }
  | { readonly code: "empty-surface"; readonly entry: number; readonly field: "name" | "aliases" }
  | { readonly code: "reserved-bracket"; readonly entry: number; readonly field: "name" | "aliases" }
  | { readonly code: "ambiguous-surface"; readonly entries: readonly [number, number] }
  | { readonly code: "duplicate-id"; readonly entries: readonly [number, number] }
  | { readonly code: "bad-detector"; readonly detector: "email" | "phone" }
  | { readonly code: "bad-pattern"; readonly detector: "studentId" };

const DICTIONARY_TYPE_SET: ReadonlySet<string> = new Set(DICTIONARY_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDictionaryType(value: string): value is DictionaryType {
  return DICTIONARY_TYPE_SET.has(value);
}

function pair(left: number, right: number): readonly [number, number] {
  if (left <= right) return [left, right];
  return [right, left];
}

function yamlLine(error: unknown): number {
  if (!(error instanceof Error)) return 1;
  const match = /line (\d+)/iu.exec(error.message);
  const raw = match?.[1];
  const line = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(line) && line > 0 ? line : 1;
}

function isStudentIdPattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.includes("^") || pattern.includes("$")) return false;
  try {
    const re = new RegExp(pattern, "y");
    re.lastIndex = 0;
    const match = re.exec("");
    const text = match?.[0];
    return match === null || (text !== undefined && text.length > 0);
  } catch {
    return false;
  }
}

function claimSurface(
  entry: number,
  surface: string,
  field: "name" | "aliases",
  surfaces: Map<string, number>,
  errors: DictionaryError[],
): boolean {
  if (surface.length === 0) {
    errors.push({ code: "empty-surface", entry, field });
    return false;
  }
  if (surface.includes("\u27E6") || surface.includes("\u27E7")) {
    errors.push({ code: "reserved-bracket", entry, field });
    return false;
  }
  const folded = nfkc(surface);
  const prior = surfaces.get(folded);
  if (prior !== undefined) {
    errors.push({ code: "ambiguous-surface", entries: pair(prior, entry) });
    return false;
  }
  surfaces.set(folded, entry);
  return true;
}

function readFlag(
  value: unknown,
  detector: "email" | "phone",
  errors: DictionaryError[],
): boolean | null {
  if (value === undefined) return true;
  if (typeof value === "boolean") return value;
  errors.push({ code: "bad-detector", detector });
  return null;
}

function readStudentId(value: unknown, errors: DictionaryError[]): string | null | undefined {
  if (value === undefined || value === null || value === false) return null;
  if (typeof value !== "string" || !isStudentIdPattern(value)) {
    errors.push({ code: "bad-pattern", detector: "studentId" });
    return undefined;
  }
  return value;
}

function readDetectors(value: unknown, errors: DictionaryError[]): DetectorConfig | null {
  if (value === undefined) return { email: true, phone: true, studentId: null };
  if (!isRecord(value)) {
    errors.push({ code: "bad-shape", scope: "detectors" });
    return null;
  }
  const email = readFlag(value.email, "email", errors);
  const phone = readFlag(value.phone, "phone", errors);
  const studentId = readStudentId(value.studentId, errors);
  if (email === null || phone === null || studentId === undefined) return null;
  return { email, phone, studentId };
}

function readEntity(
  value: unknown,
  entry: number,
  surfaces: Map<string, number>,
  ids: Map<string, number>,
  errors: DictionaryError[],
): DictionaryEntity | null {
  if (!isRecord(value)) {
    errors.push({ code: "bad-entry", entry });
    return null;
  }
  let ok = true;
  if (typeof value.type !== "string" || !isDictionaryType(value.type)) {
    errors.push({ code: "bad-type", entry });
    ok = false;
  }
  if (typeof value.name !== "string") {
    errors.push({ code: "bad-entry", entry });
    ok = false;
  } else if (!claimSurface(entry, value.name, "name", surfaces, errors)) {
    ok = false;
  }
  const aliases: string[] = [];
  if (value.aliases !== undefined) {
    if (!Array.isArray(value.aliases)) {
      errors.push({ code: "bad-entry", entry });
      ok = false;
    } else {
      for (const alias of value.aliases) {
        if (typeof alias !== "string") {
          errors.push({ code: "bad-entry", entry });
          ok = false;
          continue;
        }
        if (!claimSurface(entry, alias, "aliases", surfaces, errors)) {
          ok = false;
          continue;
        }
        aliases.push(alias);
      }
    }
  }
  let id: string | undefined;
  if (value.id !== undefined) {
    if (typeof value.id !== "string" || value.id.length === 0) {
      errors.push({ code: "bad-id", entry });
      ok = false;
    } else {
      const folded = nfkc(value.id);
      const prior = ids.get(folded);
      if (prior !== undefined) {
        errors.push({ code: "duplicate-id", entries: pair(prior, entry) });
        ok = false;
      } else {
        ids.set(folded, entry);
        id = value.id;
      }
    }
  }
  if (!ok || typeof value.type !== "string" || !isDictionaryType(value.type) || typeof value.name !== "string") {
    return null;
  }
  if (id === undefined) return { type: value.type, name: value.name, aliases };
  return { type: value.type, name: value.name, aliases, id };
}

function readEntities(value: unknown, errors: DictionaryError[]): readonly DictionaryEntity[] | null {
  if (!Array.isArray(value)) {
    errors.push({ code: "bad-shape", scope: "entities" });
    return null;
  }
  const entities: DictionaryEntity[] = [];
  const surfaces = new Map<string, number>();
  const ids = new Map<string, number>();
  for (let entry = 0; entry < value.length; entry += 1) {
    const built = readEntity(value[entry], entry, surfaces, ids, errors);
    if (built) entities.push(built);
  }
  return entities;
}

export function parseDictionary(yamlText: string): Result<Dictionary, DictionaryError> {
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch (error) {
    return { ok: false, errors: [{ code: "yaml-syntax", line: yamlLine(error) }] };
  }
  if (!isRecord(parsed)) return { ok: false, errors: [{ code: "bad-shape", scope: "root" }] };
  if (parsed.version !== 1) return { ok: false, errors: [{ code: "unsupported-version" }] };
  const errors: DictionaryError[] = [];
  const detectors = readDetectors(parsed.detectors, errors);
  const entities = readEntities(parsed.entities, errors);
  if (errors.length > 0 || detectors === null || entities === null) return { ok: false, errors };
  return { ok: true, value: { entities, detectors } };
}
