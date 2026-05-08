import type { NextConfig } from "next";
import { existsSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

// `.capy/next-env.js` is emitted by `capy run` before spawning the child when
// SECRETS_BLOB + PROJECT_KEY are present (deploy-mode build-time inlining).
// For local builds without those vars, the plugin test pre-emits this file
// from a plaintext .env so the build path is identical.
const envPath = join(__dirname, ".capy", "next-env.js");
const req = createRequire(import.meta.url);
const capyEnv: Record<string, string | undefined> = existsSync(envPath)
  ? req(envPath)
  : {};

const nextConfig: NextConfig = {
  env: capyEnv as Record<string, string>,
};

export default nextConfig;
