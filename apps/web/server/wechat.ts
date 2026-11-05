import {
  WechatLoginService,
  wechatProviderFromEnvironment,
} from "@boardgame/backend";
import { getDatabase } from "./database";
import { getSessions } from "./sessions";
export async function getWechat() {
  const provider = wechatProviderFromEnvironment();
  return new WechatLoginService(
    await getDatabase(),
    await getSessions(),
    provider,
  );
}
