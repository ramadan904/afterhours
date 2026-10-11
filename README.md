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
| **MCP server** | `POST /mcp`: Streamable HTTP, MCP **2025-11-25**, stateless, JSON responses. 9 tools, each with an `outputSchema` and truthful `readOnlyHint` / `destructiveHint` annotations. |
| **Account linking** | OAuth 2.1 authorization code + **PKCE (S256)**. RFC 9728 protected-resource metadata, RFC 8414 server metadata, `resource` bound to the MCP URI, rotating refresh tokens, and a bare `401` for unauthenticated MCP calls, all as Alexa+'s MCP onboarding asks. You link a **Solana wallet by signing a message** (free, can't move funds), or link a watch-only address. |
| **Live data** | Token and share prices from Jupiter (one keyless call returns both legs), balances from Solana mainnet RPC. Prices are served from a stale-while-revalidate cache, so tool calls stay well inside Alexa+'s **500 ms** budget. |
| **Trade confirm page** | `/go`: enter the code, get a fresh Jupiter quote, sign in Phantom, Solflare or Backpack. Status flows back to Alexa ("did my trade go through?"). |
| **Alexa+ simulator** | `/sim/`: Alexa+'s MCP client is partner-gated, so this page plays its part. It runs the real OAuth flow, then voice in, voice out, with a live trace of every MCP call and its latency. The planner is **Claude on Amazon Bedrock** when AWS credentials are present, otherwise a deterministic intent matcher. |
| **Conformance check** | `npm run conformance -- <url>` checks a deployment against the Alexa+ requirements and measures p50/p95 latency over the network. |

### Tools

| Tool | Ask it | Annotations |
| --- | --- | --- |
| `market_status` | "Is the market open?" | read-only |
| `overnight_brief` | "What happened overnight?", "Anything I should know?" | read-only |
| `check_stock` | "How's Tesla doing?", "Is the Nvidia token trading rich?" | read-only |
| `my_portfolio` | "How's my portfolio?" | read-only |
| `set_alert` | "Tell me if Coinbase moves more than 3 percent" | write, idempotent |
| `list_alerts` | "What alerts do I have?" | read-only |
| `remove_alert` | "Stop my Tesla alert" | **destructive**, idempotent |
| `propose_trade` | "Buy 25 dollars of Apple" | write, *not* destructive: proposes only, never executes |
| `trade_status` | "Did my trade go through?" | read-only |

Every result's text is written for the ear: it leads with the answer, rounds to what a listener can hold, and says
"percent" rather than "bps". Every gap is labelled with the session it was taken in. A 2% gap on a Tuesday afternoon is
a live, hedgeable dislocation, while the same 2% on a Sunday is a bet on Monday's open, and Afterhours says so.

## Run it

```bash
npm install
AFTERHOURS_DATA=sample npm run dev     # offline: sample board + sample portfolio
# open http://localhost:8787/sim/ → Link account → "Use the sample portfolio" → ask away
```

With live mainnet data:

```bash
cp .env.example .env    # set AUTH_SECRET at minimum
npm run dev
```

Tests (60, no network needed): `npm test`. Conformance against any deployment: `npm run conformance -- https://your-host`.

### Connect it to an MCP client

- **Endpoint:** `https://<host>/mcp` (Streamable HTTP)
- **Auth:** OAuth discovery from `https://<host>/.well-known/oauth-protected-resource`
- **MCP Inspector / quick testing:** `AUTH_SECRET=... PUBLIC_URL=https://<host> npm run token -- <wallet>` mints a 1-hour bearer token.
- **Alexa+:** register the add-on's client ID, secret and redirect URLs as `ALEXA_CLIENT_ID`, `ALEXA_CLIENT_SECRET`, `ALEXA_REDIRECT_URIS`.

## Deploy

**Docker / AWS App Runner (recommended for latency).** A long-running process keeps the price cache warm.

```bash
docker build -t afterhours .
docker run -p 8080:8080 -e PUBLIC_URL=https://... -e AUTH_SECRET=... afterhours
```

On App Runner: push the image to ECR, create a service on port 8080 in `us-east-1` (close to Alexa), and set the env
vars above. Give the instance role `bedrock:InvokeModel` if you want the simulator to use the Bedrock planner.

**Vercel.** `vercel deploy` works as is (`api/index.ts` + `vercel.json`). Add an Upstash Redis integration so OAuth
codes, alerts and trade proposals are shared across function instances.

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
- `src/mcp/tools.ts`: the 9 tools
- `src/auth/`: OAuth 2.1 server, signed tokens, wallet signature verification
- `src/chain/`: Solana balances, trade proposals, Jupiter swap client
- `src/http/`: router, pages (link, confirm, landing), simulator, trade API
- `src/sim/planner.ts`: Bedrock (Claude) and scripted planners, MCP client

## Honest limits

- **Not tested inside real Alexa+.** Its MCP client isn't available to hackathon participants. The server follows the
  published onboarding requirements, and the simulator exercises the same OAuth and MCP paths.
- **The noise floor is an assumption.** Jupiter publishes no confidence interval, so gaps under 0.2% are reported as
  "in line". That threshold is a deliberately wide guess, not a measurement.
- **Not investment advice.** Afterhours reports prices and gaps; it does not recommend trades.

## License

MIT. See [LICENSE](LICENSE).
