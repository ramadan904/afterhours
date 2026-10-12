/**
 * The simulator's voice: Amazon Polly when the deployment has it.
 *
 * The browser's built-in voices vary wildly by device, and a demo judged on
 * how it sounds shouldn't depend on which laptop it runs on. With POLLY=on,
 * the simulator asks this endpoint for each reply and plays an Amazon Polly
 * voice (generative engine, falling back to neural); without it, or if Polly
 * fails, the page uses the browser's speech synthesis as before.
 *
 * Only linked sessions may ask (it costs money per character), replies are
 * capped at 600 characters, and requests are rate-limited per client.
 */

import type { Services } from "../services.js";
import { authenticate } from "../auth/oauth.js";
import { RateLimit } from "../http/limit.js";

export type Synth = (text: string, voice: string, engine: "generative" | "neural") => Promise<Uint8Array>;

let synth: Synth | null = null;
const limit = new RateLimit(60, 60_000);

export function pollyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.POLLY === "on" || synth !== null;
}

/** Tests inject a stand-in; production builds a Polly client on first use. */
export function setSynth(s: Synth | null): void {
  synth = s;
}

async function pollySynth(): Promise<Synth> {
  if (synth) return synth;
  const { PollyClient, SynthesizeSpeechCommand } = await import("@aws-sdk/client-polly");
  const client = new PollyClient({});
  synth = async (text, voice, engine) => {
    const out = await client.send(new SynthesizeSpeechCommand({ Text: text, VoiceId: voice as never, Engine: engine, OutputFormat: "mp3", TextType: "text" }));
    if (!out.AudioStream) throw new Error("Polly returned no audio");
    return out.AudioStream.transformToByteArray();
  };
  return synth;
}

export async function speak(svc: Services, request: Request): Promise<Response> {
  if (!pollyEnabled()) return new Response(null, { status: 404 });
  if (svc.authRequired && !authenticate(svc, request)) return new Response(null, { status: 401 });
  if (limit.exceeded(request)) return new Response(null, { status: 429 });
  const body = (await request.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 600) : "";
  if (!text) return new Response(null, { status: 400 });
  const voice = process.env.POLLY_VOICE ?? "Ruth";
  try {
    const s = await pollySynth();
    const audio = await s(text, voice, "generative").catch(() => s(text, voice, "neural"));
    return new Response(Buffer.from(audio), { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  } catch (err) {
    console.error("polly:", (err as Error).message);
    return new Response(null, { status: 502 });
  }
}
