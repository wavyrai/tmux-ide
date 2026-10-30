import { API_CATALOG_PATH, LINKSET_TYPE, apiCatalog, jsonResponse } from "../discovery";
import { absoluteUrl } from "@/lib/site";

export const revalidate = false;

// RFC 9727 §2: GET and HEAD both carry a Link header with the api-catalog
// relation. The route is prerendered, so HEAD is served from this response.
const link = { Link: `<${absoluteUrl(API_CATALOG_PATH)}>; rel="api-catalog"` };

export function GET() {
  return jsonResponse(apiCatalog(), LINKSET_TYPE, link);
}
