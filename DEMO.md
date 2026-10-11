# Demo video script (target 2:45, hard limit 3:00)

Record on the **deployed** server with **live data**, ideally on a Saturday, a Sunday or after 8pm ET, so the
"market closed, tokens still moving" story is happening for real. Use a real wallet (Phantom on your phone is ideal for
the signing shot). Turn on "Speak replies aloud" in the simulator so the replies are heard, not just read.

Screen layout: the simulator full-screen in a desktop browser; switch to a phone mirror for the signing shot.

| Time | On screen | Say (voice-over) |
| --- | --- | --- |
| 0:00 to 0:15 | Landing page, then the simulator | "The stock market is open about 33 hours a week. Tokenized stocks trade all 168. So at 11pm, or on a Sunday, when you actually have time to think about money, nobody can tell you what's going on. Afterhours is an Alexa+ add-on for that." |
| 0:15 to 0:35 | Click **Link account** → wallet sign-in → back to simulator, "Linked · signed" | "Linking is standard OAuth with PKCE, exactly what Alexa+ requires. Instead of a password, you sign a message in your Solana wallet. It's free and can't move funds." |
| 0:35 to 1:00 | Tap the mic: *"What happened overnight?"* Bars appear, reply is spoken. Point at the trace panel's latency chip. | "Every answer comes from my MCP server over Streamable HTTP. Here's the tool call: about 20 milliseconds, well inside Alexa+'s 500 millisecond budget." |
| 1:00 to 1:25 | *"Is the Tesla token trading rich?"* then *"What about Nvidia?"* | "Afterhours knows what a gap means at this hour. With the share market shut it's a bet on the open, not a hedge, and it says so. Follow-ups just work." |
| 1:25 to 1:40 | *"How's my portfolio?"* | "Linked to my wallet, it reads my real balances on Solana and how much they've moved since the close." |
| 1:40 to 1:50 | *"Tell me if Coinbase moves more than 3 percent."* | "Alerts are read back at the top of my next briefing." |
| 1:50 to 2:30 | *"Buy 25 dollars of Apple."* Code and QR appear. Scan the QR with the phone → confirm page → fresh quote → sign in Phantom → "Confirmed on Solana". | "Here's the important part. Alexa can't trade. It prepares the trade and reads me a code. I scan it, see a fresh quote, and sign in my own wallet. Afterhours holds no keys, so a misheard number or a TV in the background can never move money. Voice proposes, wallet disposes." |
| 2:30 to 2:40 | *"Did my trade go through?"* | "And Alexa confirms it from the chain itself: the server checks my wallet paid for that transaction before it says yes." |
| 2:40 to 2:55 | Terminal: `npm run conformance -- https://<host>` all PASS; the repo README | "It's open source: MCP 2025-11-25, OAuth 2.1, a conformance check any Alexa+ developer can run, and Claude on Amazon Bedrock planning the simulator. Afterhours: your tokenized stocks, by voice, at any hour." |

## Before recording

- [ ] Deployed over HTTPS; `npm run conformance -- https://<host>` passes
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
