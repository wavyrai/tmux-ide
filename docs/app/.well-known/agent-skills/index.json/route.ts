import { agentSkillsIndex, jsonResponse } from "../../discovery";

export const revalidate = false;

export function GET() {
  return jsonResponse(agentSkillsIndex(), "application/json; charset=utf-8");
}
