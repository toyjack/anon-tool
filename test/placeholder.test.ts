import { describe, expect, test } from "bun:test";
import {
  ENTITY_TYPES,
  formatToken,
  nfkc,
  parseToken,
  positionOf,
  scanPlaceholders,
} from "../src/core";

const OPEN = "\u27E6";
const CLOSE = "\u27E7";

describe("nfkc", () => {
  test("folds fullwidth letters and leaves white square brackets unchanged", () => {
    expect(nfkc("\uFF30") === "P").toBe(true);
    expect(nfkc("\uFB01") === "fi").toBe(true);
    expect(nfkc(OPEN) === OPEN).toBe(true);
    expect(nfkc("\uFF3B") === "[").toBe(true);
    expect(nfkc(nfkc("\uFF30")) === "P").toBe(true);
  });
});

describe("positionOf", () => {
  test("returns 1-based line and column in the original string", () => {
    const text = "ab\ncd";
    expect(positionOf(text, 0)).toEqual({ line: 1, column: 1 });
    expect(positionOf(text, 3)).toEqual({ line: 2, column: 1 });
    expect(positionOf(text, text.length)).toEqual({ line: 2, column: 3 });
  });

  test("rejects an offset outside the string", () => {
    expect(() => positionOf("ab", -1)).toThrow(RangeError);
    expect(() => positionOf("ab", 3)).toThrow(RangeError);
  });
});

describe("formatToken", () => {
  test("pads seq to at least 3 digits and keeps 1000 intact", () => {
    expect(formatToken({ type: "PERSON", seq: 1 })).toBe(`${OPEN}PERSON_001${CLOSE}`);
    expect(formatToken({ type: "PLACE", seq: 12 })).toBe(`${OPEN}PLACE_012${CLOSE}`);
    expect(formatToken({ type: "ORG", seq: 1000 })).toBe(`${OPEN}ORG_1000${CLOSE}`);
  });

  test("formats every entity type", () => {
    expect([...ENTITY_TYPES]).toEqual(["PERSON", "PLACE", "ORG", "ID", "EMAIL", "PHONE"]);
    for (const type of ENTITY_TYPES) {
      expect(formatToken({ type, seq: 2 })).toBe(`${OPEN}${type}_002${CLOSE}`);
    }
  });

  test("rejects seq below 1", () => {
    expect(() => formatToken({ type: "PERSON", seq: 0 })).toThrow(RangeError);
    expect(() => formatToken({ type: "ID", seq: 1.5 })).toThrow(RangeError);
  });
});

describe("parseToken", () => {
  test("reads a canonical token", () => {
    expect(parseToken(`${OPEN}EMAIL_001${CLOSE}`)).toEqual({ type: "EMAIL", seq: 1 });
    expect(parseToken(`${OPEN}PERSON_0001${CLOSE}`)).toEqual({ type: "PERSON", seq: 1 });
    expect(parseToken(formatToken({ type: "PHONE", seq: 1000 }))).toEqual({
      type: "PHONE",
      seq: 1000,
    });
  });

  test("accepts spaces, ZWSP, and fullwidth letters and digits inside the brackets", () => {
    expect(parseToken(`${OPEN} PERSON _ 001 ${CLOSE}`)).toEqual({ type: "PERSON", seq: 1 });
    expect(parseToken(`${OPEN}PER\u200BSON_\u200B001${CLOSE}`)).toEqual({
      type: "PERSON",
      seq: 1,
    });
    expect(parseToken(`${OPEN}\uFF30\uFF25\uFF32\uFF33\uFF2F\uFF2E\uFF3F\uFF10\uFF10\uFF11${CLOSE}`)).toEqual({
      type: "PERSON",
      seq: 1,
    });
  });

  test("rejects ASCII brackets, fullwidth brackets, unknown types, and seq 0", () => {
    expect(parseToken("[PERSON_001]")).toBeNull();
    expect(parseToken("\uFF3BPERSON_001\uFF3D")).toBeNull();
    expect(parseToken(`${OPEN}UNKNOWN_999${CLOSE}`)).toBeNull();
    expect(parseToken(`${OPEN}person_001${CLOSE}`)).toBeNull();
    expect(parseToken(`${OPEN}PERSON_000${CLOSE}`)).toBeNull();
    expect(parseToken(`${OPEN}PERSON_01${CLOSE}`)).toBeNull();
    expect(parseToken(`see ${OPEN}PERSON_001${CLOSE}`)).toBeNull();
  });
});

describe("scanPlaceholders", () => {
  test("returns original offsets for an exact token", () => {
    const text = `xx${OPEN}PERSON_001${CLOSE}yy`;
    expect(scanPlaceholders(text)).toEqual([
      { type: "PERSON", seq: 1, start: 2, end: 2 + `${OPEN}PERSON_001${CLOSE}`.length },
    ]);
    const span = scanPlaceholders(text)[0];
    expect(span).toBeDefined();
    expect(text.slice(span?.start, span?.end)).toBe(`${OPEN}PERSON_001${CLOSE}`);
  });

  test("keeps the spaced token's original slice", () => {
    const text = `hello ${OPEN} PERSON _ 001 ${CLOSE} world`;
    const start = text.indexOf(OPEN);
    const end = text.indexOf(CLOSE) + CLOSE.length;
    expect(scanPlaceholders(text)).toEqual([{ type: "PERSON", seq: 1, start, end }]);
    expect(text.slice(start, end)).toBe(`${OPEN} PERSON _ 001 ${CLOSE}`);
  });

  test("reads a fullwidth interior without moving the surrounding offsets", () => {
    const token = `${OPEN}\uFF30\uFF25\uFF32\uFF33\uFF2F\uFF2E\uFF3F\uFF10\uFF10\uFF11${CLOSE}`;
    const text = `go ${token} on`;
    const start = text.indexOf(OPEN);
    expect(scanPlaceholders(text)).toEqual([
      { type: "PERSON", seq: 1, start, end: start + token.length },
    ]);
  });

  test("does not treat ASCII brackets or an unknown type as tokens", () => {
    const text = `keep [PERSON_001] and ${OPEN}NOPE_004${CLOSE} then ${OPEN}PLACE_002${CLOSE}`;
    expect(scanPlaceholders(text)).toEqual([
      {
        type: "PLACE",
        seq: 2,
        start: text.lastIndexOf(OPEN),
        end: text.lastIndexOf(CLOSE) + CLOSE.length,
      },
    ]);
  });

  test("reports a multiline hit at its original offset", () => {
    const text = `\uFB01\n${OPEN}ID_014${CLOSE}`;
    const spans = scanPlaceholders(text);
    expect(spans).toEqual([
      { type: "ID", seq: 14, start: 2, end: text.length },
    ]);
    const span = spans[0];
    expect(span).toBeDefined();
    if (span) expect(positionOf(text, span.start)).toEqual({ line: 2, column: 1 });
  });
});
