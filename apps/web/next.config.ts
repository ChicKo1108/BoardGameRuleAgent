import type { NextConfig } from "next";
const config: NextConfig = {
  transpilePackages:["@boardgame/contracts","@boardgame/db","@boardgame/backend"],
  serverExternalPackages:["typeorm","pg"],
};
export default config;
