# Friction log

Kept while building Afterhours (Alexa+ track). Each entry: what we tried, what got in the way, what would have helped.
Where we could only read a requirement second-hand (the docs site was unreachable from our build environment), we say so.

### 1. Required 401 shape conflicts with the MCP spec

- **Tried:** to follow both Alexa+'s MCP onboarding and MCP 2025-11-25 for unauthenticated requests.
- **Friction:** as we understand the Alexa+ MCP QuickStart, an unauthenticated request should get a 401 *without* a
  `WWW-Authenticate` header. MCP's authorization spec says the server MUST send `WWW-Authenticate` pointing at the
  protected-resource metadata, and generic MCP clients rely on it for discovery. One server can't satisfy both by
  default.
- **Workaround:** bare 401 by default; `WWW_AUTHENTICATE=on` restores the header for other clients.
- **Would help:** confirm whether the header is actually harmful to Alexa+ or merely ignored. If it's ignored, say so,
  so servers can stay spec-compliant for every client.

### 2. No way for non-partners to test against the real Alexa+ client

- **Tried:** to verify account linking and tool selection end to end.
- **Friction:** the MCP Toolkit isn't available to hackathon participants, so the most important integration (does
  Alexa pick the right tool, and how does it speak the result?) can't be tested at all.
- **Workaround:** built a simulator that runs the same OAuth and MCP paths, with Claude on Bedrock as the planner.
- **Would help:** a developer console "test chat" that connects to a self-hosted MCP URL, even text-only.

### 3. No guidance on voice output from tools

- **Friction:** we didn't know whether Alexa+ reads a tool's `content` text, rephrases its `structuredContent`, or
  both, or how long a spoken result should be. That decides how a voice-first tool should be written.
- **Workaround:** every tool returns one or two speakable sentences plus structured data.
- **Would help:** a short "writing tool results for voice" guide, and whether Echo Show can render structured results.
- **What we did for screens:** shipped MCP Apps `ui://` cards (the open MCP extension other hosts already render),
  since we couldn't find whether Alexa+ supports MCP Apps or has its own visual format. A one-line answer in the docs
  would decide this for every add-on.

### 4. Pre-registered clients only (no DCR / Client ID Metadata Documents)

- **Friction:** MCP 2025-11-25 recommends Client ID Metadata Documents, but Alexa+ (per the QuickStart) supports neither
  that nor DCR, so the server needs an out-of-band client registration step and a place to keep Alexa's redirect URLs.
- **Workaround:** clients come from environment variables.
- **Would help:** list the exact redirect URIs Alexa+ uses for MCP account linking on the QuickStart page.

### 5. The 500 ms budget versus real data sources

- **Friction:** a 500 ms round trip leaves no room for a cold upstream call (price API plus RPC can exceed it on their own).
  The requirement is clear, but there's no guidance on whether it's p50 or p95, measured from where, or what happens on
  a slow call (retry? timeout? spoken error?).
- **Workaround:** stale-while-revalidate price cache, self-contained JWTs (no DB read per request), a warm long-running
  process, and a conformance script that measures p50/p95 over the network.
- **Would help:** state the percentile and the measurement origin (e.g. us-east-1), and recommend a timeout behaviour.

### 6. Account linking assumes a username and password

- **Friction:** OAuth account linking assumes the user has an account with a password. Crypto users have a wallet
  instead. Nothing in the docs discusses wallet-based identity.
- **Workaround:** the authorize page asks the wallet to sign a plain-text message (Sign-In With Solana style) bound to
  the request's nonce, then issues a normal authorization code.
- **Would help:** an acknowledged pattern or sample for non-password identity in account linking.

### 7. No guidance on background work for MCP add-ons

- **Friction:** alerts are only useful if something watches the market while the user sleeps, but an MCP server only
  runs when Alexa calls it, and there's no Alexa+ way (that we found) for an add-on to schedule work or notify the
  user proactively.
- **Workaround:** a tape recorder on a timer (or a cron-called endpoint for serverless) stamps alerts when they fire,
  and the next briefing reports them with the time.
- **Would help:** proactive notifications for MCP add-ons, even a single "you have an update from Afterhours" chime.
