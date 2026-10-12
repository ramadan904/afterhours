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

### Built for the 2 a.m. investor

The hours Afterhours exists for are the hours people make their worst decisions. So it does what no broker app does
by voice:

- **Guardrails you set for your future self.** A daily spending limit that applies at once when lowered but waits
  24 hours to be raised. **Sleep mode**: a trade asked for at 2 a.m. isn't prepared; it unlocks at 7 and arrives
  on your phone as "Slept on it? Your Tesla buy is ready." A **spoken trade PIN**, like Alexa's voice purchasing
  code, so the TV can't propose trades. And a **concentration check** before you sign ("After this, Tesla would be
  46 percent of your tokenized stocks").
- **Honesty about the market you're in.** "How deep is the Tesla market?" answers with real Jupiter quotes at $100,
  $1k and $10k, and a large weekend order is warned before signing. "Is it Tesla or the market?" splits a move with
  30-day betas. And at 9:35 a.m. **the open is scored**: "Tesla opened +1.9%. Its token had called +2.1%."
- **Your money, read from the chain.** "How much have I made on Nvidia?" rebuilds your cost basis from your wallet's
  own Solana history (each xStock change paired with the USDC that moved), and the companion app exports it as a
  CSV for tax time. **Wallet watch** pushes within 5 minutes if tokens leave your wallet without a trade Afterhours
  prepared.
- **Investing without custody.** "Buy $25 of the S&P every Monday" sends a one-tap proposal to your phone each week;
  your wallet still signs every one. "Keep me 60/40" plans a **self-funding rebalance** and prepares it only when you
  say so. Every proposal is also a **Solana Action** (blink), and the confirm page shows a Solana Pay QR to sign on
  your phone; Afterhours finds the landed transaction on chain by fee payer and blockhash, so nothing has to report
  back.
- **68 stocks and funds**, every mint verified in CI; a watchlist the briefing leads with; a briefing and a weekly
  recap pushed at times you choose, in your own time zone; and the overnight chart as sound for screen-reader users.

## How it works

- **MCP server** (TypeScript, official MCP SDK): stateless Streamable HTTP on `/mcp`, protocol 2025-11-25, 28 tools
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
- **Track record, from real data:** for every market open in the last month, Afterhours compares where the token
  traded at 9 a.m. Eastern (GeckoTerminal pool candles) with where the share actually opened (Yahoo bars). First real
  run, in CI on 2026-10-11: **Tesla, 20 opens, 18 meaningful overnight moves, and the share opened the same way all
  18 times, with a median miss of 0.41%.** So "its token has called the open's direction 18 of the last 18 times" is
  a measured statement, not a slogan.
- **Overnight tape:** the board is sampled every 5 minutes; alerts are checked on every sample and stamped when they
  first cross, so the morning briefing can say "your Tesla alert went off at 2:14 a.m." even if the move has faded,
  and a stock check tells the night's story (peak, when, and whether it faded).
- **Cards for screens (MCP Apps):** the visual tools declare `ui://` cards (`text/html;profile=mcp-app`), so Echo Show
  or any MCP Apps host can show a card beside the spoken answer. The trade card carries the code, a QR and a
  "Review and sign" link.
- **Alexa+ simulator:** Alexa+'s MCP client is partner-gated, so `/sim/` stands in for it. It runs the real OAuth
  flow, sends speech (Web Speech API) to a planner, calls the MCP endpoint with the linked token, and speaks the
  reply, showing every tool call with its latency. The planner is **Claude on Amazon Bedrock** (tools taken from the
  server's own `tools/list`), with a deterministic fallback so the demo runs with no credentials.

## What we built during the hackathon

Everything in this repo is new for this hackathon. One module is reused from the author's earlier project
[Kolu](https://github.com/ramadan904/kolu) (started 2026-09-21, also inside the submission window): the NYSE
calendar/session classifier (`src/market/calendar.ts`, `session.ts`), copied in unchanged. The 12 core xStock mints were
verified in Kolu's pipeline; the other 56 were discovered and verified here, in CI (`discover-universe.yml`). The MCP server, OAuth/wallet linking, tools, speech layer, trade proposals, confirm
page, simulator, Bedrock planner, conformance script and tests were all written here.

## AWS Builder

Afterhours deploys to AWS with one command (`scripts/deploy-aws.sh` → `infra/aws.yaml`, linted with cfn-lint in CI):

- **AWS App Runner** runs the MCP server from an ECR image in `us-east-1`, close to Alexa.
- **Amazon DynamoDB** holds the state (OAuth codes, refresh tokens, alerts, the overnight tape, trade proposals), with
  TTL for one-time values. `src/store/dynamo.ts` passes the same contract tests as the in-memory and Redis stores.
- **AWS Secrets Manager** generates the token-signing key and the cron secret; neither is ever typed or committed.
- **Amazon EventBridge** (API destination on a 5-minute rule) samples the overnight tape and checks alerts while
  everyone sleeps.
- **Amazon Bedrock:** the simulator's planner runs Claude (`anthropic.claude-opus-5-5`) through the Anthropic Bedrock
  SDK (`AnthropicBedrockMantle`). It turns the MCP server's `tools/list` into tool definitions and runs the tool loop
  (`src/sim/planner.ts`). It has a client-side refusal fallback and drops back to the scripted planner if Bedrock is
  unavailable. The loop is tested against a scripted stand-in for Claude (`test/planner.test.ts`).
- **Amazon CloudWatch:** the server publishes raw per-tool latencies (true p95s, not averages) and counters for tape
  samples, alerts fired, pushes sent and trades confirmed (`src/obs/metrics.ts`). The stack draws a dashboard against
  the 500 ms budget and alarms, through **Amazon SNS**, when p95 passes 400 ms or the tape sampler goes quiet for 15
  minutes (which would mean alerts, briefings and settlement have stopped).
- **Amazon Polly:** the simulator speaks each reply with a Polly voice (generative engine, neural as fallback; `Ruth`
  by default), so the demo sounds the same on any laptop; the browser's own voice is the fallback (`src/sim/voice.ts`).
- **Measured planner:** `scripts/eval-planner.ts --bedrock` scores Claude on Bedrock on 171 utterances (139 + 32
  held out) by tool and arguments; a CI job runs it through GitHub OIDC when an AWS role is configured. The scripted
  fallback scores 99% on what it was tuned on and 50% held out, which is the case for Bedrock in one number.
- **TODO before submitting:** deploy the stack, enable Bedrock model access, run the Bedrock eval, and capture a
  `planner: bedrock` trace.

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
