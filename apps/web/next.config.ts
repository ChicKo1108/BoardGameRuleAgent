import type { NextConfig } from "next";
const config: NextConfig = {
  transpilePackages: [
    "@boardgame/contracts",
    "@boardgame/db",
    "@boardgame/backend",
    "@boardgame/retrieval",
    "@boardgame/evaluations",
    "@boardgame/agent",
  ],
  serverExternalPackages: [
    "typeorm",
    "pg",
    "pg-boss",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
  ],
};
export default config;
