#!/usr/bin/env bun
// Thin shim — delegates to cli.ts which runs natively under Bun.
// This file exists for backward compatibility with npm/pnpm link.
import "./cli.ts";
