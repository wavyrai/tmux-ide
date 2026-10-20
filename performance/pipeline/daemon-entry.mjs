// Starts the CLI daemon with the pipeline probe loaded first. argv[1] is restored
// to the real CLI so the CLI's own build-identity checks see the shipped path.
import "./probe.mjs";
const cli = process.env.PIPELINE_PROBE_CLI;
process.argv[1] = cli;
await import(cli);
