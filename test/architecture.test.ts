import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const FORBIDDEN_RUNTIME = /\bBun\b|\bprocess\b|node:fs|\bcrypto\b/;
const SPECIFIER = /from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

export function hasForbiddenRuntimeRef(source: string): boolean {
  return FORBIDDEN_RUNTIME.test(source);
}

export function illegalCoreSpecifier(spec: string): boolean {
  const normalized = spec.replaceAll("\\", "/").replace(/\.(tsx?|jsx?)$/, "");
  if (!/(?:^|\/)core(?:\/|$)/.test(normalized)) return false;
  return !/(?:^|\/)core(?:\/index)?$/.test(normalized);
}

function listTypeScriptFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) out.push(...listTypeScriptFiles(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

function specifierFrom(match: RegExpMatchArray): string | undefined {
  return match[1] ?? match[2] ?? match[3];
}

function shellFiles(): string[] {
  const files: string[] = [];
  const cli = join(root, "src", "cli.ts");
  if (existsSync(cli)) files.push(cli);
  files.push(...listTypeScriptFiles(join(root, "src", "io")));
  return files;
}

describe("core stays free of the runtime shell", () => {
  test("recognizes Bun, process, node:fs, and crypto", () => {
    expect(hasForbiddenRuntimeRef('import { readFileSync } from "node:fs"')).toBe(true);
    expect(hasForbiddenRuntimeRef("const env = process.env.HOME")).toBe(true);
    expect(hasForbiddenRuntimeRef("crypto.subtle")).toBe(true);
    expect(hasForbiddenRuntimeRef("Bun.file")).toBe(true);
    expect(hasForbiddenRuntimeRef("const processed = 1")).toBe(false);
  });

  test("allows only the core barrel from outside core", () => {
    expect(illegalCoreSpecifier("../core/placeholder")).toBe(true);
    expect(illegalCoreSpecifier("../core/text.ts")).toBe(true);
    expect(illegalCoreSpecifier("../core/index")).toBe(false);
    expect(illegalCoreSpecifier("../core/index.ts")).toBe(false);
    expect(illegalCoreSpecifier("../core/index.js")).toBe(false);
    expect(illegalCoreSpecifier("../core/placeholder.js")).toBe(true);
    expect(illegalCoreSpecifier("../core")).toBe(false);
    expect(illegalCoreSpecifier("./dictionary")).toBe(false);
  });

  test("src/core does not mention Bun, process, node:fs, or crypto", () => {
    const files = listTypeScriptFiles(join(root, "src", "core"));
    const hits = files.filter((file) => hasForbiddenRuntimeRef(readFileSync(file, "utf8")));
    expect(hits).toEqual([]);
  });

  test("cli and io import core only through the barrel, when those files exist", () => {
    const files = shellFiles();
    const illegal: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(SPECIFIER)) {
        const spec = specifierFrom(match);
        if (spec !== undefined && illegalCoreSpecifier(spec)) illegal.push(`${file} -> ${spec}`);
      }
    }
    expect(illegal).toEqual([]);
  });
});
