# anon-tool

Local Bun CLI that masks personal data in `.txt` and `.md` files before you send text to a generative AI, then restores the reply from a mapping ledger.

No network. Reports are limited to counts, types, positions, and tokens. Examples below use fictional names.

## Mask a document

`anon mask` reads a dictionary and a document, writes a ledger, then writes the masked document. An existing ledger is extended, so the same entity keeps the same placeholder.

```bash
anon mask -d campus.dict.yaml -i notes.md -o notes.masked.md -m campus.map.json
```

Omit `--out` to print the masked document on stdout. The report stays on stderr. `--in -` reads stdin. The input path must end in `.txt` or `.md`.

To seal the ledger, put a passphrase in the environment and pass the variable name. The passphrase is not a command-line argument.

```bash
anon mask -d campus.dict.yaml -i notes.md -o notes.masked.md -m campus.map.json --encrypt --passphrase-env ANON_PW
```

`--passphrase-env` on a new ledger seals it even when `--encrypt` is omitted. An existing sealed ledger stays sealed. `--encrypt` on an existing plain ledger seals that ledger.

The ledger file is replaced first. The masked file is replaced second. Each replace writes a sibling that ends in `.anon-tmp`, then renames it into place.

## Check a masked document

`anon check` exits with status 1 when a dictionary surface or a detector hit is still present.

```bash
anon check -d campus.dict.yaml -i notes.masked.md
```

## Restore a reply

`anon restore` replaces placeholders with the entity name from the ledger. Every alias of an entity comes back as that name. If any placeholder is missing from the ledger, the command writes nothing and exits with status 1.

```bash
anon restore -m campus.map.json -i reply.md -o reply.restored.md
```

A sealed ledger needs `--passphrase-env`. A plain ledger rejects that flag. An empty passphrase is rejected.

## Dictionary

One YAML file lists the entities for a project.

```yaml
version: 1
entities:
  - type: PERSON
    name: 北条蓮
    aliases:
      - 蓮
  - type: ORG
    name: 明星大学
detectors:
  email: true
  phone: true
  studentId: "[A-Z][0-9]{7}"
```

## Exit codes

- `0` means the command finished.
- `1` means check found leaks, or restore found an unknown placeholder.
- `2` means the arguments, dictionary, ledger, or passphrase was rejected.

## Develop

```bash
bun install
bun test
bun run typecheck
bun run build
```

`bun run build` writes a standalone `anon` binary.
