import { schemaMap } from "@/lib/structured-data";

export const revalidate = false;

export function GET() {
  return new Response(schemaMap(), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
