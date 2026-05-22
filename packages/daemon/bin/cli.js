#!/usr/bin/env bun
// Thin shim — delegates to ../src/bin.ts which runs natively under Bun.
// Also runnable under Node 22+ via --experimental-strip-types.
import "../src/bin.ts";
