import { describe, expect, test } from "bun:test";
import { entityKeyForDictionary, MappingLedger, type Entity } from "../src/core";

const OPEN = "\u27E6";
const CLOSE = "\u27E7";

function person(name: string, id?: string): Entity {
  const key =
    id === undefined
      ? entityKeyForDictionary({ type: "PERSON", name })
      : entityKeyForDictionary({ type: "PERSON", name, id });
  return { key, type: "PERSON", restoreTo: name };
}

describe("MappingLedger", () => {
  test("assigns the next seq for each type in the order given", () => {
    const ledger = MappingLedger.empty().assign([person("山田太郎"), person("山田花子"), person("山田太郎")]);
    expect(ledger.entries().map((entry) => entry.restoreTo)).toEqual(["山田太郎", "山田花子"]);
    expect(ledger.entries().map((entry) => entry.token)).toEqual([
      `${OPEN}PERSON_001${CLOSE}`,
      `${OPEN}PERSON_002${CLOSE}`,
    ]);
  });

  test("returns the same ledger when assign repeats known keys", () => {
    const empty = MappingLedger.empty();
    expect(empty.assign([])).toBe(empty);
    const ledger = empty.assign([person("山田花子"), person("山田太郎")]);
    expect(ledger.assign([person("山田花子"), person("山田太郎")])).toBe(ledger);
  });

  test("continues each type from its max seq", () => {
    const seeded = MappingLedger.fromEntries([
      { key: "PERSON:alpha", token: `${OPEN}PERSON_004${CLOSE}`, restoreTo: "alpha" },
      { key: "ORG:beta", token: `${OPEN}ORG_002${CLOSE}`, restoreTo: "beta" },
    ]);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const next = seeded.value.assign([
      {
        key: entityKeyForDictionary({ type: "ORG", name: "北星大学" }),
        type: "ORG",
        restoreTo: "北星大学",
      },
      person("山田花子"),
    ]);
    expect(next.entries().map((entry) => entry.token)).toEqual([
      `${OPEN}PERSON_004${CLOSE}`,
      `${OPEN}ORG_002${CLOSE}`,
      `${OPEN}ORG_003${CLOSE}`,
      `${OPEN}PERSON_005${CLOSE}`,
    ]);
  });

  test("keeps the token when a stable id arrives with a new name", () => {
    const original = MappingLedger.empty().assign([person("山田花子", "p1")]);
    const renamed = original.assign([person("佐藤花子", "p1")]);
    expect(renamed).not.toBe(original);
    expect(renamed.entries().map((entry) => entry.token)).toEqual([`${OPEN}PERSON_001${CLOSE}`]);
    expect(renamed.entries().map((entry) => entry.restoreTo)).toEqual(["佐藤花子"]);
    expect(renamed.entries().map((entry) => entry.key)).toEqual(original.entries().map((entry) => entry.key));
    expect(renamed.assign([person("佐藤花子", "p1")])).toBe(renamed);
  });

  test("fromEntries errors omit restore text", () => {
    const secret = "山田花子";
    const badToken = MappingLedger.fromEntries([
      { key: "PERSON:alpha", token: "not-a-token", restoreTo: secret },
    ]);
    const duplicateKey = MappingLedger.fromEntries([
      { key: "PERSON:alpha", token: `${OPEN}PERSON_001${CLOSE}`, restoreTo: secret },
      { key: "PERSON:alpha", token: `${OPEN}PERSON_002${CLOSE}`, restoreTo: secret },
    ]);
    const mismatch = MappingLedger.fromEntries([
      { key: "ORG:alpha", token: `${OPEN}PERSON_001${CLOSE}`, restoreTo: secret },
    ]);
    expect(badToken).toEqual({ ok: false, errors: [{ code: "bad-token" }] });
    expect(duplicateKey).toEqual({
      ok: false,
      errors: [{ code: "duplicate-key", token: `${OPEN}PERSON_002${CLOSE}` }],
    });
    expect(mismatch).toEqual({
      ok: false,
      errors: [{ code: "type-mismatch", token: `${OPEN}PERSON_001${CLOSE}` }],
    });
    for (const result of [badToken, duplicateKey, mismatch]) {
      expect(JSON.stringify(result).includes(secret)).toBe(false);
    }
  });
});
