# Demo video script (target 2:45, hard limit 3:00)

> **For judges without a wallet:** open `/sim/` on the live host and press **Try the guided demo**. It plays eight real
> turns in about 90 seconds (brief → gap verdict → thin-market honesty → token safety → a $25 buy with code and QR →
> sleep mode set around *now* → the next buy held → the 24-hour cooling-off), each a real MCP call with its latency
> shown. The demo account lasts 30 minutes, and its wallet is one no one holds the key to (or `DEMO_WALLET`, if set).

Record on the **deployed** server with **live data**, ideally on a Saturday, a Sunday or after 8pm ET, so the
"market closed, tokens still moving" story is happening for real. Use a real wallet (Phantom on your phone is ideal for
the signing shot). Turn on "Speak replies aloud" in the simulator so the replies are heard, not just read.

Screen layout: the simulator full-screen in a desktop browser; switch to a phone mirror for the signing shot.

| Time | On screen | Say (voice-over) |
| --- | --- | --- |
| 0:00 to 0:15 | Landing page, then the simulator | "The stock market is open about 33 hours a week. Tokenized stocks trade all 168. So at 11pm, or on a Sunday, when you actually have time to think about money, nobody can tell you what's going on. Afterhours is an Alexa+ add-on for that." |
| 0:15 to 0:30 | **Link account** → wallet sign-in → back to simulator, "Linked · signed" | "Linking is standard OAuth with PKCE, exactly what Alexa+ requires. Instead of a password, I sign a message in my Solana wallet. It's free and can't move funds." |
| 0:30 to 0:50 | Mic: *"What happened overnight?"* Bars appear, reply is spoken. Point at the latency chip. | "Every answer comes from my MCP server over Streamable HTTP. That tool call took a few milliseconds, far inside Alexa+'s 500 millisecond budget." |
| 0:50 to 1:05 | *"Is the Tesla token trading rich?"* | "Afterhours knows what a gap means at this hour. With the share market shut, it's a bet on the open, not a hedge, and it says so." |
| 1:05 to 1:20 | *"How's Super Micro doing?"* (or whichever thin name the guided demo picked today) | "Most tokenized stocks barely trade on chain. Super Micro's token once showed seventeen thousand percent. Afterhours reads the liquidity and won't call a dead pool a price." |
| 1:20 to 1:30 | *"How's my portfolio?"* | "Linked to my wallet, it reads my real balances on Solana." |
| 1:30 to 2:10 | *"Buy 25 dollars of Apple."* Code and QR appear. Scan with the phone → confirm page → fresh quote → sign in Phantom → "Confirmed on Solana". | "Here's the important part. Alexa can't trade. It prepares the trade and reads me a code. I scan it, see a fresh quote, and sign in my own wallet. Afterhours holds no keys, so a misheard number or a TV in the background can never move money. Voice proposes, wallet disposes." |
| 2:10 to 2:20 | *"Did my trade go through?"* | "Alexa confirms it from the chain: the server checks my wallet paid for that exact transaction before it says yes." |
| 2:20 to 2:40 | *"Don't let me trade between* [now] *and* [3 hours from now]*"*, then *"Buy 25 dollars of Nvidia"* (held: "I've set this aside"), then *"Turn off sleep mode"* ("24 hours from now") | "It's built for the 2 a.m. investor. Guardrails I set while calm hold the trade instead of preparing it. And loosening one takes 24 hours, so the person asking at 2 a.m. can't undo it." |
| 2:40 to 2:55 | Terminal or the Deploy to AWS run summary: conformance all PASS against the live URL; then the README | "It's open source and live on AWS: MCP 2025-11-25, OAuth 2.1, a conformance check any Alexa+ developer can run, and Claude on Amazon Bedrock planning. Afterhours: your tokenized stocks, by voice, at any hour." |

## Before recording

- [ ] Deployed over HTTPS with **Actions > Deploy to AWS** (or `npm run conformance -- https://<host>` passes)
- [ ] Do one run of the **guided demo** first: it shows which token is thin today, and that the sleep-mode beat works
- [ ] `PUBLIC_URL` set to that host, so Alexa reads out the right confirm address
- [ ] Bedrock planner on (AWS credentials in the environment); trace badge reads `planner: bedrock`
- [ ] Wallet holds a few xStocks and a little USDC + SOL for the $25 buy and fees
- [ ] Browser mic permission granted; speaker volume up for the screen recording
- [ ] Do a dry run: the first price read after a cold start is the slowest

## Shots that sell it

- The latency chip next to each tool call (green, double-digit ms)
- The six-digit code and QR on the "Echo Show" screen
- The wallet's own signing sheet, so it's obvious the signature isn't Afterhours'
- "Confirmed on Solana" with the Solscan link
