# Security model

Afterhours holds **no private keys and can't sign anything**. The worst a full compromise of the server can do is
show wrong numbers or propose a trade that the account holder would still have to read and sign in their own wallet.

## What's protected, and how

| Threat | Mitigation |
| --- | --- |
| A voice request (misheard, or a TV in the background) moves money | Tools can only *propose* a trade. Execution needs the linked wallet's own signature on the confirm page, after a fresh quote. Voice trades are capped (`MAX_TRADE_USD`, default $500) and sells are checked against holdings. |
| Someone links a wallet that isn't theirs | Linking requires a signature over a message bound to that link request's nonce, host and expiry (Sign-In With Solana style). Watch-only links are labelled unverified, and any trade they propose can still only be signed by that address's wallet. |
| A forged "trade confirmed" | A reported signature is never trusted: a trade is confirmed only when `getTransaction` shows it succeeded **and** the linked wallet was the fee payer. |
| Guessing a six-digit trade code | 60 lookups per client per 10 minutes, keyed on the proxy-appended address (spoofed `X-Forwarded-For` entries are ignored). A code reveals only a proposal; the transaction it builds is valid only for the linked wallet. Codes expire in 15 minutes. |
| Freezing someone's trade with a bogus signature | If a reported signature hasn't landed after 2 minutes, the trade returns to "awaiting signature". |
| Stolen authorization code | PKCE (S256 only), single-use codes (read-and-delete), 2-minute lifetime, redirect URI must match exactly. A failed PKCE check burns the code. |
| Stolen refresh token | Rotation: each refresh token works once. |
| Token for another server | Access tokens are bound to this server's MCP URI (`aud`) and issuer, HMAC-signed, 1-hour lifetime. |
| Open redirect / leaked codes | Unknown clients and unregistered redirect URIs get an error page, never a redirect. |
| Shared state between people | Every watch-only and sample link is its own account, so alerts and proposals never leak between people watching the same address. |
| XSS | Server-rendered values are escaped; client-rendered values go through an escaper or `textContent`. MCP Apps cards run in a sandboxed iframe (`allow-scripts` only) with a declared CSP. Pages send `X-Frame-Options: DENY`. |
| Running with a public dev key | Any HTTPS or production deployment refuses to start without a ≥32-character `AUTH_SECRET`, or with `AUTH=off`. |
| Cost abuse of the Bedrock planner | Simulator turns are rate-limited per client (30/minute), and utterances are truncated. |
| Oversized requests | The Node server rejects bodies over 1 MB with `413`. |
| Cron endpoint abuse | `/api/cron/tape` is disabled unless `CRON_SECRET` is set, and compares it in constant time. |

## Known limits

- Rate limits live in process memory, so on serverless each instance counts on its own. Put a platform limit (WAF,
  API Gateway) in front for a public launch.
- The signed link message is checked for its host, nonce and expiry, but the nonce isn't stored server-side; within its
  10-minute validity a captured form submission could be replayed for the same authorization request only.

## Reporting

Open a private security advisory on the GitHub repository.
