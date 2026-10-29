import { SERVER_CARD_TYPE, jsonResponse, serverCard } from "../../discovery";

export const revalidate = false;

export function GET() {
  return jsonResponse(serverCard(), `${SERVER_CARD_TYPE}; charset=utf-8`);
}
