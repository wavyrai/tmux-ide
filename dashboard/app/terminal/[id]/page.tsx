import { Terminal } from "@/components/Terminal";

export function generateStaticParams() {
  return [{ id: "default" }];
}

export default async function TerminalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="h-[calc(100vh-1.5rem)] min-h-[420px] flex flex-col">
      <Terminal id={id} />
    </main>
  );
}
