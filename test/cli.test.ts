import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MappingLedger } from "../src/core";
import { encodeLedger } from "../src/io/ledger-file";

const root = join(import.meta.dir, "..");
const dict = join(root, "test", "fixtures", "dict.yaml");
const note = join(root, "test", "fixtures", "note.md");
const mira = join(root, "test", "fixtures", "note-mira.md");
const unknown = join(root, "test", "fixtures", "unknown.md");

const SURFACES = [
  "山田花子",
  "花子",
  "Hanako Yamada",
  "山田太郎",
  "太郎",
  "Mira Chen",
  "Mira",
  "北星大学",
  "北星大",
  "青葉町",
  "person-hanako",
  "hanako@example.com",
];

function assertNoSurfaces(text: string): void {
  for (const surface of SURFACES) {
    expect(text.includes(surface)).toBe(false);
  }
}

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

async function run(
  args: readonly string[],
  options: { readonly env?: Record<string, string>; readonly stdin?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string; combined: string }> {
  const proc = Bun.spawn(["bun", join(root, "src", "cli.ts"), ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    env: childEnv(options.env),
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr, combined: `${stdout}\n${stderr}` };
}

async function withTemp(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "anon-cli-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("cli", () => {
  test("mask, check, and restore a fictional note", async () => {
    await withTemp(async (dir) => {
      const ledger = join(dir, "map.json");
      const masked = join(dir, "note.masked.md");
      const restored = join(dir, "note.restored.md");
      const maskedRun = await run(["mask", "-d", dict, "-i", note, "-o", masked, "-m", ledger]);
      expect(maskedRun.code).toBe(0);
      assertNoSurfaces(maskedRun.combined);
      expect(maskedRun.stderr).toContain("PHONE 0");
      expect(maskedRun.stderr).toContain("ID 0");
      expect(maskedRun.stdout).toBe("");
      expect(existsSync(`${ledger}.anon-tmp`)).toBe(false);
      expect(existsSync(`${masked}.anon-tmp`)).toBe(false);
      const maskedText = readFileSync(masked, "utf8");
      expect(maskedText).toContain("\u27e6PERSON_001\u27e7");
      for (const surface of SURFACES) expect(maskedText.includes(surface)).toBe(false);
      expect(readFileSync(ledger, "utf8")).toContain("山田花子");

      const checkOk = await run(["check", "-d", dict, "-i", masked]);
      expect(checkOk.code).toBe(0);
      expect(checkOk.stderr).toContain("0 leaks");
      expect(checkOk.stderr).toContain("PHONE 0");
      assertNoSurfaces(checkOk.combined);

      const restoreRun = await run(["restore", "-m", ledger, "-i", masked, "-o", restored]);
      expect(restoreRun.code).toBe(0);
      assertNoSurfaces(restoreRun.combined);
      const restoredText = readFileSync(restored, "utf8");
      expect(restoredText).toContain("山田花子と山田太郎");
      expect(restoredText).toContain("hanako@example.com");
      expect(restoredText).not.toContain("\u27e6");
    });
  });

  test("check fails when a fixture surface is still present", async () => {
    const result = await run(["check", "-d", dict, "-i", note]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("LEAK 1:1 PERSON (dictionary)");
    expect(result.stderr).toContain("detector:email");
    assertNoSurfaces(result.combined);
  });

  test("restore writes nothing for an unknown placeholder", async () => {
    await withTemp(async (dir) => {
      const ledger = join(dir, "map.json");
      const masked = join(dir, "note.masked.md");
      const out = join(dir, "hallucinated.md");
      const maskedRun = await run(["mask", "-d", dict, "-i", note, "-o", masked, "-m", ledger]);
      expect(maskedRun.code).toBe(0);
      const result = await run(["restore", "-m", ledger, "-i", unknown, "-o", out]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("UNKNOWN 1:4 \u27e6PERSON_099\u27e7");
      expect(result.stderr).toContain("1 unknown placeholder; nothing written");
      expect(existsSync(out)).toBe(false);
      assertNoSurfaces(result.combined);
    });
  });

  test("encrypts the ledger and refuses a missing or wrong passphrase", async () => {
    await withTemp(async (dir) => {
      const ledger = join(dir, "map.json");
      const masked = join(dir, "note.masked.md");
      const restored = join(dir, "note.restored.md");
      const env = { ANON_TEST_PW: "correct-passphrase" };
      const maskedRun = await run(
        ["mask", "-d", dict, "-i", note, "-o", masked, "-m", ledger, "--encrypt", "--passphrase-env", "ANON_TEST_PW"],
        { env },
      );
      expect(maskedRun.code).toBe(0);
      expect(maskedRun.stderr).toContain("(sealed,");
      assertNoSurfaces(maskedRun.combined);
      expect(maskedRun.combined).not.toContain("correct-passphrase");
      const raw = readFileSync(ledger, "utf8");
      expect(raw).toContain("anon-ledger-encrypted");
      expect(raw).toContain("600000");
      for (const surface of SURFACES) expect(raw.includes(surface)).toBe(false);
      expect(raw).not.toContain("correct-passphrase");

      const restoreRun = await run(
        ["restore", "-m", ledger, "-i", masked, "-o", restored, "--passphrase-env", "ANON_TEST_PW"],
        { env },
      );
      expect(restoreRun.code).toBe(0);
      assertNoSurfaces(restoreRun.combined);
      expect(readFileSync(restored, "utf8")).toContain("山田花子");

      const missing = await run(["restore", "-m", ledger, "-i", masked, "-o", join(dir, "missing.md")]);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain("error: mode-mismatch sealed");
      expect(existsSync(join(dir, "missing.md"))).toBe(false);
      assertNoSurfaces(missing.combined);

      const wrong = await run(
        ["restore", "-m", ledger, "-i", masked, "-o", join(dir, "wrong.md"), "--passphrase-env", "ANON_TEST_PW"],
        { env: { ANON_TEST_PW: "wrong-passphrase-value" } },
      );
      expect(wrong.code).toBe(2);
      expect(wrong.stderr).toContain("error: wrong-passphrase");
      expect(existsSync(join(dir, "wrong.md"))).toBe(false);
      assertNoSurfaces(wrong.combined);
      expect(wrong.combined).not.toContain("wrong-passphrase-value");
      expect(wrong.combined).not.toContain("山田花子");
    });
  });

  test("extends an existing ledger and keeps a sealed iteration count", async () => {
    await withTemp(async (dir) => {
      const ledger = join(dir, "map.json");
      const firstOut = join(dir, "first.md");
      const secondOut = join(dir, "second.md");
      const first = await run(["mask", "-d", dict, "-i", note, "-o", firstOut, "-m", ledger]);
      expect(first.code).toBe(0);
      const before = readFileSync(ledger, "utf8");
      const second = await run(["mask", "-d", dict, "-i", mira, "-o", secondOut, "-m", ledger]);
      expect(second.code).toBe(0);
      assertNoSurfaces(second.combined);
      expect(second.stderr).toContain("(new)");
      const after = readFileSync(ledger, "utf8");
      expect(after).toContain("\u27e6PERSON_001\u27e7");
      expect(after).toContain("Mira Chen");
      expect(after.length).toBeGreaterThan(before.length);

      const sealedPath = join(dir, "sealed.json");
      const seeded = await encodeLedger(MappingLedger.empty(), {
        passphrase: "correct-passphrase",
        iterations: 1000,
      });
      expect(seeded.ok).toBe(true);
      if (!seeded.ok) return;
      await Bun.write(sealedPath, seeded.value);
      const extended = await run(
        ["mask", "-d", dict, "-i", note, "-o", join(dir, "from-sealed.md"), "-m", sealedPath, "--passphrase-env", "ANON_TEST_PW"],
        { env: { ANON_TEST_PW: "correct-passphrase" } },
      );
      expect(extended.code).toBe(0);
      assertNoSurfaces(extended.combined);
      expect(extended.combined).not.toContain("correct-passphrase");
      const saved = readFileSync(sealedPath, "utf8");
      expect(saved).toContain('"iterations": 1000');
      for (const surface of SURFACES) expect(saved.includes(surface)).toBe(false);
    });
  });

  test("rejects a non-text input and a passphrase on a plain restore", async () => {
    await withTemp(async (dir) => {
      const bad = await run(["check", "-d", dict, "-i", join(dir, "notes.csv")]);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain("error: bad-extension --in");

      const ledger = join(dir, "map.json");
      const masked = join(dir, "note.masked.md");
      const maskedRun = await run(["mask", "-d", dict, "-i", note, "-o", masked, "-m", ledger]);
      expect(maskedRun.code).toBe(0);
      const out = join(dir, "restored.md");
      const mismatch = await run(
        ["restore", "-m", ledger, "-i", masked, "-o", out, "--passphrase-env", "ANON_TEST_PW"],
        { env: { ANON_TEST_PW: "correct-passphrase" } },
      );
      expect(mismatch.code).toBe(2);
      expect(mismatch.stderr).toContain("error: mode-mismatch plain");
      expect(existsSync(out)).toBe(false);
      assertNoSurfaces(mismatch.combined);
    });
  });

  test("reads stdin and writes the ledger before the text file", async () => {
    await withTemp(async (dir) => {
      const ledger = join(dir, "map.json");
      const masked = join(dir, "stdin.masked.md");
      const fromStdin = await run(["mask", "-d", dict, "-i", "-", "-o", masked, "-m", ledger], {
        stdin: readFileSync(note, "utf8"),
      });
      expect(fromStdin.code).toBe(0);
      assertNoSurfaces(fromStdin.combined);
      expect(readFileSync(masked, "utf8")).toContain("\u27e6PERSON_001\u27e7");

      const blocked = join(dir, "blocked");
      mkdirSync(blocked);
      const blockedLedger = join(dir, "blocked-map.json");
      const failed = await run(["mask", "-d", dict, "-i", note, "-o", blocked, "-m", blockedLedger]);
      expect(failed.code).toBe(2);
      expect(failed.stderr).toContain("error: cannot-write --out");
      expect(existsSync(blockedLedger)).toBe(true);
      expect(statSync(blocked).isDirectory()).toBe(true);
      assertNoSurfaces(failed.combined);
    });
  });
});
