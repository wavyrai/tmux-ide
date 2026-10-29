import { API_CATALOG_PATH, LINKSET_TYPE, apiCatalog, jsonResponse } from "../discovery";
import { absoluteUrl } from "@/lib/site";

export const revalidate = false;

// RFC 9727 §2: GET and HEAD both carry a Link header with the api-catalog relation.
const link = { Link: `<${absoluteUrl(API_CATALOG_PATH)}>; rel="api-catalog"` };

export function GET() {
  return jsonResponse(apiCatalog(), LINKSET_TYPE, link);
}

export function HEAD() {
  return new Response(null, { headers: { "Content-Type": LINKSET_TYPE, ...link } });
}
