import type { NextConfig } from "next";
const config: NextConfig = {
  transpilePackages: [
    "@boardgame/contracts",
    "@boardgame/db",
    "@boardgame/backend",
    "@boardgame/retrieval",
    "@boardgame/evaluations",
  ],
  serverExternalPackages: ["typeorm", "pg", "pg-boss"],
};
export default config;
