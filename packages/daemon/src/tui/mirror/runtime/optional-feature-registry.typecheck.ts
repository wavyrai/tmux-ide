import type { OptionalFeatureRegistry } from "./optional-feature-registry.ts";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Value extends true> = Value;

type KnownFeatureRegistry = OptionalFeatureRegistry<{ readonly files: { readonly count: number } }>;

/** Compilation fails if the generic feature key ever widens from `files` to `string`. */
export type OptionalFeatureRegistryKnownKeyContract = Assert<
  Equal<Parameters<KnownFeatureRegistry["request"]>[0], "files">
>;
