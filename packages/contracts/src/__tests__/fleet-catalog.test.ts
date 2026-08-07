import { describe, expect, it } from "vitest";
import {
  FLEET_AGENT_HARNESS_IDS,
  FLEET_ID_TOKEN_MIN,
  FLEET_LABEL_MAX_LENGTH,
  FLEET_MAX_AGENTS_PER_SESSION,
  FLEET_MAX_PANES_PER_SESSION,
  FLEET_MAX_SESSIONS,
  FLEET_MAX_TOTAL_AGENTS,
  FleetAgentIdSchemaZ,
  FleetCatalogAgentEntryV1SchemaZ,
  FleetCatalogResourceV1SchemaZ,
  FleetCatalogSessionEntryV1SchemaZ,
  FleetProjectLabelSchemaZ,
  FleetSessionIdSchemaZ,
  type FleetCatalogAgentEntryV1,
  type FleetCatalogResourceV1,
  type FleetCatalogSessionEntryV1,
} from "../fleet-catalog.ts";

const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);
const TAB = String.fromCharCode(9);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);

const SESSION_TOKEN = "0123456789abcdef01";
const AGENT_TOKEN = "abcdef0123456789ab";

const DAEMON = {
  protocolVersion: 1,
  productVersion: "2.7.0",
  instanceId: "00000000-0000-4000-8000-000000000000",
  startedAt: "2026-07-22T12:00:00.000Z",
};

function agent(
  token: string,
  overrides: Partial<FleetCatalogAgentEntryV1> = {},
): FleetCatalogAgentEntryV1 {
  return {
    agentId: `agent.${token}`,
    name: "reviewer",
    harness: "claude-code",
    activity: "running",
    attention: false,
    statusSource: "authority",
    ...overrides,
  };
}

function session(
  token: string,
  overrides: Partial<FleetCatalogSessionEntryV1> = {},
): FleetCatalogSessionEntryV1 {
  return {
    sessionId: `session.${token}`,
    label: "fleet-one",
    projectLabel: "tmux-ide",
    appCreated: false,
    paneCount: 3,
    agents: [agent(AGENT_TOKEN)],
    ...overrides,
  };
}

function catalog(overrides: Partial<FleetCatalogResourceV1> = {}): FleetCatalogResourceV1 {
  return {
    version: 1,
    daemon: DAEMON,
    sessions: [session(SESSION_TOKEN)],
    ...overrides,
  } as FleetCatalogResourceV1;
}

function tokenOf(length: number): string {
  return "a".repeat(length);
}

describe("FleetCatalogResourceV1SchemaZ", () => {
  it("accepts a well-formed catalog", () => {
    expect(FleetCatalogResourceV1SchemaZ.safeParse(catalog()).success).toBe(true);
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(FleetCatalogResourceV1SchemaZ.safeParse({ ...catalog(), extra: true }).success).toBe(
      false,
    );
  });

  it("rejects a wrong version literal", () => {
    expect(FleetCatalogResourceV1SchemaZ.safeParse(catalog({ version: 2 as 1 })).success).toBe(
      false,
    );
  });

  describe("session and agent identity", () => {
    it("rejects a raw tmux session id", () => {
      expect(FleetSessionIdSchemaZ.safeParse("$3").success).toBe(false);
      expect(FleetSessionIdSchemaZ.safeParse("session.$3").success).toBe(false);
    });

    it("rejects a raw tmux pane id as an agent id", () => {
      expect(FleetAgentIdSchemaZ.safeParse("%7").success).toBe(false);
      expect(FleetAgentIdSchemaZ.safeParse("agent.%7").success).toBe(false);
    });

    it("rejects a session name with a space", () => {
      expect(FleetSessionIdSchemaZ.safeParse("session.my fleet").success).toBe(false);
    });

    it("rejects a filesystem path shaped id", () => {
      expect(FleetSessionIdSchemaZ.safeParse("session./home/user/proj").success).toBe(false);
      expect(FleetAgentIdSchemaZ.safeParse("agent./tmp/x").success).toBe(false);
    });

    it("rejects an unprefixed or wrongly prefixed id", () => {
      expect(FleetSessionIdSchemaZ.safeParse(`agent.${SESSION_TOKEN}`).success).toBe(false);
      expect(FleetAgentIdSchemaZ.safeParse(`session.${AGENT_TOKEN}`).success).toBe(false);
      expect(FleetSessionIdSchemaZ.safeParse(SESSION_TOKEN).success).toBe(false);
    });

    it("rejects a reserved record key smuggled as the token", () => {
      expect(FleetSessionIdSchemaZ.safeParse("__proto__").success).toBe(false);
      expect(FleetAgentIdSchemaZ.safeParse("agent.__proto__").success).toBe(false);
    });

    it("rejects a token below the minimum length", () => {
      expect(
        FleetSessionIdSchemaZ.safeParse(`session.${tokenOf(FLEET_ID_TOKEN_MIN - 1)}`).success,
      ).toBe(false);
    });

    it("accepts a token at the minimum length", () => {
      expect(
        FleetSessionIdSchemaZ.safeParse(`session.${tokenOf(FLEET_ID_TOKEN_MIN)}`).success,
      ).toBe(true);
    });
  });

  describe("labels", () => {
    it("rejects control characters in a session label", () => {
      for (const bad of [NUL, BELL, TAB, ESC, DEL]) {
        expect(
          FleetCatalogSessionEntryV1SchemaZ.safeParse(session(SESSION_TOKEN, { label: `x${bad}y` }))
            .success,
        ).toBe(false);
      }
    });

    it("rejects control characters in an agent name", () => {
      expect(
        FleetCatalogAgentEntryV1SchemaZ.safeParse(agent(AGENT_TOKEN, { name: `a${NUL}b` })).success,
      ).toBe(false);
    });

    it("rejects a path as the project label", () => {
      expect(FleetProjectLabelSchemaZ.safeParse("/home/user/tmux-ide").success).toBe(false);
      expect(FleetProjectLabelSchemaZ.safeParse("nested/dir").success).toBe(false);
      expect(FleetProjectLabelSchemaZ.safeParse("win\\path").success).toBe(false);
    });

    it("accepts a bare basename as the project label", () => {
      expect(FleetProjectLabelSchemaZ.safeParse("tmux-ide").success).toBe(true);
    });

    it("rejects an over-long label", () => {
      expect(
        FleetCatalogSessionEntryV1SchemaZ.safeParse(
          session(SESSION_TOKEN, { label: "a".repeat(FLEET_LABEL_MAX_LENGTH + 1) }),
        ).success,
      ).toBe(false);
    });
  });

  describe("enums and bounds", () => {
    it("accepts every harness id", () => {
      for (const harness of FLEET_AGENT_HARNESS_IDS) {
        expect(
          FleetCatalogAgentEntryV1SchemaZ.safeParse(agent(AGENT_TOKEN, { harness })).success,
        ).toBe(true);
      }
    });

    it("rejects an unknown harness", () => {
      expect(
        FleetCatalogAgentEntryV1SchemaZ.safeParse(
          agent(AGENT_TOKEN, { harness: "aider" as "custom" }),
        ).success,
      ).toBe(false);
    });

    it("rejects a negative or oversized pane count", () => {
      expect(
        FleetCatalogSessionEntryV1SchemaZ.safeParse(session(SESSION_TOKEN, { paneCount: -1 }))
          .success,
      ).toBe(false);
      expect(
        FleetCatalogSessionEntryV1SchemaZ.safeParse(
          session(SESSION_TOKEN, { paneCount: FLEET_MAX_PANES_PER_SESSION + 1 }),
        ).success,
      ).toBe(false);
    });
  });

  describe("caps and uniqueness", () => {
    it("rejects more sessions than the cap", () => {
      const sessions = Array.from({ length: FLEET_MAX_SESSIONS + 1 }, (_unused, index) =>
        session(`sessiontoken${String(index).padStart(6, "0")}`, { agents: [] }),
      );
      expect(FleetCatalogResourceV1SchemaZ.safeParse(catalog({ sessions })).success).toBe(false);
    });

    it("rejects more agents in a session than the per-session cap", () => {
      const agents = Array.from({ length: FLEET_MAX_AGENTS_PER_SESSION + 1 }, (_unused, index) =>
        agent(`agenttoken000${String(index).padStart(6, "0")}`),
      );
      expect(
        FleetCatalogSessionEntryV1SchemaZ.safeParse(session(SESSION_TOKEN, { agents })).success,
      ).toBe(false);
    });

    it("rejects a fleet whose total agents exceed the cap", () => {
      let counter = 0;
      const sessions = Array.from({ length: 6 }, (_unused, sessionIndex) => {
        const agents = Array.from({ length: FLEET_MAX_AGENTS_PER_SESSION }, () =>
          agent(`agenttoken${String(counter++).padStart(8, "0")}`),
        );
        return session(`sessiontoken${String(sessionIndex).padStart(6, "0")}`, { agents });
      });
      // 6 * 64 = 384 > 256.
      expect(FleetCatalogResourceV1SchemaZ.safeParse(catalog({ sessions })).success).toBe(false);
    });

    it("rejects duplicate session ids", () => {
      expect(
        FleetCatalogResourceV1SchemaZ.safeParse(
          catalog({ sessions: [session(SESSION_TOKEN), session(SESSION_TOKEN)] }),
        ).success,
      ).toBe(false);
    });

    it("rejects an agent id duplicated across sessions", () => {
      expect(
        FleetCatalogResourceV1SchemaZ.safeParse(
          catalog({
            sessions: [
              session("sessiontokenaaaa01", { agents: [agent(AGENT_TOKEN)] }),
              session("sessiontokenbbbb02", { agents: [agent(AGENT_TOKEN)] }),
            ],
          }),
        ).success,
      ).toBe(false);
    });

    it("accepts the maximum total agents exactly", () => {
      let counter = 0;
      const perSession = FLEET_MAX_TOTAL_AGENTS / 4;
      const sessions = Array.from({ length: 4 }, (_unused, sessionIndex) => {
        const agents = Array.from({ length: perSession }, () =>
          agent(`agenttoken${String(counter++).padStart(8, "0")}`),
        );
        return session(`sessiontoken${String(sessionIndex).padStart(6, "0")}`, { agents });
      });
      expect(FleetCatalogResourceV1SchemaZ.safeParse(catalog({ sessions })).success).toBe(true);
    });
  });
});
