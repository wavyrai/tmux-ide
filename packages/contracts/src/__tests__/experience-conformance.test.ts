import { describe, expect, it } from "vitest";
import {
  PANE_ROLE_IDS,
  PaneRoleIdSchemaZ,
  SEMANTIC_ICON_IDS,
  SemanticIconIdSchemaZ,
} from "../experience-identifiers.ts";
import {
  CANONICAL_SURFACE_REGISTRY,
  DOCK_TOOL_IDS,
  DockToolIdSchemaZ,
  PRIMARY_WORKSPACE_MODE_IDS,
  PRODUCT_SURFACE_IDS,
  PrimaryWorkspaceModeIdSchemaZ,
  ProductSurfaceIdSchemaZ,
} from "../experience-shell.ts";
import {
  AGENT_ACTIVITY_IDS,
  AgentActivitySchemaZ,
  CANONICAL_DOMAIN_STATUS_IDS,
  CanonicalDomainStatusSchemaZ,
  PANE_ATTENTION_IDS,
  PaneAttentionSchemaZ,
  statusToneForDomainStatus,
} from "../pane-appearance.ts";
import {
  BORDER_TOKEN_ROLES,
  BUILTIN_VISUAL_THEMES,
  DENSITY_TOKEN_ROLES,
  ELEVATION_TOKEN_ROLES,
  FOCUS_TOKEN_ROLES,
  MOTION_DURATION_ROLES,
  SELECTION_TOKEN_ROLES,
  SHAPE_TOKEN_ROLES,
  STATUS_TONE_ROLES,
  SURFACE_TOKEN_ROLES,
  TEXT_TOKEN_ROLES,
  TYPOGRAPHY_TOKEN_ROLES,
  VisualTokensV1SchemaZ,
  WINDOW_ACTIVITY_TOKEN_ROLES,
  type VisualTokensV1,
} from "../visual-tokens.ts";

const TOKEN_ROLES_BY_GROUP = {
  surfaces: SURFACE_TOKEN_ROLES,
  text: TEXT_TOKEN_ROLES,
  borders: BORDER_TOKEN_ROLES,
  statusTone: STATUS_TONE_ROLES,
  selection: SELECTION_TOKEN_ROLES,
  density: DENSITY_TOKEN_ROLES,
  shape: SHAPE_TOKEN_ROLES,
  elevation: ELEVATION_TOKEN_ROLES,
  motion: [...MOTION_DURATION_ROLES, "easing"],
  typography: TYPOGRAPHY_TOKEN_ROLES,
  focus: FOCUS_TOKEN_ROLES,
  windowActivity: WINDOW_ACTIVITY_TOKEN_ROLES,
} as const satisfies Readonly<{
  [Group in keyof VisualTokensV1]: readonly (keyof VisualTokensV1[Group])[];
}>;

const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const TOKEN_IDS = Object.entries(TOKEN_ROLES_BY_GROUP).flatMap(([group, roles]) =>
  roles.map((role) => `${group}.${String(role)}`),
);

/** One transport-shaped identity fixture proves the complete host adapter vocabulary. */
const CONFORMANCE_ID_FIXTURE_V1 = Object.freeze({
  version: 1 as const,
  tokens: TOKEN_IDS,
  icons: SEMANTIC_ICON_IDS,
  statuses: {
    agentActivity: AGENT_ACTIVITY_IDS,
    domain: CANONICAL_DOMAIN_STATUS_IDS,
    attention: PANE_ATTENTION_IDS,
  },
  surfaces: PRODUCT_SURFACE_IDS,
  paneRoles: PANE_ROLE_IDS,
});

function expectUniqueSerializableIds(
  ids: readonly string[],
  parse: (value: unknown) => unknown,
): void {
  expect(new Set(ids).size).toBe(ids.length);
  expect(jsonRoundTrip(ids)).toEqual(ids);
  for (const id of ids) expect(parse(jsonRoundTrip(id))).toBe(id);
}

describe("experience-kernel identifier conformance", () => {
  it("round-trips the complete adapter identity fixture", () => {
    expect(jsonRoundTrip(CONFORMANCE_ID_FIXTURE_V1)).toEqual(CONFORMANCE_ID_FIXTURE_V1);
  });

  it("keeps every required visual token role exhaustive and serializable", () => {
    expectUniqueSerializableIds(TOKEN_IDS, (id) => id);

    for (const tokens of Object.values(BUILTIN_VISUAL_THEMES)) {
      const roundTripped = VisualTokensV1SchemaZ.parse(jsonRoundTrip(tokens));
      for (const [group, roles] of Object.entries(TOKEN_ROLES_BY_GROUP)) {
        expect(Object.keys(roundTripped[group as keyof VisualTokensV1]).sort(), group).toEqual(
          [...roles].sort(),
        );
      }
    }
  });

  it("keeps every semantic icon ID exhaustive and serializable", () => {
    expectUniqueSerializableIds(SEMANTIC_ICON_IDS, (id) => SemanticIconIdSchemaZ.parse(id));
    expect(CANONICAL_SURFACE_REGISTRY.map(({ icon }) => icon)).toEqual([
      "home",
      "terminals",
      "files",
      "changes",
      "missions",
      "activity",
    ]);
  });

  it("keeps every canonical status ID exhaustive and serializable", () => {
    expectUniqueSerializableIds(AGENT_ACTIVITY_IDS, (id) => AgentActivitySchemaZ.parse(id));
    expectUniqueSerializableIds(CANONICAL_DOMAIN_STATUS_IDS, (id) =>
      CanonicalDomainStatusSchemaZ.parse(id),
    );
    expectUniqueSerializableIds(PANE_ATTENTION_IDS, (id) => PaneAttentionSchemaZ.parse(id));
    expect(
      Object.fromEntries(
        CANONICAL_DOMAIN_STATUS_IDS.map((status) => [status, statusToneForDomainStatus(status)]),
      ),
    ).toEqual({
      idle: "neutral",
      running: "info",
      blocked: "warning",
      review: "info",
      done: "success",
      disconnected: "danger",
      recovering: "danger",
    });
  });

  it("keeps every product surface ID exhaustive and serializable", () => {
    expectUniqueSerializableIds(PRIMARY_WORKSPACE_MODE_IDS, (id) =>
      PrimaryWorkspaceModeIdSchemaZ.parse(id),
    );
    expectUniqueSerializableIds(DOCK_TOOL_IDS, (id) => DockToolIdSchemaZ.parse(id));
    expectUniqueSerializableIds(PRODUCT_SURFACE_IDS, (id) => ProductSurfaceIdSchemaZ.parse(id));
    expect(CANONICAL_SURFACE_REGISTRY.map(({ id }) => id)).toEqual(PRODUCT_SURFACE_IDS);
  });

  it("keeps every pane-role ID exhaustive and serializable", () => {
    expectUniqueSerializableIds(PANE_ROLE_IDS, (id) => PaneRoleIdSchemaZ.parse(id));
  });
});
