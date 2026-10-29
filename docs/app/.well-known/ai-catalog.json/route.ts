import { AI_CATALOG_TYPE, aiCatalog, jsonResponse } from "../discovery";

export const revalidate = false;

export function GET() {
  return jsonResponse(aiCatalog(), `${AI_CATALOG_TYPE}; charset=utf-8`);
}
