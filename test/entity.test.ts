import { describe, expect, test } from "bun:test";
import {
  compileMatcher,
  entityKeyForDictionary,
  MappingLedger,
  mask,
  type Dictionary,
  type DictionaryEntity,
} from "../src/core";

const OPEN = "\u27E6";
const CLOSE = "\u27E7";

function dictionary(
  entities: readonly DictionaryEntity[],
  detectors: Dictionary["detectors"] = { email: false, phone: false, studentId: null },
): Dictionary {
  return { entities, detectors };
}

describe("dictionary matching", () => {
  test("aliases of one entity share one token and restore to the canonical name", () => {
    const matcher = compileMatcher(
      dictionary([{ type: "PERSON", name: "山田花子", aliases: ["花子"] }]),
    );
    const result = mask("花子と山田花子", matcher, MappingLedger.empty());
    const token = `${OPEN}PERSON_001${CLOSE}`;
    expect(result.masked).toBe(`${token}と${token}`);
    expect(result.ledger.entries()).toHaveLength(1);
    expect(result.ledger.entries().map((entry) => entry.restoreTo)).toEqual(["山田花子"]);
    expect(result.counts.get(token)).toBe(2);
    expect([...result.newTokens]).toEqual([token]);
  });

  test("a longer name beats a shorter overlapping prefix", () => {
    const matcher = compileMatcher(
      dictionary([
        { type: "PERSON", name: "山田太郎", aliases: [] },
        { type: "PERSON", name: "山田", aliases: [] },
      ]),
    );
    const result = mask("山田太郎と山田", matcher, MappingLedger.empty());
    expect(result.masked).toBe(`${OPEN}PERSON_001${CLOSE}と${OPEN}PERSON_002${CLOSE}`);
  });

  test("ASCII edges keep a surface from matching inside a larger word", () => {
    const matcher = compileMatcher(
      dictionary([{ type: "PERSON", name: "Mira Chen", aliases: ["Mira"] }]),
    );
    const ledger = MappingLedger.empty();
    expect(mask("xMira Chen", matcher, ledger).masked).toBe("xMira Chen");
    expect(mask("MiraChen", matcher, ledger).masked).toBe("MiraChen");
    expect(mask("Mira Chen.", matcher, ledger).masked).toBe(`${OPEN}PERSON_001${CLOSE}.`);
  });

  test("a fullwidth alias matches and leaves a surrounding compatibility character in place", () => {
    const matcher = compileMatcher(
      dictionary([{ type: "PERSON", name: "Mira Chen", aliases: ["Mira"] }]),
    );
    const lead = "\uFB01";
    const result = mask(`${lead}Ｍｉｒａ Ｃｈｅｎ${lead}`, matcher, MappingLedger.empty());
    expect(result.masked).toBe(`${lead}${OPEN}PERSON_001${CLOSE}${lead}`);
  });

  test("the same dictionary id keeps the key when the name changes", () => {
    const stableA = entityKeyForDictionary({ type: "PERSON", name: "山田花子", id: "ｐ１" });
    const stableB = entityKeyForDictionary({ type: "PERSON", name: "佐藤花子", id: "p1" });
    const named = entityKeyForDictionary({ type: "PERSON", name: "山田花子" });
    expect(stableA).toBe(stableB);
    expect(stableA).not.toBe(named);
    expect(entityKeyForDictionary({ type: "PERSON", name: "山田花子" })).toBe(named);
  });

  test("a dictionary surface wins a same-span detector hit and restores to the name", () => {
    const matcher = compileMatcher(
      dictionary([{ type: "ID", name: "学籍番号", aliases: ["Q7654321"] }], {
        email: false,
        phone: false,
        studentId: "[A-Z][0-9]{7}",
      }),
    );
    const result = mask("Q7654321", matcher, MappingLedger.empty());
    expect(result.masked).toBe(`${OPEN}ID_001${CLOSE}`);
    expect(result.ledger.entries()).toHaveLength(1);
    expect(result.ledger.entries().map((entry) => entry.restoreTo)).toEqual(["学籍番号"]);
  });
});
