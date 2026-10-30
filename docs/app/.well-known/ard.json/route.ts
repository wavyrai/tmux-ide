import { ardManifest, jsonResponse } from "../discovery";

export const revalidate = false;

export function GET() {
  return jsonResponse(ardManifest(), "application/json; charset=utf-8");
}
