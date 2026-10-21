import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDictionary } from "../src/io/dictionary";

const fixturePath = join(import.meta.dir, "fixtures", "dict.yaml");

describe("parseDictionary", () => {
  test("loads the fictional fixture", () => {
    const parsed = parseDictionary(readFileSync(fixturePath, "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.detectors).toEqual({
      email: true,
      phone: true,
      studentId: "[A-Z][0-9]{7}",
    });
    expect(parsed.value.entities.map((entity) => entity.type)).toEqual([
      "PERSON",
      "PERSON",
      "PERSON",
      "ORG",
      "PLACE",
    ]);
    expect(parsed.value.entities[0]).toEqual({
      type: "PERSON",
      name: "山田花子",
      id: "person-hanako",
      aliases: ["花子", "Hanako Yamada"],
    });
    expect(parsed.value.entities[4]).toEqual({
      type: "PLACE",
      name: "青葉町",
      aliases: [],
    });
  });

  test("defaults email and phone on when detectors are omitted", () => {
    expect(parseDictionary("version: 1\nentities: []\n")).toEqual({
      ok: true,
      value: { entities: [], detectors: { email: true, phone: true, studentId: null } },
    });
  });

  test("rejects an alias that folds to another entity name", () => {
    const yaml = [
      "version: 1",
      "detectors:",
      "  email: false",
      "  phone: false",
      "entities:",
      "  - type: PERSON",
      "    name: Mira Chen",
      "    aliases:",
      "      - Ｍｉｒａ",
      "  - type: PERSON",
      "    name: Mira",
    ].join("\n");
    expect(parseDictionary(yaml)).toEqual({
      ok: false,
      errors: [{ code: "ambiguous-surface", entries: [0, 1] }],
    });
  });

  test("rejects two entities with the same folded id", () => {
    const yaml = [
      "version: 1",
      "entities:",
      "  - type: PERSON",
      "    name: 山田花子",
      "    id: p1",
      "  - type: PERSON",
      "    name: 佐藤花子",
      "    id: ｐ１",
    ].join("\n");
    expect(parseDictionary(yaml)).toEqual({
      ok: false,
      errors: [{ code: "duplicate-id", entries: [0, 1] }],
    });
  });

  test("rejects placeholder brackets in a name", () => {
    const yaml = 'version: 1\nentities:\n  - type: PERSON\n    name: "山田\u27E6花子"\n';
    expect(parseDictionary(yaml)).toEqual({
      ok: false,
      errors: [{ code: "reserved-bracket", entry: 0, field: "name" }],
    });
  });

  test("rejects ^ and $ in studentId", () => {
    const yaml = 'version: 1\nentities: []\ndetectors:\n  studentId: "^[A-Z][0-9]{7}$"\n';
    expect(parseDictionary(yaml)).toEqual({
      ok: false,
      errors: [{ code: "bad-pattern", detector: "studentId" }],
    });
  });

  test("rejects an unsupported version", () => {
    expect(parseDictionary("version: 2\nentities: []\n")).toEqual({
      ok: false,
      errors: [{ code: "unsupported-version" }],
    });
  });

  test("yaml syntax errors keep the line and drop the parser message", () => {
    const parsed = parseDictionary("version: [");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]?.code).toBe("yaml-syntax");
    if (parsed.errors[0]?.code === "yaml-syntax") expect(parsed.errors[0].line).toBeGreaterThan(0);
    expect(JSON.stringify(parsed.errors)).not.toContain("version");
  });
});
