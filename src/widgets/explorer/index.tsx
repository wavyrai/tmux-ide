import { render, useTerminalDimensions } from "@opentui/solid";
import { RGBA, TextAttributes } from "@opentui/core";

render(() => {
  const dimensions = useTerminalDimensions();

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      backgroundColor={RGBA.fromInts(30, 30, 40)}
      paddingLeft={1}
      paddingTop={1}
    >
      <box flexDirection="row" gap={1}>
        <text fg={RGBA.fromInts(130, 170, 255)} attributes={TextAttributes.BOLD}>
          ⎇ main
        </text>
        <text fg={RGBA.fromInts(120, 120, 140)}>tmux-ide explorer</text>
      </box>
      <box paddingTop={1}>
        <text fg={RGBA.fromInts(200, 200, 210)}>▸ src/</text>
        <text fg={RGBA.fromInts(200, 200, 210)}>▸ docs/</text>
        <text fg={RGBA.fromInts(200, 200, 210)}>▸ templates/</text>
        <text fg={RGBA.fromInts(160, 160, 170)}> package.json</text>
        <text fg={RGBA.fromInts(160, 160, 170)}> tsconfig.json</text>
      </box>
      <box position="absolute" bottom={0} left={1}>
        <text fg={RGBA.fromInts(80, 80, 100)}>Press q to quit</text>
      </box>
    </box>
  );
});
