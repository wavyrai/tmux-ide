import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createPreviewChannel } from "./preview-channel.mjs";

test(
  "inherited endpoints carry exact binary bytes without launcher payload I/O",
  { timeout: 5000 },
  async () => {
    const channel = await createPreviewChannel();
    const children = [];
    try {
      const sender = spawn(
        process.execPath,
        [
          "-e",
          `
      const bytes=Buffer.alloc(256*1024); for(let i=0;i<bytes.length;i++)bytes[i]=i%256;
      process.stdin.once('data',b=>process.exit(b.toString()==='accepted'?0:4));
      process.stdout.write(bytes);
    `,
        ],
        { stdio: [channel.helper, channel.helper, "inherit"] },
      );
      children.push(sender);
      const receiver = spawn(
        process.execPath,
        [
          "-e",
          `
      let offset=0; process.stdin.on('data',b=>{
        for(const value of b) { if(value!==offset%256)process.exit(5); offset++; }
        if(offset===256*1024)process.stdout.write('accepted',()=>process.exit(0));
        if(offset>256*1024)process.exit(6);
      });
    `,
        ],
        { stdio: [channel.viewer, channel.viewer, "inherit"] },
      );
      children.push(receiver);
      const waits = children.map((child) => once(child, "close"));
      assert.ok(children.every((child) => child.stdin === null && child.stdout === null));
      await channel.close();
      assert.deepEqual(await Promise.all(waits), [
        [0, null],
        [0, null],
      ]);
      assert.equal(channel.viewer.bytesRead + channel.helper.bytesRead, 0);
      assert.equal(channel.viewer.bytesWritten + channel.helper.bytesWritten, 0);
      await channel.close();
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await channel.close();
    }
  },
);

test("cancelled setup admits no endpoints", async () => {
  await assert.rejects(createPreviewChannel({ signal: AbortSignal.abort() }), /cancelled/);
  const controller = new AbortController();
  const pending = createPreviewChannel({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled|setup failed/);
});
