import { Dialog as Primitive } from "@base-ui/react/dialog";
import { createContext, type RefObject, useContext } from "react";

// Portals stay inside the themed app root, outside its workspace. This preserves
// live CSS variables without copying palettes onto document.body.
export const OverlayContainer = createContext<RefObject<HTMLDivElement | null> | null>(null);

function Portal(props: Primitive.Portal.Props) {
  const container = useContext(OverlayContainer);
  return <Primitive.Portal container={container} {...props} />;
}

export const Dialog = { ...Primitive, Portal };
