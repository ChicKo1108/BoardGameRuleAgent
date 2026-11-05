import { handleWechat } from "@boardgame/backend";
import { getWechat } from "../../../../../server/wechat";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => handleWechat(request, getWechat);
