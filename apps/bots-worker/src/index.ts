import type { Env } from "./env.js";
import { route } from "./router.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      console.error("bots-worker: unhandled", err instanceof Error ? err.message : "error");
      return Response.json({ error: { code: "internal_error", message: "Internal error" } }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
