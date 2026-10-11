/**
 * Mints an access token for testing with the MCP Inspector or the conformance
 * script, signed with this deployment's AUTH_SECRET.
 *
 *   AUTH_SECRET=... PUBLIC_URL=https://your-host npm run token -- <wallet-address>
 */

import { sign } from "../src/auth/tokens.js";

const base = (process.env.PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, "");
const secret = process.env.AUTH_SECRET ?? "afterhours-dev-secret-do-not-use-in-production";
const wallet = process.argv[2] ?? null;

console.log(
  sign(
    { iss: base, aud: `${base}/mcp`, sub: wallet ? `watch:${wallet}` : "tester", wallet, verified: false, scope: "market portfolio trade", client_id: "cli" },
    secret,
    3600,
  ),
);
