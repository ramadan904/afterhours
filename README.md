# Afterhours

**Your tokenized stocks, by voice, at any hour.** An Alexa+ add-on, built as a self-hosted MCP server.

The US stock market is open about 33 hours a week. Tokenized stocks (xStocks on Solana) trade all 168. So the moment
most people actually have time to think about their money (Saturday morning, 11pm on a weeknight) is exactly when
nobody can tell them what's going on. Afterhours closes that gap with Alexa:

> **"Alexa, what happened overnight?"**
> "The US stock market is closed for the weekend. It opens Monday at 9:30 a.m. Eastern. Biggest moves since Friday's
> close: Coinbase up 3.9 percent, Strategy up 3.0 percent and Tesla up 2.1 percent. Your Coinbase alert at 3 percent
> has triggered."

> **"Is the Tesla token trading rich?"**
> "Tesla's token is up 2.1 percent since Friday's close, at $370.56. With the share market shut, that's a bet on the
> open Monday, not a hedge."

> **"Buy 25 dollars of Apple."**
> "A buy of $25 of Apple at about $330.05 is ready for you to sign. Open afterhours dot app slash go and enter code
> 6 2 2 4 3 5. It expires in 15 minutes."

![The Afterhours Alexa+ simulator: an overnight briefing with the MCP call trace](media/simulator.png)

**Voice proposes, wallet disposes.** Alexa can *propose* a trade, but it can never execute one. Afterhours holds no
keys. A trade only happens when you open the confirm page, see a fresh quote, and sign it in your own wallet. A misheard
"fifty", or a TV talking in the background, can't move money.

## What's in the box

| | |
| --- | --- |
| **MCP server** | `POST /mcp`: Streamable HTTP, MCP **2025-11-25**, stateless, JSON responses. 10 tools, each with an `outputSchema` and truthful `readOnlyHint` / `destructiveHint` annotations. |
| **Account linking** | OAuth 2.1 authorization code + **PKCE (S256)**. RFC 9728 protected-resource metadata, RFC 8414 server metadata, `resource` bound to the MCP URI, rotating refresh tokens, and a bare `401` for unauthenticated MCP calls, all as Alexa+'s MCP onboarding asks. You link a **Solana wallet by signing a message** (free, can't move funds), or link a watch-only address. |
| **Live data** | Token and share prices from Jupiter (one keyless call returns both legs), balances from Solana mainnet RPC. Prices are served from a stale-while-revalidate cache, so tool calls stay well inside Alexa+'s **500 ms** budget. |
| **Trade confirm page** | `/go`: enter the code, get a fresh Jupiter quote, sign in any Wallet Standard wallet (Phantom, Solflare, Backpack, and others). Afterhours only reports a trade as confirmed once Solana shows it succeeded **and the linked wallet paid for it**. Status flows back to Alexa ("did my trade go through?"). |
| **Overnight tape** | The board is sampled every 5 minutes into a rolling 48-hour tape, and every account's alerts are checked on each sample. Briefings say *when* an alert went off ("went off at 2:14 a.m. Eastern, when it was up 2.3 percent"), and `check_stock` tells the night's story ("since Friday's close it peaked at up 5.6 percent on Saturday around 10:30 a.m., and has faded since"). |
| **Cards for screens** | The brief, stock, portfolio and trade tools declare **MCP Apps** `ui://` cards, so hosts with a screen (Echo Show, Fire TV, any MCP Apps client) show a visual card next to the spoken answer. These are dependency-free HTML views that follow the host's theme; the trade card has the code, a QR and a "Review and sign" link. |
| **Alexa+ simulator** | `/sim/`: Alexa+'s MCP client is partner-gated, so this page plays its part. It runs the real OAuth flow, then voice in, voice out, with a live trace of every MCP call and its latency. The planner is **Claude on Amazon Bedrock** when AWS credentials are present, otherwise a deterministic intent matcher. |
| **Conformance check** | `npm run conformance -- <url>` checks a deployment against the Alexa+ requirements and measures p50/p95 latency over the network. |

### Tools

| Tool | Ask it | Annotations |
| --- | --- | --- |
| `market_status` | "Is the market open?" | read-only |
| `overnight_brief` | "What happened overnight?", "Anything I should know?" | read-only |
| `check_stock` | "How's Tesla doing?", "Is the Nvidia token trading rich?" | read-only |
| `my_portfolio` | "How's my portfolio?" | read-only |
| `set_alert` | "Tell me if Coinbase moves more than 3 percent", "Tell me if Nvidia goes above 250" | write, idempotent |
| `list_alerts` | "What alerts do I have?" | read-only |
| `remove_alert` | "Stop my Tesla alert" | **destructive**, idempotent |
| `propose_trade` | "Buy 25 dollars of Apple" | write, *not* destructive: proposes only, never executes |
| `trade_status` | "Did my trade go through?" | read-only |
| `explain` | "What's a tokenized stock?", "Why is the token different from the stock?", "Is this safe?" | read-only |

Every result's text is written for the ear: it leads with the answer, rounds to what a listener can hold, and says
"percent" rather than "bps". Every gap is labelled with the session it was taken in. A 2% gap on a Tuesday afternoon is
a live, hedgeable dislocation, while the same 2% on a Sunday is a bet on Monday's open, and Afterhours says so.

## Run it

```bash
npm install
AFTERHOURS_DATA=sample npm run dev     # offline: sample board + sample portfolio
# open http://localhost:8787/sim/ → Link account → "Use the sample portfolio" → ask away
```

Live data path with no network (fake Jupiter + Solana RPC, any wallet "holds" a small portfolio):

```bash
npx tsx scripts/fake-upstreams.ts 9900 &
JUPITER_ENDPOINT=http://localhost:9900 SOLANA_RPC_URL=http://localhost:9900 npm run dev
```

With live mainnet data:

```bash
cp .env.example .env    # set AUTH_SECRET at minimum
npm run dev
```

Tests (123, no network needed): `npm test`. They cover the OAuth flow, every tool, the MCP Apps cards, the overnight tape, the live Jupiter/Solana path against faithful fakes, the on-chain payer check, the security fixes, and a compile check of every inline script. Conformance against any deployment: `npm run conformance -- https://your-host`.

### Connect it to an MCP client

- **Endpoint:** `https://<host>/mcp` (Streamable HTTP)
- **Auth:** OAuth discovery from `https://<host>/.well-known/oauth-protected-resource`
- **MCP Inspector / quick testing:** `AUTH_SECRET=... PUBLIC_URL=https://<host> npm run token -- <wallet>` mints a 1-hour bearer token.
- **Alexa+:** every value the console asks for is in [docs/ALEXA.md](docs/ALEXA.md).

## Deploy

**Fastest: Render.** [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ramadan904/afterhours)
The blueprint (`render.yaml`) builds the Docker image, generates `AUTH_SECRET`, runs in Virginia (close to Alexa), and
uses Render's HTTPS URL as the public URL. It's a long-running service, so the overnight tape samples on its own
timer. (Render's free plan sleeps when idle, which breaks the 500 ms budget on the first call and pauses the tape; use
Starter or above for judging.)

**AWS (App Runner + DynamoDB + EventBridge + Bedrock).** One command builds the image, pushes it to ECR and deploys
`infra/aws.yaml`:

```bash
AWS_REGION=us-east-1 ./scripts/deploy-aws.sh
```

The stack runs the server on App Runner and keeps state in DynamoDB (TTL-enabled). Signing and cron secrets are
generated in Secrets Manager. EventBridge samples the overnight tape every 5 minutes, because App Runner throttles CPU
between requests, so an in-process timer isn't reliable there. The instance role grants Claude on Amazon Bedrock for
the simulator's planner; enable model access for your chosen model in the Bedrock console first. Then follow
[docs/ALEXA.md](docs/ALEXA.md) to connect Alexa+.

**Docker anywhere.** A long-running process keeps the price cache warm.

```bash
docker build -t afterhours .
docker run -p 8080:8080 -e PUBLIC_URL=https://... -e AUTH_SECRET=... afterhours
```

**Vercel.** `vercel deploy` works as is (`api/index.ts` + `vercel.json`). Add an Upstash Redis integration so OAuth
codes, alerts, the tape and trade proposals are shared across function instances. Serverless has no timer for the
overnight tape: set `CRON_SECRET`, then add repository secrets `AFTERHOURS_URL` and `CRON_SECRET` so the included
`Overnight tape` GitHub Actions workflow calls `/api/cron/tape` every 5 minutes.

## How it fits together

```
 Alexa+ / simulator ──OAuth 2.1+PKCE──▶ /authorize ── wallet signs message ──▶ /token
        │                                                                     (JWT, aud=/mcp)
        └──Bearer──▶ /mcp  (Streamable HTTP, stateless)
                      ├─ prices ◀── cache (SWR, 10s) ◀── Jupiter price/v3 (token + share)
                      ├─ holdings ◀── Solana RPC getTokenAccountsByOwner (Token-2022)
                      ├─ alerts, proposals ◀── store (memory | Upstash)
                      └─ propose_trade ──▶ code ──▶ /go ── Jupiter quote+swap ──▶ user's wallet signs
```

- `src/market/`: universe and voice aliases, NYSE calendar and sessions, gap logic, speech phrasing, price sources and cache
- `src/mcp/tools.ts`: the 10 tools · `src/mcp/apps.ts`: MCP Apps cards
- `src/market/tape.ts`: the overnight tape · `src/market/alerts.ts`: alerts that fire with timestamps
- `src/auth/`: OAuth 2.1 server, signed tokens, wallet signature verification
- `src/chain/`: Solana balances, trade proposals, Jupiter swap client
- `src/store/`: state in memory, Upstash Redis, or DynamoDB (one contract test suite for all three)
- `infra/aws.yaml`, `scripts/deploy-aws.sh`: the AWS stack
- `src/http/`: router, pages (link, confirm, landing), simulator, trade API
- `src/sim/planner.ts`: Bedrock (Claude) and scripted planners (with follow-ups like "what about Nvidia?"), MCP client

Recording the demo? See [DEMO.md](DEMO.md) for a timed script.

## Security

Afterhours holds no keys and can't sign. See [SECURITY.md](SECURITY.md) for the threat model.

## Honest limits

- **Not tested inside real Alexa+.** Its MCP client isn't available to hackathon participants. The server follows the
  published onboarding requirements, and the simulator exercises the same OAuth and MCP paths.
- **The noise floor is an assumption.** Jupiter publishes no confidence interval, so gaps under 0.2% are reported as
  "in line". That threshold is a deliberately wide guess, not a measurement.
- **Not investment advice.** Afterhours reports prices and gaps; it does not recommend trades.

## License

MIT. See [LICENSE](LICENSE).
