import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

import { sharedMonotonicMicros } from "@tmux-ide/contracts";
import {
  calibratePaneStreamClocks,
  crossProcessOneWayBounds,
  daemonToClientOneWayBounds,
  qualifyPaneStreamClockCalibration,
} from "./pane-stream-clock-calibration.ts";

const REQUEST = "00000000-0000-4000-8000-000000000061";
const DAEMON = "00000000-0000-4000-8000-000000000062";

describe("pane-stream cross-process clock calibration", () => {
  test("reports NTP bounds for positive/negative offsets and asymmetric delay", () => {
    for (const offset of [1_000, -700]) {
      const calibration = calibratePaneStreamClocks(REQUEST, DAEMON, [
        {
          probe: 1,
          clientSendMicros: 0,
          daemonReceiveMicros: offset + 100,
          daemonSendMicros: offset + 110,
          clientReceiveMicros: 130,
        },
        {
          probe: 2,
          clientSendMicros: 1_000,
          daemonReceiveMicros: offset + 1_040,
          daemonSendMicros: offset + 1_045,
          clientReceiveMicros: 1_060,
        },
      ]);
      expect(calibration).not.toBeNull();
      expect(calibration!.probe).toBe(2);
      expect(calibration!.offsetLowerMicros).toBe(offset - 15);
      expect(calibration!.offsetUpperMicros).toBe(offset + 40);
      expect(crossProcessOneWayBounds(calibration!, 1_000, offset + 1_040)).toEqual({
        lowerMicros: 0,
        upperMicros: 55,
      });
      expect(daemonToClientOneWayBounds(calibration!, offset + 1_045, 1_060)).toEqual({
        lowerMicros: 0,
        upperMicros: 55,
      });
    }
  });

  test("rejects malformed samples and stale, wide, or cross-connection calibration", () => {
    expect(
      calibratePaneStreamClocks(REQUEST, DAEMON, [
        {
          probe: 1,
          clientSendMicros: 10,
          daemonReceiveMicros: 20,
          daemonSendMicros: 19,
          clientReceiveMicros: 30,
        },
        {
          probe: 2,
          clientSendMicros: 40,
          daemonReceiveMicros: 50,
          daemonSendMicros: 60,
          clientReceiveMicros: 39,
        },
        {
          probe: 6,
          clientSendMicros: 0,
          daemonReceiveMicros: 0,
          daemonSendMicros: 0,
          clientReceiveMicros: 0,
        },
      ]),
    ).toBeNull();
    const calibration = calibratePaneStreamClocks(REQUEST, DAEMON, [
      {
        probe: 1,
        clientSendMicros: 0,
        daemonReceiveMicros: 10,
        daemonSendMicros: 11,
        clientReceiveMicros: 20,
      },
    ])!;
    expect(
      qualifyPaneStreamClockCalibration(calibration, {
        requestId: REQUEST,
        daemonInstanceId: DAEMON,
        nowMicros: 25,
        maxAgeMicros: 10,
        maxUncertaintyMicros: 20,
      }),
    ).toBe(true);
    expect(
      qualifyPaneStreamClockCalibration(calibration, {
        requestId: crypto.randomUUID(),
        daemonInstanceId: DAEMON,
        nowMicros: 25,
        maxAgeMicros: 10,
        maxUncertaintyMicros: 20,
      }),
    ).toBe(false);
    expect(
      qualifyPaneStreamClockCalibration(calibration, {
        requestId: REQUEST,
        daemonInstanceId: DAEMON,
        nowMicros: 40,
        maxAgeMicros: 10,
        maxUncertaintyMicros: 20,
      }),
    ).toBe(false);
    expect(
      qualifyPaneStreamClockCalibration(calibration, {
        requestId: REQUEST,
        daemonInstanceId: DAEMON,
        nowMicros: 25,
        maxAgeMicros: 10,
        maxUncertaintyMicros: 5,
      }),
    ).toBe(false);
    expect(
      calibratePaneStreamClocks(REQUEST, DAEMON, [
        {
          probe: 1,
          clientSendMicros: Number.MAX_SAFE_INTEGER,
          daemonReceiveMicros: 0,
          daemonSendMicros: Number.MAX_SAFE_INTEGER,
          clientReceiveMicros: Number.MAX_SAFE_INTEGER,
        },
      ]),
    ).toBeNull();
    expect(
      crossProcessOneWayBounds(
        { ...calibration, offsetLowerMicros: 10, offsetUpperMicros: 20 },
        100,
        95,
      ),
    ).toBeNull();
  });

  test("Bun parent calibrates Node/Bun children by handshake without trusting epochs", async () => {
    for (const executable of ["node", process.execPath]) {
      const child = spawn(executable, [
        "-e",
        `const o=process.hrtime.bigint();let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;for(;;){const i=b.indexOf("\\n");if(i<0)break;const q=JSON.parse(b.slice(0,i));b=b.slice(i+1);const d1=Number((process.hrtime.bigint()-o)/1000n);const d2=Number((process.hrtime.bigint()-o)/1000n);process.stdout.write(JSON.stringify({...q,d1,d2})+"\\n")}})`,
      ]);
      try {
        const origin = sharedMonotonicMicros();
        let stdout = "";
        let exited = false;
        child.once("exit", () => {
          exited = true;
        });
        const replies: Array<{
          probe: number;
          clientSendMicros: number;
          d1: number;
          d2: number;
          clientReceiveMicros: number;
        }> = [];
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          for (;;) {
            const index = stdout.indexOf("\n");
            if (index < 0) break;
            const reply = JSON.parse(stdout.slice(0, index));
            stdout = stdout.slice(index + 1);
            replies.push({ ...reply, clientReceiveMicros: sharedMonotonicMicros() - origin });
          }
        });
        for (let probe = 1; probe <= 5; probe += 1) {
          const clientSendMicros = sharedMonotonicMicros() - origin;
          child.stdin.write(`${JSON.stringify({ probe, clientSendMicros })}\n`);
          const deadline = Date.now() + 1_000;
          while (replies.length < probe) {
            if (exited) throw new Error(`${executable} exited before clock reply ${probe}`);
            if (Date.now() >= deadline)
              throw new Error(`${executable} clock reply ${probe} timed out`);
            await Bun.sleep(1);
          }
        }
        const calibration = calibratePaneStreamClocks(
          REQUEST,
          DAEMON,
          replies.map((reply) => ({
            probe: reply.probe,
            clientSendMicros: reply.clientSendMicros,
            daemonReceiveMicros: reply.d1,
            daemonSendMicros: reply.d2,
            clientReceiveMicros: reply.clientReceiveMicros,
          })),
        );
        expect(calibration).not.toBeNull();
        expect(calibration!.probe).toBeGreaterThanOrEqual(1);
        expect(calibration!.probe).toBeLessThanOrEqual(5);
        expect(calibration!.uncertaintyMicros).toBeGreaterThanOrEqual(0);
      } finally {
        child.stdin.end();
        if (child.exitCode === null) child.kill();
        await Promise.race([
          new Promise<void>((resolve) => child.once("close", () => resolve())),
          Bun.sleep(1_000).then(() => undefined),
        ]);
      }
    }
  });
});
