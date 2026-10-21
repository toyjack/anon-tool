import { describe, expect, test } from "bun:test";
import {
  compileMatcher,
  formatToken,
  MappingLedger,
  mask,
  restore,
  type EntityType,
} from "../src/core";

const OPEN = "\u27E6";
const CLOSE = "\u27E7";

function ledgerOf(
  rows: readonly { type: EntityType; seq: number; restoreTo: string }[],
): MappingLedger {
  const parsed = MappingLedger.fromEntries(
    rows.map((row) => ({
      key: `${row.type}:row-${row.seq}`,
      token: formatToken({ type: row.type, seq: row.seq }),
      restoreTo: row.restoreTo,
    })),
  );
  if (!parsed.ok) throw new Error(parsed.errors.map((error) => error.code).join(","));
  return parsed.value;
}

describe("restore", () => {
  test("restores spaced and fullwidth placeholders to the ledger name", () => {
    const ledger = ledgerOf([
      { type: "PERSON", seq: 1, restoreTo: "北条蓮" },
      { type: "PLACE", seq: 2, restoreTo: "青葉台" },
    ]);
    const spaced = `${OPEN} PERSON _ 001 ${CLOSE}`;
    const fullwidth = `${OPEN}\uFF30\uFF2C\uFF21\uFF23\uFF25\uFF3F\uFF10\uFF10\uFF12${CLOSE}`;
    const text = `前 ${spaced} と ${fullwidth} 後`;
    const result = restore(text, ledger);
    expect(result).toEqual({
      kind: "restored",
      text: "前 北条蓮 と 青葉台 後",
      counts: new Map([
        [formatToken({ type: "PERSON", seq: 1 }), 1],
        [formatToken({ type: "PLACE", seq: 2 }), 1],
      ]),
    });
  });

  test("counts repeated canonical tokens", () => {
    const person = formatToken({ type: "PERSON", seq: 1 });
    const place = formatToken({ type: "PLACE", seq: 4 });
    const ledger = ledgerOf([
      { type: "PERSON", seq: 1, restoreTo: "北条蓮" },
      { type: "PLACE", seq: 4, restoreTo: "青葉台" },
    ]);
    const result = restore(`${person}\n${place} ${person}`, ledger);
    expect(result).toEqual({
      kind: "restored",
      text: "北条蓮\n青葉台 北条蓮",
      counts: new Map([
        [person, 2],
        [place, 1],
      ]),
    });
  });

  test("fails closed when any placeholder is missing from the ledger", () => {
    const secret = "北条蓮";
    const around = "前後の本文";
    const unknown = formatToken({ type: "ORG", seq: 3 });
    const known = formatToken({ type: "PERSON", seq: 1 });
    const text = `${around}${known} then ${unknown} and ${known}`;
    const result = restore(text, ledgerOf([{ type: "PERSON", seq: 1, restoreTo: secret }]));
    expect(result).toEqual({
      kind: "unknown-placeholders",
      unknown: [{ token: unknown, position: { line: 1, column: around.length + known.length + " then ".length + 1 } }],
      counts: new Map([
        [known, 2],
        [unknown, 1],
      ]),
    });
    expect("text" in result).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized.includes(secret)).toBe(false);
    expect(serialized.includes(around)).toBe(false);
  });

  test("leaves ASCII brackets and unmatched code points unchanged", () => {
    const token = formatToken({ type: "PERSON", seq: 1 });
    const text = `\uFB01 keep [PERSON_001] ${token} \uFB01`;
    const result = restore(text, ledgerOf([{ type: "PERSON", seq: 1, restoreTo: "北条蓮" }]));
    expect(result).toEqual({
      kind: "restored",
      text: "\uFB01 keep [PERSON_001] 北条蓮 \uFB01",
      counts: new Map([[token, 1]]),
    });
  });

  test("round-trips detector surfaces that are already in the ledger", () => {
    const matcher = compileMatcher({
      entities: [],
      detectors: { email: true, phone: true, studentId: null },
    });
    const email = "hana.ko@example.com";
    const phone = "090-1234-5678";
    const source = `連絡 ${email} / ${phone}`;
    const masked = mask(source, matcher, MappingLedger.empty());
    expect(restore(masked.masked, masked.ledger)).toEqual({
      kind: "restored",
      text: source,
      counts: masked.counts,
    });
  });

  test("restores an empty string", () => {
    const result = restore("", ledgerOf([{ type: "PERSON", seq: 1, restoreTo: "北条蓮" }]));
    expect(result).toEqual({ kind: "restored", text: "", counts: new Map() });
  });

  test("resolves a ledger token written with spaces", () => {
    const parsed = MappingLedger.fromEntries([
      {
        key: "PERSON:row-1",
        token: `${OPEN} PERSON _ 001 ${CLOSE}`,
        restoreTo: "北条蓮",
      },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = restore(formatToken({ type: "PERSON", seq: 1 }), parsed.value);
    expect(result).toEqual({
      kind: "restored",
      text: "北条蓮",
      counts: new Map([[formatToken({ type: "PERSON", seq: 1 }), 1]]),
    });
  });
});
