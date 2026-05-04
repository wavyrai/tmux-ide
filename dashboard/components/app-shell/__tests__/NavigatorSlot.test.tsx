import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NavigatorSlot } from "../NavigatorSlot";
import {
  NavigatorPortal,
  __resetNavigatorSlotForTests,
} from "@/lib/useNavigatorSlot";

/**
 * After the AppShell refactor, NavigatorSlot is a deprecated no-op shim.
 * The new shell picks navigators from NavigationState directly. These
 * tests now codify the shim contract: the slot renders nothing, and the
 * portal compat shim drops its children silently.
 */
describe("NavigatorSlot (deprecated shim)", () => {
  it("renders nothing on its own", () => {
    const { container } = render(<NavigatorSlot />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing even when a NavigatorPortal is mounted (children dropped)", () => {
    const { container } = render(
      <>
        <NavigatorPortal>
          <div data-testid="dropped-content">should not render</div>
        </NavigatorPortal>
        <NavigatorSlot />
      </>,
    );
    expect(container.firstChild).toBeNull();
  });

  it("__resetNavigatorSlotForTests is a safe no-op", () => {
    expect(() => __resetNavigatorSlotForTests()).not.toThrow();
  });
});
