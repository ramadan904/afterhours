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
| **MCP server** | `POST /mcp`: Streamable HTTP, MCP **2025-11-25**, stateless, JSON responses. 18 tools, each with an `outputSchema` and truthful `readOnlyHint` / `destructiveHint` annotations. |
| **Account linking** | OAuth 2.1 authorization code + **PKCE (S256)**. RFC 9728 protected-resource metadata, RFC 8414 server metadata, `resource` bound to the MCP URI, rotating refresh tokens, and a bare `401` for unauthenticated MCP calls, all as Alexa+'s MCP onboarding asks. You link a **Solana wallet by signing a message** (free, can't move funds), or link a watch-only address. |
| **68 stocks and funds** | Tesla to Coca-Cola, the S&P 500 to gold. Every mint is verified before it ships (exact registry symbol, Backed's `Xs` prefix, Token-2022 owner, matching decimals, exactly one candidate) by `scripts/discover-universe.ts` in CI. Each name answers to the ways it's said ("coke", "J P Morgan", "the Russell"). |
| **Live data** | Token and share prices from Jupiter (one keyless call returns both legs), balances from Solana mainnet RPC. Prices are served from a stale-while-revalidate cache, so tool calls stay well inside Alexa+'s **500 ms** budget. |
| **Trade confirm page** | `/go`: enter the code, get a fresh Jupiter quote, sign in any Wallet Standard wallet (Phantom, Solflare, Backpack, and others). Afterhours only reports a trade as confirmed once Solana shows it succeeded **and the linked wallet paid for it**. Status flows back to Alexa ("did my trade go through?"). |
| **Solana Actions** | Every proposal is also a [Solana Action](https://solana.com/docs/advanced/actions) (`/actions.json`, `/api/actions/trade/:code`): a blink client like Phantom or Backpack, or a phone wallet scanning the Solana Pay QR code on the confirm page, can fetch and sign it directly. The transaction is built only for the proposal's wallet, and a trade signed this way is found on chain (fee payer plus the blockhash we built it against) and confirmed by the 5-minute sampler, with a push to your phone. |
| **Overnight tape** | The board is sampled every 5 minutes into a rolling 48-hour tape, and every account's alerts are checked on each sample. Briefings say *when* an alert went off ("went off at 2:14 a.m. Eastern, when it was up 2.3 percent"), and `check_stock` tells the night's story ("since Friday's close it peaked at up 5.6 percent on Saturday around 10:30 a.m., and has faded since"). |
| **Impulse guard** | Rules you set for your 2 a.m. self. A **daily spending limit** ("don't let me spend more than 200 dollars a day") applies at once when set or lowered; raising or removing it waits **24 hours**, the way self-exclusion tools work. **Sleep mode** sets any trade asked for between 11 p.m. and 7 a.m. (your time) aside: it becomes signable at wake-up and is pushed to your phone as "Slept on it? Your Tesla buy is ready." |
| **Watchlist** | "Add Netflix and Palantir to my watchlist." With 68 names on the board, the briefing leads with the names you follow that actually moved ("On your watchlist: Palantir up 0.8 percent and Netflix up 0.5 percent"), then the rest of the market without repeating them. Editable by voice or in the companion app. |
| **Scheduled briefing** | "Brief me every weekday at 7." Sent as a push at that time in your own time zone (your portfolio's move, watched names that moved, the biggest movers), once a day, never stale: a briefing more than 15 minutes late waits for tomorrow. Set it by voice or in the companion app. |
| **Push notifications** | Alexa only speaks when spoken to, so when an alert fires at 2 a.m. Afterhours also sends a Web Push to every device the account turned on: "Tesla went above $400". |
| **Conditional trades** | "Buy 50 dollars of Tesla if it drops below 360." The order waits, armed, until the tape sees the price cross. Then it becomes a signable proposal with a fresh code, your phone is notified, and your wallet still has the last word. |
| **Companion app** | `/app` is an installable PWA and another MCP client of the same server. It shows your portfolio, the night's moves with a chart of each, alerts you can manage, your latest trade, and the switch for notifications on that device. |
| **Accessible** | The confirm page, companion app and simulator pass an axe-core WCAG 2 A/AA audit in light and dark themes, in CI on every push. |
| **Track record** | Is the overnight move worth anything? For every market open in the last month, Afterhours compares where the token traded at 9 a.m. with where the share actually opened, from public on-chain (GeckoTerminal) and exchange (Yahoo) history, refreshed daily. "Its token has called the open's direction 16 of the last 20 times." |
| **Your time zone** | "I'm in Lagos." Every time Afterhours speaks or sends is then local: "It opens tomorrow at 2:30 p.m. Lagos time." Most holders of tokenized US stocks don't live in New York. |
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
| `propose_trade` | "Buy 25 dollars of Apple", "Buy 50 dollars of Tesla if it drops below 360" | write, *not* destructive: proposes only, never executes |
| `cancel_trade` | "Cancel my order" | **destructive**, idempotent |
| `trade_status` | "Did my trade go through?" | read-only |
| `open_track_record` | "Does the weekend move usually hold for Tesla?" | read-only |
| `set_timezone` | "I'm in Lagos", "Use London time" | write, idempotent |
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

Tests (159, no network needed): `npm test`. They cover the OAuth flow, every tool, the MCP Apps cards, the overnight tape, the live Jupiter/Solana path against faithful fakes, the on-chain payer check, the Bedrock planner loop (against a scripted stand-in for Claude), one contract suite for the memory, Redis and DynamoDB stores, the security fixes, and a compile check of every inline script. CI also runs the server against live mainnet data, lints the AWS template and builds the Docker image. Conformance against any deployment: `npm run conformance -- https://your-host`.

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
- `src/mcp/tools.ts`: the 18 tools · `src/mcp/apps.ts`: MCP Apps cards
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
