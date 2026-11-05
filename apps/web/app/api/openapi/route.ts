import {
  publicSessionOpenApi,
  publicConversationPaths,
  wechatOpenApiPaths,
} from "@boardgame/backend";
export function GET() {
  const spec = publicSessionOpenApi();
  return Response.json(
    {
      ...spec,
      paths: {
        ...spec.paths,
        ...publicConversationPaths(),
        ...wechatOpenApiPaths(),
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
