// The Mission Control composite (HeroStrip / KpiStrip / MilestoneLadder /
// AgentActivityRail / EventStream / MissionEditDialog / AgentDetailDialog /
// MissionView) retired in U2 — the Solid `MissionControlBridge` is the only
// render path. The tree navigator stays because the navigators/ slot is
// still wired (U5 retires it together with the rest of the legacy shell).
export { MissionTreeNavigator } from "./MissionTreeNavigator";
