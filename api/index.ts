/**
 * Vercel entry: every path is rewritten here (see vercel.json) and handled by
 * the same web-standard app the Node server runs.
 */

import { createApp } from "../src/http/app.js";
import { servicesFromEnv } from "../src/services.js";

const app = createApp(servicesFromEnv());

export const GET = app;
export const POST = app;
export const DELETE = app;
export const OPTIONS = app;
