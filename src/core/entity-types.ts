export const ENTITY_TYPES = ["PERSON", "PLACE", "ORG", "ID", "EMAIL", "PHONE"] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];
