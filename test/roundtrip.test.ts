import { describe, expect, test } from "bun:test";
import { array, assert, constantFrom, property } from "fast-check";
import { compileMatcher, MappingLedger, mask, restore, type Dictionary } from "../src/core";

const DICTIONARY = {
  entities: [
    { type: "PERSON", name: "北条蓮", aliases: ["ほくじょう"] },
    { type: "PLACE", name: "青葉台", aliases: ["あおばだい"] },
    { type: "ORG", name: "星見学園", aliases: ["せいけん"] },
  ],
  detectors: { email: false, phone: false, studentId: null },
} satisfies Dictionary;

const ATOMS = [
  { raw: " ", restored: " " },
  { raw: "\n", restored: "\n" },
  { raw: ".", restored: "." },
  { raw: "、", restored: "、" },
  { raw: "x", restored: "x" },
  { raw: "北条蓮", restored: "北条蓮" },
  { raw: "ほくじょう", restored: "北条蓮" },
  { raw: "青葉台", restored: "青葉台" },
  { raw: "あおばだい", restored: "青葉台" },
  { raw: "星見学園", restored: "星見学園" },
  { raw: "せいけん", restored: "星見学園" },
] as const;

describe("mask and restore", () => {
  test("replaces each generated alias with its canonical name", () => {
    const matcher = compileMatcher(DICTIONARY);
    assert(
      property(array(constantFrom(...ATOMS), { minLength: 0, maxLength: 32 }), (parts) => {
        const text = parts.map((part) => part.raw).join("");
        const expected = parts.map((part) => part.restored).join("");
        const masked = mask(text, matcher, MappingLedger.empty());
        const back = restore(masked.masked, masked.ledger);
        expect(back.kind).toBe("restored");
        if (back.kind !== "restored") return;
        expect(back.text).toBe(expected);
        expect(mask(back.text, matcher, masked.ledger).masked).toBe(masked.masked);
      }),
      { numRuns: 80, seed: 20261021 },
    );
  });
});
