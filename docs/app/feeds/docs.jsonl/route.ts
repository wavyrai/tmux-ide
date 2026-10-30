import { JSONL_TYPE, docsSchemaFeed } from "@/lib/structured-data";

export const revalidate = false;

export function GET() {
  return new Response(docsSchemaFeed(), {
    headers: { "Content-Type": `${JSONL_TYPE}; charset=utf-8` },
  });
}
