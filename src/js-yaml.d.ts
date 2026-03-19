declare module "js-yaml" {
  function load(input: string): unknown;
  function dump(
    input: unknown,
    options?: { lineWidth?: number; noRefs?: boolean; quotingType?: string },
  ): string;
  const _default: { load: typeof load; dump: typeof dump };
  export default _default;
  export { load, dump };
}
