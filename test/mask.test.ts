import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, compileMatcher, MappingLedger, mask, type Dictionary } from "../src/core";
import { parseDictionary } from "../src/io/dictionary";

const OPEN = "\u27E6";
const CLOSE = "\u27E7";

function loadFixture(): Dictionary {
  const parsed = parseDictionary(readFileSync(join(import.meta.dir, "fixtures", "dict.yaml"), "utf8"));
  if (!parsed.ok) throw new Error(parsed.errors.map((error) => error.code).join(","));
  return parsed.value;
}

describe("mask and check", () => {
  test("check reports a planted leak by type, source, and position", () => {
    const planted = "山田花子";
    const matcher = compileMatcher({
      entities: [{ type: "PERSON", name: planted, aliases: ["花子"] }],
      detectors: { email: false, phone: false, studentId: null },
    });
    const report = check(`メモ\n${planted}`, matcher);
    expect(report.leaks).toEqual([
      { type: "PERSON", source: { kind: "dictionary" }, at: { line: 2, column: 1 } },
    ]);
    expect(JSON.stringify(report).includes(planted)).toBe(false);
  });

  test("mask then check reports no leaks", () => {
    const matcher = compileMatcher({
      entities: [{ type: "PERSON", name: "山田花子", aliases: [] }],
      detectors: { email: false, phone: false, studentId: null },
    });
    const masked = mask("メモ\n山田花子", matcher, MappingLedger.empty());
    expect(masked.masked).toBe(`メモ\n${OPEN}PERSON_001${CLOSE}`);
    expect(check(masked.masked, matcher).leaks).toEqual([]);
  });

  test("masking masked text is a no-op", () => {
    const matcher = compileMatcher({
      entities: [{ type: "PERSON", name: "山田花子", aliases: ["花子"] }],
      detectors: { email: true, phone: true, studentId: null },
    });
    const once = mask("花子 hana.ko@example.com 090-1234-5678", matcher, MappingLedger.empty());
    const twice = mask(once.masked, matcher, once.ledger);
    expect(twice.masked).toBe(once.masked);
    expect(twice.ledger).toBe(once.ledger);
    expect(twice.newTokens.size).toBe(0);
    expect(check(once.masked, matcher).leaks).toEqual([]);
  });

  test("masking a placeholder that contains a dictionary surface is a no-op", () => {
    const matcher = compileMatcher({
      entities: [{ type: "ID", name: "001", aliases: [] }],
      detectors: { email: false, phone: false, studentId: null },
    });
    const once = mask("001", matcher, MappingLedger.empty());
    expect(once.masked).toBe(`${OPEN}ID_001${CLOSE}`);
    const twice = mask(once.masked, matcher, once.ledger);
    expect(twice.masked).toBe(once.masked);
    expect(twice.ledger).toBe(once.ledger);
  });

  test("email and phone detectors replace the whole match", () => {
    const matcher = compileMatcher({
      entities: [],
      detectors: { email: true, phone: true, studentId: null },
    });
    const email = "hana.ko@example.com";
    const phone = "090-1234-5678";
    const result = mask(`連絡 ${email} / ${phone}`, matcher, MappingLedger.empty());
    expect(result.masked).toBe(`連絡 ${OPEN}EMAIL_001${CLOSE} / ${OPEN}PHONE_001${CLOSE}`);
    expect(result.ledger.entries().map((entry) => entry.token)).toEqual([
      `${OPEN}EMAIL_001${CLOSE}`,
      `${OPEN}PHONE_001${CLOSE}`,
    ]);
    const report = check(phone, matcher);
    expect(report.leaks).toEqual([
      { type: "PHONE", source: { kind: "detector", detector: "phone" }, at: { line: 1, column: 1 } },
    ]);
    expect(JSON.stringify(report).includes(phone)).toBe(false);
    expect(check(result.masked, matcher).leaks).toEqual([]);
  });

  test("student id from the fixture becomes an ID token", () => {
    const matcher = compileMatcher(loadFixture());
    const id = "Q7654321";
    const result = mask(`番号 ${id} です`, matcher, MappingLedger.empty());
    expect(result.masked).toBe(`番号 ${OPEN}ID_001${CLOSE} です`);
    expect(mask("XQ7654321Y", matcher, MappingLedger.empty()).masked).toBe("XQ7654321Y");
    expect(check(result.masked, matcher).leaks).toEqual([]);
  });
});
