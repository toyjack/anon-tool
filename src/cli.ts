import { readFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  ENTITY_TYPES,
  MappingLedger,
  check,
  compileMatcher,
  mask,
  parseToken,
  restore,
  type CheckReport,
  type EntityType,
  type Leak,
  type MaskResult,
  type RestoreResult,
} from "./core";
import { parseDictionary, type DictionaryError } from "./io/dictionary";
import {
  decodeLedger,
  encodeLedger,
  inspectLedger,
  type LedgerFileError,
} from "./io/ledger-file";

const HELP = `anon mask --dict <yaml> --in <file|-> --ledger <file> [--out <file|->] [--encrypt] [--passphrase-env <NAME>]
anon check --dict <yaml> --in <file|->
anon restore --ledger <file> --in <file|-> [--out <file|->] [--passphrase-env <NAME>]

Exit 0 means ok. Exit 1 means leaks or unknown placeholders. Exit 2 means bad input.
Reports list counts, types, positions, and tokens.
`;

type PassphraseFlag = { readonly kind: "absent" } | { readonly kind: "env"; readonly name: string };

type MaskCommand = {
  readonly kind: "mask";
  readonly dict: string;
  readonly input: string;
  readonly output: string | null;
  readonly ledger: string;
  readonly encrypt: boolean;
  readonly passphrase: PassphraseFlag;
};

type CheckCommand = {
  readonly kind: "check";
  readonly dict: string;
  readonly input: string;
};

type RestoreCommand = {
  readonly kind: "restore";
  readonly input: string;
  readonly output: string | null;
  readonly ledger: string;
  readonly passphrase: PassphraseFlag;
};

type Command = MaskCommand | CheckCommand | RestoreCommand | { readonly kind: "help" } | { readonly kind: "invalid" };

type OpenedLedger =
  | { readonly mode: "new"; readonly ledger: MappingLedger }
  | { readonly mode: "plain"; readonly ledger: MappingLedger }
  | { readonly mode: "sealed"; readonly ledger: MappingLedger; readonly iterations: number };

const maskOptions = {
  dict: { type: "string", short: "d" },
  in: { type: "string", short: "i" },
  out: { type: "string", short: "o" },
  ledger: { type: "string", short: "m" },
  encrypt: { type: "boolean" },
  "passphrase-env": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

const checkOptions = {
  dict: { type: "string", short: "d" },
  in: { type: "string", short: "i" },
  help: { type: "boolean", short: "h" },
} as const;

const restoreOptions = {
  ledger: { type: "string", short: "m" },
  in: { type: "string", short: "i" },
  out: { type: "string", short: "o" },
  "passphrase-env": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

function usageError(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.stderr.write(HELP);
  process.exit(2);
}

function requiredText(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null;
  return value;
}

function passphraseFlag(name: string | undefined): PassphraseFlag | "invalid" {
  if (name === undefined) return { kind: "absent" };
  if (name.length === 0) return "invalid";
  return { kind: "env", name };
}

function optionalOutput(value: string | undefined): string | null | "invalid" {
  if (value === undefined) return null;
  if (value.length === 0) return "invalid";
  return value;
}

function parseMask(args: readonly string[]): Command {
  let values: {
    dict?: string;
    in?: string;
    out?: string;
    ledger?: string;
    encrypt?: boolean;
    "passphrase-env"?: string;
    help?: boolean;
  };
  try {
    values = parseArgs({
      args: [...args],
      options: maskOptions,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    return { kind: "invalid" };
  }
  if (values.help === true) return { kind: "help" };
  const dict = requiredText(values.dict);
  const input = requiredText(values.in);
  const ledger = requiredText(values.ledger);
  const output = optionalOutput(values.out);
  const passphrase = passphraseFlag(values["passphrase-env"]);
  if (dict === null || input === null || ledger === null || output === "invalid" || passphrase === "invalid") {
    return { kind: "invalid" };
  }
  return {
    kind: "mask",
    dict,
    input,
    ledger,
    output,
    encrypt: values.encrypt === true,
    passphrase,
  };
}

function parseCheck(args: readonly string[]): Command {
  let values: { dict?: string; in?: string; help?: boolean };
  try {
    values = parseArgs({
      args: [...args],
      options: checkOptions,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    return { kind: "invalid" };
  }
  if (values.help === true) return { kind: "help" };
  const dict = requiredText(values.dict);
  const input = requiredText(values.in);
  if (dict === null || input === null) return { kind: "invalid" };
  return { kind: "check", dict, input };
}

function parseRestore(args: readonly string[]): Command {
  let values: { ledger?: string; in?: string; out?: string; "passphrase-env"?: string; help?: boolean };
  try {
    values = parseArgs({
      args: [...args],
      options: restoreOptions,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    return { kind: "invalid" };
  }
  if (values.help === true) return { kind: "help" };
  const ledger = requiredText(values.ledger);
  const input = requiredText(values.in);
  const output = optionalOutput(values.out);
  const passphrase = passphraseFlag(values["passphrase-env"]);
  if (ledger === null || input === null || output === "invalid" || passphrase === "invalid") {
    return { kind: "invalid" };
  }
  return { kind: "restore", ledger, input, output, passphrase };
}

function parseArgv(argv: readonly string[]): Command {
  const [head, ...rest] = argv;
  if (head === undefined || head === "--help" || head === "-h") return { kind: "help" };
  if (head === "mask") return parseMask(rest);
  if (head === "check") return parseCheck(rest);
  if (head === "restore") return parseRestore(rest);
  return { kind: "invalid" };
}

function isAcceptedInput(path: string): boolean {
  if (path === "-") return true;
  const base = path.replaceAll("\\", "/").split("/").pop() ?? path;
  const lower = base.toLowerCase();
  return lower.endsWith(".txt") || lower.endsWith(".md");
}

function takePassphrase(flag: PassphraseFlag): string | undefined {
  if (flag.kind === "absent") return undefined;
  const value = process.env[flag.name];
  if (value === undefined) usageError("unset-passphrase-env");
  if (value.length === 0) usageError("empty-passphrase");
  return value;
}

function formatDictionaryError(error: DictionaryError): string {
  switch (error.code) {
    case "yaml-syntax":
      return `dictionary: yaml-syntax line ${error.line}`;
    case "unsupported-version":
      return "dictionary: unsupported-version";
    case "bad-shape":
      return `dictionary: bad-shape ${error.scope}`;
    case "bad-entry":
      return `dictionary: bad-entry ${error.entry}`;
    case "bad-type":
      return `dictionary: bad-type ${error.entry}`;
    case "bad-id":
      return `dictionary: bad-id ${error.entry}`;
    case "empty-surface":
      return `dictionary: empty-surface ${error.entry} ${error.field}`;
    case "reserved-bracket":
      return `dictionary: reserved-bracket ${error.entry} ${error.field}`;
    case "ambiguous-surface":
      return `dictionary: ambiguous-surface ${error.entries[0]} ${error.entries[1]}`;
    case "duplicate-id":
      return `dictionary: duplicate-id ${error.entries[0]} ${error.entries[1]}`;
    case "bad-detector":
      return `dictionary: bad-detector ${error.detector}`;
    case "bad-pattern":
      return `dictionary: bad-pattern ${error.detector}`;
    default: {
      const unreachable: never = error;
      throw new Error(unreachable);
    }
  }
}

function formatLedgerError(error: LedgerFileError): string {
  if (error.code === "mode-mismatch") return `error: mode-mismatch ${error.envelope}`;
  return `error: ${error.code}`;
}

function failLedger(errors: readonly LedgerFileError[]): never {
  for (const error of errors) process.stderr.write(`${formatLedgerError(error)}\n`);
  process.exit(2);
}

function failDictionary(errors: readonly DictionaryError[]): never {
  for (const error of errors) process.stderr.write(`${formatDictionaryError(error)}\n`);
  process.exit(2);
}

async function readRequired(path: string, flag: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) usageError(`cannot-read ${flag}`);
  return file.text();
}

async function readDocument(path: string): Promise<string> {
  // Bun.stdin.text() ends this process before the read resolves.
  if (path === "-") return readFileSync(0, "utf8");
  return readRequired(path, "--in");
}

function errnoCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" ? code : null;
}

async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = `${path}.anon-tmp`;
  await Bun.write(tmp, body);
  try {
    await rename(tmp, path);
  } catch (error) {
    const code = errnoCode(error);
    if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") {
      await rm(tmp, { force: true });
      throw error;
    }
    await rm(path, { force: true });
    await rename(tmp, path);
  }
}

async function writeRequired(path: string, body: string, flag: string): Promise<void> {
  try {
    await writeAtomic(path, body);
  } catch {
    usageError(`cannot-write ${flag}`);
  }
}

async function writeOutput(path: string | null, body: string): Promise<void> {
  if (path === null || path === "-") {
    process.stdout.write(body);
    return;
  }
  await writeRequired(path, body, "--out");
}

function typeRow(counts: ReadonlyMap<EntityType, number>): string {
  return ENTITY_TYPES.map((type) => `${type} ${counts.get(type) ?? 0}`).join("  ");
}

function countsByType(counts: ReadonlyMap<string, number>): Map<EntityType, number> {
  const totals = new Map<EntityType, number>(ENTITY_TYPES.map((type) => [type, 0]));
  for (const [token, count] of counts) {
    const parsed = parseToken(token);
    if (parsed === null) continue;
    totals.set(parsed.type, (totals.get(parsed.type) ?? 0) + count);
  }
  return totals;
}

function tokenLine(counts: ReadonlyMap<string, number>, fresh: ReadonlySet<string>): string {
  const parts: string[] = [];
  for (const [token, count] of counts) {
    const mark = fresh.has(token) ? " (new)" : "";
    parts.push(`${token} x${count}${mark}`);
  }
  if (parts.length === 0) return "";
  return `  ${parts.join("   ")}`;
}

function maskReport(result: MaskResult, ledgerPath: string, mode: "plain" | "sealed", entries: number): string {
  let spans = 0;
  for (const count of result.counts.values()) spans += count;
  const lines = [
    `masked ${spans} spans, ${result.counts.size} entities (${result.newTokens.size} new)`,
    typeRow(countsByType(result.counts)),
  ];
  const tokens = tokenLine(result.counts, result.newTokens);
  if (tokens.length > 0) lines.push(tokens);
  lines.push(`ledger: ${ledgerPath} (${mode}, ${entries} entries)`);
  return `${lines.join("\n")}\n`;
}

function leakSource(leak: Leak): string {
  if (leak.source.kind === "dictionary") return "dictionary";
  return `detector:${leak.source.detector}`;
}

function checkReport(report: CheckReport): string {
  const totals = new Map<EntityType, number>(ENTITY_TYPES.map((type) => [type, 0]));
  const lines = report.leaks.map((leak) => {
    totals.set(leak.type, (totals.get(leak.type) ?? 0) + 1);
    return `LEAK ${leak.at.line}:${leak.at.column} ${leak.type} (${leakSource(leak)})`;
  });
  lines.push(`${report.leaks.length} leaks`);
  lines.push(typeRow(totals));
  return `${lines.join("\n")}\n`;
}

function restoreReport(result: Extract<RestoreResult, { readonly kind: "restored" }>): string {
  let spans = 0;
  for (const count of result.counts.values()) spans += count;
  const lines = [`restored ${spans} placeholders`, typeRow(countsByType(result.counts))];
  const tokens = tokenLine(result.counts, new Set());
  if (tokens.length > 0) lines.push(tokens);
  return `${lines.join("\n")}\n`;
}

function unknownReport(result: Extract<RestoreResult, { readonly kind: "unknown-placeholders" }>): string {
  const lines = result.unknown.map((item) => `UNKNOWN ${item.position.line}:${item.position.column} ${item.token}`);
  const noun = result.unknown.length === 1 ? "placeholder" : "placeholders";
  lines.push(`${result.unknown.length} unknown ${noun}; nothing written`);
  return `${lines.join("\n")}\n`;
}

async function openForMask(path: string, passphrase: string | undefined, encrypt: boolean): Promise<OpenedLedger> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { mode: "new", ledger: MappingLedger.empty() };
  const text = await file.text();
  const header = inspectLedger(text);
  if (!header.ok) failLedger(header.errors);
  const passThrough = header.value.mode === "sealed" || (passphrase !== undefined && !encrypt);
  const decoded = await decodeLedger(text, passThrough ? passphrase : undefined);
  if (!decoded.ok) failLedger(decoded.errors);
  if (header.value.mode === "sealed") {
    return { mode: "sealed", ledger: decoded.value, iterations: header.value.iterations };
  }
  return { mode: "plain", ledger: decoded.value };
}

async function runMask(command: MaskCommand): Promise<never> {
  if (!isAcceptedInput(command.input)) usageError("bad-extension --in");
  const passphrase = takePassphrase(command.passphrase);
  const parsed = parseDictionary(await readRequired(command.dict, "--dict"));
  if (!parsed.ok) failDictionary(parsed.errors);
  const input = await readDocument(command.input);
  const opened = await openForMask(command.ledger, passphrase, command.encrypt);
  const result = mask(input, compileMatcher(parsed.value), opened.ledger);
  const seal = opened.mode === "sealed" || command.encrypt || (opened.mode === "new" && passphrase !== undefined);
  let encoded: Awaited<ReturnType<typeof encodeLedger>>;
  if (!seal) {
    encoded = await encodeLedger(result.ledger);
  } else if (passphrase === undefined) {
    usageError("mode-mismatch sealed");
  } else if (opened.mode === "sealed") {
    encoded = await encodeLedger(result.ledger, { passphrase, iterations: opened.iterations });
  } else {
    encoded = await encodeLedger(result.ledger, { passphrase });
  }
  if (!encoded.ok) failLedger(encoded.errors);
  await writeRequired(command.ledger, encoded.value, "--ledger");
  await writeOutput(command.output, result.masked);
  const mode = seal ? "sealed" : "plain";
  process.stderr.write(maskReport(result, command.ledger, mode, result.ledger.size()));
  process.exit(0);
}

async function runCheck(command: CheckCommand): Promise<never> {
  if (!isAcceptedInput(command.input)) usageError("bad-extension --in");
  const parsed = parseDictionary(await readRequired(command.dict, "--dict"));
  if (!parsed.ok) failDictionary(parsed.errors);
  const input = await readDocument(command.input);
  const report = check(input, compileMatcher(parsed.value));
  process.stderr.write(checkReport(report));
  process.exit(report.leaks.length === 0 ? 0 : 1);
}

async function runRestore(command: RestoreCommand): Promise<never> {
  if (!isAcceptedInput(command.input)) usageError("bad-extension --in");
  const passphrase = takePassphrase(command.passphrase);
  const decoded = await decodeLedger(await readRequired(command.ledger, "--ledger"), passphrase);
  if (!decoded.ok) failLedger(decoded.errors);
  const result = restore(await readDocument(command.input), decoded.value);
  if (result.kind === "unknown-placeholders") {
    process.stderr.write(unknownReport(result));
    process.exit(1);
  }
  await writeOutput(command.output, result.text);
  process.stderr.write(restoreReport(result));
  process.exit(0);
}

async function main(): Promise<void> {
  const command = parseArgv(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (command.kind === "invalid") usageError("bad-args");
  if (command.kind === "mask") await runMask(command);
  else if (command.kind === "check") await runCheck(command);
  else await runRestore(command);
}

main().catch(() => {
  process.stderr.write("error: failed\n");
  process.exit(2);
});
