import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { waitDevelopmentAppExit } from "../lib/development-app.ts";
it("retains a fast child's completion across asynchronous admission work", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
  const completion = waitDevelopmentAppExit(child);
  await new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await expect(completion).resolves.toBe(7);
  await expect(waitDevelopmentAppExit(child)).resolves.toBe(7);
});
it("settles a failed spawn instead of leaving an app command hanging", async () => {
  const child = spawn("/nonexistent/tmux-ide-d05-child", [], { stdio: "ignore" });
  await expect(waitDevelopmentAppExit(child)).resolves.toBe(1);
});
