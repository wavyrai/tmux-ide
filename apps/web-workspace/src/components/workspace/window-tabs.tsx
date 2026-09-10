import { WorkbenchTabs } from "../../design-workbench/workbench-tabs";
export interface WindowTab {
  id: string;
  name: string;
  command: string;
  paneCount: number;
  zoomed: boolean;
}
export function WindowTabs({
  items,
  value,
  onValueChange,
}: {
  items: readonly WindowTab[];
  value: string | null;
  onValueChange: (id: string) => void;
}) {
  return (
    <WorkbenchTabs
      items={items.map((item) => ({
        id: item.id,
        name: `${item.name}${item.zoomed ? " · Zoomed" : ""}`,
        command: item.command,
        count: item.paneCount,
      }))}
      value={value ?? ""}
      onSelect={onValueChange}
    />
  );
}
