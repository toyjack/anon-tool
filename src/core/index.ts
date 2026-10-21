export { ENTITY_TYPES, type EntityType } from "./entity-types";
export { nfkc, positionOf, type Nfkc, type TextPosition } from "./text";
export {
  formatToken,
  parseToken,
  scanPlaceholders,
  type ParsedToken,
  type PlaceholderSpan,
} from "./placeholder";
export type { Result } from "./result";
export {
  DETECTOR_KINDS,
  DICTIONARY_TYPES,
  compileMatcher,
  entityKeyForDictionary,
  type DetectorConfig,
  type DetectorKind,
  type Dictionary,
  type DictionaryEntity,
  type DictionaryType,
  type Entity,
  type EntityKey,
  type Matcher,
  type SpanSource,
} from "./entity";
export { MappingLedger, type LedgerEntry, type LedgerInput, type LedgerInvariantError } from "./ledger";
export { check, mask, type CheckReport, type Leak, type MaskResult } from "./mask-engine";
export { restore, type RestoreResult, type UnknownPlaceholder } from "./restore";
