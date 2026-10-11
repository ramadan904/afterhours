# Afterhours: submission for Build, Ship, Shape (Amazon Developer Hackathon)

Ready to paste into Devpost. Items marked **TODO** depend on things only the team can do (deploy, record).

- **Primary track:** Alexa+ (self-hosted MCP server, spec 2025-11-25, Streamable HTTP)
- **Mini-challenges:** Open Source (new MIT-licensed repo) · AWS Builder (Amazon Bedrock planner; App Runner deploy)
- **Repo:** https://github.com/ramadan904/afterhours
- **Live endpoint:** **TODO** `https://<host>/mcp` · simulator at `https://<host>/sim/`
- **Demo video (<3 min):** **TODO**

---

## Tagline

Your tokenized stocks, by voice, at any hour. Alexa proposes, your wallet signs.

## What it does

The US stock market is open about 33 hours a week. Tokenized stocks trade all 168. Saturday morning or 11pm on a
weeknight, when people actually have time to think about their money, the share market is shut, but its tokenized
twin is still moving, and nobody can tell you what it means.

Afterhours is an Alexa+ add-on for that gap. Ask *"what happened overnight?"* and Alexa tells you whether the market is
open, when it opens next, and which tokenized stocks moved most since the last close, leading with any alert you set.
Ask about one name and it tells you where the token is, how far it has moved from its real share, and what that gap
*is*: a hedgeable dislocation when both markets are trading, or just a bet on the next open when they aren't.
Link your Solana wallet and it reads your portfolio and how much it has moved overnight.

And you can say *"buy 25 dollars of Apple."* Alexa won't do it. It prepares the trade and reads you a six-digit code.
You open the confirm page, see a fresh quote, and sign it in your own wallet. Afterhours holds no keys. A misheard
amount, or a TV talking in the background, can't move money. **Voice proposes, wallet disposes.**

## How it works

- **MCP server** (TypeScript, official MCP SDK): stateless Streamable HTTP on `/mcp`, protocol 2025-11-25, nine tools
  with `outputSchema`s and truthful annotations (reads are `readOnlyHint`, removing an alert is `destructiveHint`, and
  proposing a trade is explicitly *not* destructive because it moves nothing). Each result carries a sentence written
  to be spoken plus structured data for a screen.
- **Account linking** exactly as Alexa+'s MCP onboarding asks: OAuth 2.1 authorization code + PKCE (S256 only), RFC 9728
  protected-resource metadata, `resource` bound to the MCP URI, pre-registered clients (no DCR), rotating refresh
  tokens, and a bare 401 for unauthenticated calls. Identity is a Solana wallet, proven by signing a plain-text message
  bound to the request's nonce. Signing is free and can't move funds.
- **Inside 500 ms:** Alexa+ requires MCP round trips under 500 ms. One keyless Jupiter call returns both legs (token
  price *and* the share's last print), behind a stale-while-revalidate cache. Access tokens are self-contained JWTs, so
  authenticating a request is one HMAC with no database read. Measured locally: `tools/call` p95 under 10 ms; the
  conformance script measures it over the network against any deployment.
- **Market-aware language:** an NYSE calendar (holidays, half days, DST) labels every reading with its session, and
  names the reference the way a person would ("since Friday's close", "against the live share price").
- **Trades:** proposals live 15 minutes, are capped at $500 by voice, and are checked against holdings for sells. The
  confirm page builds a Jupiter swap for the *linked* wallet only, and the user's wallet signs and sends it through the
  Wallet Standard (no Solana library or CDN script on the page). A trade is reported confirmed only after Solana shows
  it succeeded *and* the linked wallet paid for it, so a reported signature alone proves nothing.
- **Alexa+ simulator:** Alexa+'s MCP client is partner-gated, so `/sim/` stands in for it. It runs the real OAuth
  flow, sends speech (Web Speech API) to a planner, calls the MCP endpoint with the linked token, and speaks the
  reply, showing every tool call with its latency. The planner is **Claude on Amazon Bedrock** (tools taken from the
  server's own `tools/list`), with a deterministic fallback so the demo runs with no credentials.

## What we built during the hackathon

Everything in this repo is new for this hackathon. One module is reused from the author's earlier project
[Kolu](https://github.com/ramadan904/kolu) (started 2026-09-21, also inside the submission window): the NYSE
calendar/session classifier (`src/market/calendar.ts`, `session.ts`), copied in unchanged. The xStock mint list was
verified in Kolu's pipeline. The MCP server, OAuth/wallet linking, tools, speech layer, trade proposals, confirm
page, simulator, Bedrock planner, conformance script and tests were all written here.

## AWS Builder

- **Amazon Bedrock:** the simulator's planner runs Claude (`anthropic.claude-opus-5-5`) on Bedrock through the
  Anthropic Bedrock SDK (`AnthropicBedrockMantle`), turning the MCP server's `tools/list` into Bedrock tool definitions
  and running the tool loop (`src/sim/planner.ts`). It has a client-side refusal fallback and falls back to the scripted
  planner if Bedrock is unavailable, so the demo never dies on stage.
- **AWS App Runner:** documented container deploy in `us-east-1`; the instance role grants `bedrock:InvokeModel`.
- **TODO before submitting:** run the simulator once with AWS credentials and record the Bedrock trace in the video.

## Open Source

New public repository, MIT license: https://github.com/ramadan904/afterhours (GitHub: `ramadan904`). Includes tests
(`npm test`), CI that runs the server against live mainnet data plus the conformance checks, and a reusable Alexa+
MCP conformance script any add-on developer can point at their own server.

## Product feedback

**MCP TypeScript SDK.** `WebStandardStreamableHTTPServerTransport` in stateless JSON mode was the right fit: one
`(Request) => Response` handler runs unchanged on Node, Vercel and Lambda. `registerTool` with zod `outputSchema` gave
validated `structuredContent` for free. Friction: the stateless pattern (new server per request) isn't the documented
default, and annotation semantics for "writes but isn't destructive" took reading the spec.

**Alexa+ MCP documentation.** The QuickStart's auth checklist (RFC 9728, S256, `resource`, no DCR) was precise and
easy to build to. What we missed: a way for non-partners to test against the real Alexa+ client, guidance on how
Alexa+ uses `content` vs `structuredContent` (does it read our sentence, or rephrase the data?), and whether results
can render on Echo Show screens. See [FRICTION.md](FRICTION.md).

**Amazon Bedrock.** **TODO:** fill in after running the planner with credentials (setup, model access, latency).

**Would we use it again?** Yes. An MCP server is a far smaller surface than a classic skill, and the same server
already works with any MCP client.
