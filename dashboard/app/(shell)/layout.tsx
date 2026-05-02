import { Sidebar } from "@/components/Sidebar";
import { TerminalPool } from "@/components/TerminalPool";

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[calc(100vh-1.5rem)] min-h-0">
      <Sidebar />
      <div className="relative flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
        {children}
        <TerminalPool />
      </div>
    </div>
  );
}
