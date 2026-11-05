import {
  publicSessionOpenApi,
  publicConversationPaths,
} from "@boardgame/backend";
export function GET() {
  const spec = publicSessionOpenApi();
  return Response.json(
    { ...spec, paths: { ...spec.paths, ...publicConversationPaths() } },
    { headers: { "cache-control": "no-store" } },
  );
}
