declare const nfkcBrand: unique symbol;

export type Nfkc = string & { readonly [nfkcBrand]: "Nfkc" };

export type TextPosition = {
  readonly line: number;
  readonly column: number;
};

function isNfkc(value: string): value is Nfkc {
  return value.normalize("NFKC") === value;
}

export function nfkc(raw: string): Nfkc {
  const normalized = raw.normalize("NFKC");
  if (isNfkc(normalized)) return normalized;
  throw new Error("NFKC normalization was not stable");
}

export function positionOf(text: string, offset: number): TextPosition {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
    throw new RangeError("offset out of range");
  }
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}
