// Minimal module declaration for the uuid package (no @types/uuid installed).
declare module "uuid" {
  export function v4(): string;
}
