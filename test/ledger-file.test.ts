import { describe, expect, test } from "bun:test";
import { formatToken, MappingLedger } from "../src/core";
import {
  DEFAULT_KDF_ITERATIONS,
  decodeLedger,
  encodeLedger,
  inspectLedger,
} from "../src/io/ledger-file";

const SECRET = "北条蓮";
const PASSPHRASE = "correct-passphrase";

function sampleLedger(): MappingLedger {
  const built = MappingLedger.fromEntries([
    {
      key: `PERSON:${SECRET}`,
      token: formatToken({ type: "PERSON", seq: 1 }),
      restoreTo: SECRET,
    },
  ]);
  if (!built.ok) throw new Error("fixture ledger was rejected");
  return built.value;
}

function entriesOf(ledger: MappingLedger): { key: string; token: string; restoreTo: string }[] {
  return ledger.entries().map((entry) => ({
    key: entry.key,
    token: entry.token,
    restoreTo: entry.restoreTo,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("ledger file", () => {
  test("round-trips a plain ledger", async () => {
    const ledger = sampleLedger();
    const encoded = await encodeLedger(ledger);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.value).toContain('"format": "anon-ledger"');
    expect(encoded.value).not.toContain("anon-ledger-encrypted");
    const decoded = await decodeLedger(encoded.value);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(entriesOf(decoded.value)).toEqual(entriesOf(ledger));
    expect(inspectLedger(encoded.value)).toEqual({ ok: true, value: { mode: "plain" } });
  });

  test("round-trips an encrypted ledger and stores kdf parameters", async () => {
    const ledger = sampleLedger();
    const first = await encodeLedger(ledger, { passphrase: PASSPHRASE, iterations: 1000 });
    const second = await encodeLedger(ledger, { passphrase: PASSPHRASE, iterations: 1000 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).not.toBe(second.value);
    expect(first.value).not.toContain(SECRET);
    expect(first.value).not.toContain(PASSPHRASE);
    const parsed: unknown = JSON.parse(first.value);
    if (!isRecord(parsed)) throw new Error("envelope was not an object");
    const kdf = parsed.kdf;
    if (!isRecord(kdf)) throw new Error("kdf missing");
    const record = parsed;
    const kdfRecord = kdf;
    expect(record.format).toBe("anon-ledger-encrypted");
    expect(kdfRecord.name).toBe("PBKDF2-SHA-256");
    expect(kdfRecord.iterations).toBe(1000);
    expect(typeof kdfRecord.salt).toBe("string");
    expect(typeof record.iv).toBe("string");
    if (typeof kdfRecord.salt !== "string" || typeof record.iv !== "string") return;
    expect(Buffer.from(kdfRecord.salt, "base64")).toHaveLength(16);
    expect(Buffer.from(record.iv, "base64")).toHaveLength(12);
    const decoded = await decodeLedger(first.value, PASSPHRASE);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(entriesOf(decoded.value)).toEqual(entriesOf(ledger));
    expect(inspectLedger(first.value)).toEqual({ ok: true, value: { mode: "sealed", iterations: 1000 } });
  });

  test("stores the default iteration count when the caller omits it", async () => {
    const encoded = await encodeLedger(sampleLedger(), { passphrase: PASSPHRASE });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const parsed: unknown = JSON.parse(encoded.value);
    if (typeof parsed !== "object" || parsed === null || !("kdf" in parsed)) throw new Error("kdf missing");
    const kdf = parsed.kdf;
    if (typeof kdf !== "object" || kdf === null || !("iterations" in kdf)) throw new Error("iterations missing");
    expect(kdf.iterations).toBe(DEFAULT_KDF_ITERATIONS);
    expect(DEFAULT_KDF_ITERATIONS).toBe(600_000);
    const decoded = await decodeLedger(encoded.value, PASSPHRASE);
    expect(decoded.ok).toBe(true);
  });

  test("wrong passphrase is a typed error and does not echo plaintext", async () => {
    const encoded = await encodeLedger(sampleLedger(), { passphrase: PASSPHRASE, iterations: 1000 });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const wrong = await decodeLedger(encoded.value, "wrong-passphrase");
    expect(wrong).toEqual({ ok: false, errors: [{ code: "wrong-passphrase" }] });
    expect(JSON.stringify(wrong)).not.toContain(SECRET);
    expect(JSON.stringify(wrong)).not.toContain(PASSPHRASE);

    const parsed: unknown = JSON.parse(encoded.value);
    if (!isRecord(parsed) || typeof parsed.ciphertext !== "string") throw new Error("ciphertext missing");
    const bytes = Buffer.from(parsed.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    parsed.ciphertext = bytes.toString("base64");
    const tampered = await decodeLedger(JSON.stringify(parsed), PASSPHRASE);
    expect(tampered).toEqual({ ok: false, errors: [{ code: "wrong-passphrase" }] });
    expect(JSON.stringify(tampered)).not.toContain(SECRET);
  });

  test("rejects an empty passphrase and a mode mismatch", async () => {
    const ledger = sampleLedger();
    expect(await encodeLedger(ledger, { passphrase: "" })).toEqual({
      ok: false,
      errors: [{ code: "empty-passphrase" }],
    });
    const plain = await encodeLedger(ledger);
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(await decodeLedger(plain.value, "")).toEqual({
      ok: false,
      errors: [{ code: "empty-passphrase" }],
    });
    expect(await decodeLedger(plain.value, PASSPHRASE)).toEqual({
      ok: false,
      errors: [{ code: "mode-mismatch", envelope: "plain" }],
    });
    const sealed = await encodeLedger(ledger, { passphrase: PASSPHRASE, iterations: 1000 });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(await decodeLedger(sealed.value)).toEqual({
      ok: false,
      errors: [{ code: "mode-mismatch", envelope: "sealed" }],
    });
    expect(JSON.stringify(await decodeLedger(sealed.value))).not.toContain(SECRET);
  });
});
