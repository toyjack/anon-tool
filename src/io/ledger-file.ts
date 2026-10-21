import { MappingLedger, type LedgerInput, type Result } from "../core";

export const DEFAULT_KDF_ITERATIONS = 600_000;

// A hostile file could set iterations high enough to stall the process.
const MAX_KDF_ITERATIONS = 2_000_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export type LedgerFileError =
  | { readonly code: "not-a-ledger" }
  | { readonly code: "unsupported-version" }
  | { readonly code: "wrong-passphrase" }
  | { readonly code: "empty-passphrase" }
  | { readonly code: "mode-mismatch"; readonly envelope: "plain" | "sealed" };

export type LedgerInspection =
  | { readonly mode: "plain" }
  | { readonly mode: "sealed"; readonly iterations: number };

type PlainBody = {
  readonly entries: readonly LedgerInput[];
};

type SealedBody = {
  readonly iterations: number;
  readonly salt: Uint8Array;
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly saltB64: string;
  readonly ivB64: string;
};

type Envelope =
  | { readonly mode: "plain"; readonly plain: PlainBody }
  | { readonly mode: "sealed"; readonly sealed: SealedBody };

function fail(
  code: "not-a-ledger" | "unsupported-version" | "wrong-passphrase" | "empty-passphrase",
): Result<never, LedgerFileError> {
  return { ok: false, errors: [{ code }] };
}

function arrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIterationCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_KDF_ITERATIONS;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) return null;
  return Uint8Array.from(decoded);
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function versionOf(record: Record<string, unknown>): "current" | "unsupported" | "missing" {
  if (!("version" in record)) return "missing";
  if (record.version === 1) return "current";
  return "unsupported";
}

function readEntries(value: unknown): readonly LedgerInput[] | null {
  if (!Array.isArray(value)) return null;
  const entries: LedgerInput[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (typeof item.key !== "string" || typeof item.token !== "string" || typeof item.restoreTo !== "string") {
      return null;
    }
    entries.push({ key: item.key, token: item.token, restoreTo: item.restoreTo });
  }
  return entries;
}

function ledgerFromEntries(entries: readonly LedgerInput[]): Result<MappingLedger, LedgerFileError> {
  const built = MappingLedger.fromEntries(entries);
  if (!built.ok) return fail("not-a-ledger");
  return { ok: true, value: built.value };
}

function readPlain(record: Record<string, unknown>): Result<PlainBody, LedgerFileError> {
  const version = versionOf(record);
  if (version === "missing") return fail("not-a-ledger");
  if (version === "unsupported") return fail("unsupported-version");
  if (record.format !== "anon-ledger") return fail("not-a-ledger");
  const entries = readEntries(record.entries);
  if (entries === null) return fail("not-a-ledger");
  return { ok: true, value: { entries } };
}

function readSealed(record: Record<string, unknown>): Result<SealedBody, LedgerFileError> {
  const version = versionOf(record);
  if (version === "missing") return fail("not-a-ledger");
  if (version === "unsupported") return fail("unsupported-version");
  if (record.format !== "anon-ledger-encrypted") return fail("not-a-ledger");
  if (!isRecord(record.kdf) || record.kdf.name !== "PBKDF2-SHA-256") return fail("not-a-ledger");
  if (typeof record.kdf.iterations !== "number" || !isIterationCount(record.kdf.iterations)) {
    return fail("not-a-ledger");
  }
  const salt = fromBase64(record.kdf.salt);
  const iv = fromBase64(record.iv);
  const ciphertext = fromBase64(record.ciphertext);
  if (salt === null || salt.byteLength !== SALT_BYTES) return fail("not-a-ledger");
  if (iv === null || iv.byteLength !== IV_BYTES) return fail("not-a-ledger");
  if (ciphertext === null || ciphertext.byteLength < GCM_TAG_BYTES) return fail("not-a-ledger");
  if (typeof record.kdf.salt !== "string" || typeof record.iv !== "string") return fail("not-a-ledger");
  return {
    ok: true,
    value: {
      iterations: record.kdf.iterations,
      salt,
      iv,
      ciphertext,
      saltB64: record.kdf.salt,
      ivB64: record.iv,
    },
  };
}

function readEnvelope(text: string): Result<Envelope, LedgerFileError> {
  const parsed = parseJson(text);
  if (!isRecord(parsed)) return fail("not-a-ledger");
  if (parsed.format === "anon-ledger") {
    const plain = readPlain(parsed);
    if (!plain.ok) return plain;
    return { ok: true, value: { mode: "plain", plain: plain.value } };
  }
  if (parsed.format === "anon-ledger-encrypted") {
    const sealed = readSealed(parsed);
    if (!sealed.ok) return sealed;
    return { ok: true, value: { mode: "sealed", sealed: sealed.value } };
  }
  if (isRecord(parsed) && versionOf(parsed) === "unsupported") return fail("unsupported-version");
  return fail("not-a-ledger");
}

export function inspectLedger(text: string): Result<LedgerInspection, LedgerFileError> {
  const envelope = readEnvelope(text);
  if (!envelope.ok) return envelope;
  if (envelope.value.mode === "plain") return { ok: true, value: { mode: "plain" } };
  return { ok: true, value: { mode: "sealed", iterations: envelope.value.sealed.iterations } };
}

function plainDocument(ledger: MappingLedger): string {
  const entries = ledger.entries().map((entry) => ({
    key: entry.key,
    token: entry.token,
    restoreTo: entry.restoreTo,
  }));
  return JSON.stringify({ format: "anon-ledger", version: 1, entries }, null, 2) + "\n";
}

// KDF parameters ride along as AES-GCM additional data, so editing them fails authentication.
function headerAad(sealed: Pick<SealedBody, "iterations" | "saltB64" | "ivB64">): Uint8Array {
  const json = JSON.stringify({
    format: "anon-ledger-encrypted",
    version: 1,
    kdf: { name: "PBKDF2-SHA-256", iterations: sealed.iterations, salt: sealed.saltB64 },
    iv: sealed.ivB64,
  });
  return new TextEncoder().encode(json);
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: arrayBuffer(salt), iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function decryptPlain(sealed: SealedBody, passphrase: string): Promise<Result<MappingLedger, LedgerFileError>> {
  let plainBytes: ArrayBuffer;
  try {
    const key = await deriveKey(passphrase, sealed.salt, sealed.iterations);
    plainBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: arrayBuffer(sealed.iv), additionalData: arrayBuffer(headerAad(sealed)) },
      key,
      arrayBuffer(sealed.ciphertext),
    );
  } catch {
    return fail("wrong-passphrase");
  }
  const text = utf8(new Uint8Array(plainBytes));
  if (text === null) return fail("not-a-ledger");
  const parsed = parseJson(text);
  if (!isRecord(parsed)) return fail("not-a-ledger");
  const plain = readPlain(parsed);
  if (!plain.ok) return plain;
  return ledgerFromEntries(plain.value.entries);
}

export async function encodeLedger(
  ledger: MappingLedger,
  options: { readonly passphrase?: string; readonly iterations?: number } = {},
): Promise<Result<string, LedgerFileError>> {
  if (options.passphrase === "") return fail("empty-passphrase");
  if (options.passphrase === undefined) return { ok: true, value: plainDocument(ledger) };
  const iterations = options.iterations ?? DEFAULT_KDF_ITERATIONS;
  if (!isIterationCount(iterations)) return fail("not-a-ledger");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const saltB64 = toBase64(salt);
  const ivB64 = toBase64(iv);
  const key = await deriveKey(options.passphrase, salt, iterations);
  const cipher = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: arrayBuffer(iv),
      additionalData: arrayBuffer(headerAad({ iterations, saltB64, ivB64 })),
    },
    key,
    new TextEncoder().encode(plainDocument(ledger)),
  );
  const document = {
    format: "anon-ledger-encrypted",
    version: 1,
    kdf: { name: "PBKDF2-SHA-256", iterations, salt: saltB64 },
    iv: ivB64,
    ciphertext: toBase64(new Uint8Array(cipher)),
  };
  return { ok: true, value: JSON.stringify(document, null, 2) + "\n" };
}

export async function decodeLedger(
  text: string,
  passphrase?: string,
): Promise<Result<MappingLedger, LedgerFileError>> {
  if (passphrase === "") return fail("empty-passphrase");
  const envelope = readEnvelope(text);
  if (!envelope.ok) return envelope;
  if (envelope.value.mode === "plain") {
    if (passphrase !== undefined) return { ok: false, errors: [{ code: "mode-mismatch", envelope: "plain" }] };
    return ledgerFromEntries(envelope.value.plain.entries);
  }
  if (passphrase === undefined) return { ok: false, errors: [{ code: "mode-mismatch", envelope: "sealed" }] };
  return decryptPlain(envelope.value.sealed, passphrase);
}
