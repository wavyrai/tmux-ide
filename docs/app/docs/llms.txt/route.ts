import { docsLlmsIndex } from "@/lib/llms";

export const revalidate = false;

export function GET() {
  return new Response(docsLlmsIndex(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
