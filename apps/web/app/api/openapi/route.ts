import { publicSessionOpenApi } from "@boardgame/backend";
export function GET() {
  return Response.json(publicSessionOpenApi(), {
    headers: { "cache-control": "no-store" },
  });
}
