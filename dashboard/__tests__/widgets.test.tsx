/**
 * Widgets gallery — Solid parity tests for the G16-P1 port.
 *
 * Covers the three behaviours the React spec was exercising before:
 * tile catalog renders, kind chips filter the grid, search filters by
 * name + description (case-insensitive). Mocks `lib/api` so the
 * onMount `fetchSessions` Effect doesn't try to reach the daemon.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { Effect } from "effect";
import { render, fireEvent, cleanup } from "@solidjs/testing-library";
import { Router, Route } from "@solidjs/router";

// Mock the daemon client so onMount() resolves synchronously to "no
// sessions registered" — that's the default the React test would see
// against a fresh daemon.
vi.mock("@/lib/api", () => ({
  fetchSessions: () => Effect.succeed([]),
  API_BASE: "",
}));

import { WidgetsRoute } from "@/routes/widgets";

function renderRoute() {
  return render(() => (
    <Router>
      <Route path="/" component={WidgetsRoute} />
    </Router>
  ));
}

beforeEach(() => cleanup());

describe("/widgets", () => {
  it("renders the full catalog (8 TUI + 16 Solid = 24 tiles)", () => {
    const { getAllByTestId, getByTestId } = renderRoute();
    expect(getByTestId("widgets-gallery-page")).toBeInTheDocument();
    expect(getAllByTestId("widget-tile")).toHaveLength(24);
  });

  it("kind chips filter the grid down to the selected category", () => {
    const { getAllByTestId, getByTestId } = renderRoute();

    fireEvent.click(getByTestId("widgets-gallery-chip-tui"));
    expect(getAllByTestId("widget-tile")).toHaveLength(8);
    for (const tile of getAllByTestId("widget-tile")) {
      expect(tile.getAttribute("data-widget-kind")).toBe("tui");
    }

    fireEvent.click(getByTestId("widgets-gallery-chip-solid"));
    expect(getAllByTestId("widget-tile")).toHaveLength(16);

    fireEvent.click(getByTestId("widgets-gallery-chip-composite"));
    for (const tile of getAllByTestId("widget-tile")) {
      expect(tile.getAttribute("data-widget-composite")).toBe("true");
    }

    fireEvent.click(getByTestId("widgets-gallery-chip-all"));
    expect(getAllByTestId("widget-tile")).toHaveLength(24);
  });

  it("search input filters by name and description (case-insensitive)", () => {
    const { getAllByTestId, getByTestId, queryAllByTestId } = renderRoute();

    const search = getByTestId("widgets-gallery-search") as HTMLInputElement;

    fireEvent.input(search, { target: { value: "kanban" } });
    const kanbanTiles = getAllByTestId("widget-tile");
    expect(kanbanTiles.length).toBeGreaterThan(0);
    expect(kanbanTiles.some((t) => t.getAttribute("data-widget-id") === "KanbanBoard")).toBe(true);

    // Search by description fragment — case-insensitive.
    fireEvent.input(search, { target: { value: "Cmd+K" } });
    const paletteTiles = getAllByTestId("widget-tile");
    expect(paletteTiles.some((t) => t.getAttribute("data-widget-id") === "CommandPalette")).toBe(
      true,
    );

    // No match → empty-state placeholder, zero tiles.
    fireEvent.input(search, { target: { value: "definitelynothing" } });
    expect(queryAllByTestId("widget-tile")).toHaveLength(0);
    expect(getByTestId("widgets-gallery-empty")).toBeInTheDocument();
  });

  it("kind + search compose (TUI catalog, query 'config' → one tile)", () => {
    const { getAllByTestId, getByTestId } = renderRoute();
    fireEvent.click(getByTestId("widgets-gallery-chip-tui"));
    fireEvent.input(getByTestId("widgets-gallery-search"), { target: { value: "config" } });
    const tiles = getAllByTestId("widget-tile");
    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.getAttribute("data-widget-id")).toBe("config");
  });
});
