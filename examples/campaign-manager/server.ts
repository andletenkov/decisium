// Campaign manager fixture: static SPA + in-memory JSON API with artificial latency.
// Usage: node examples/campaign-manager/server.ts [port]   (LATENCY_MS env, default 300)
// Opening the app with ?reset=1 restores the seed data, so every test starts from the same state.
import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

interface Campaign { id: number; name: string; status: "Draft" | "Scheduled"; date: string; period: string }

const SEED: Campaign[] = [
  { id: 1, name: "Autumn Sale", status: "Scheduled", date: "2026-10-20", period: "1 week" },
  { id: 2, name: "Spring Sale", status: "Draft", date: "", period: "1 week" },
];
let campaigns: Campaign[] = [];
let nextId = 0;
const reset = () => { campaigns = SEED.map(c => ({ ...c })); nextId = 3; };
reset();

const LATENCY = Number(process.env.LATENCY_MS ?? 300);
const html = readFileSync(new URL("./index.html", import.meta.url));
const send = (res: ServerResponse, status: number, body: unknown) =>
  setTimeout(() => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }, LATENCY);

export function start(port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let body: Partial<Campaign> = {};
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      body = raw ? JSON.parse(raw) : {};
    }
    const one = /^\/api\/campaigns\/(\d+)(\/schedule)?$/.exec(url.pathname);
    const found = one && campaigns.find(c => c.id === Number(one[1]));

    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
    else if (url.pathname === "/api/reset" && req.method === "POST") { reset(); send(res, 200, { ok: true }); }
    else if (url.pathname === "/api/campaigns" && req.method === "GET") send(res, 200, campaigns);
    else if (url.pathname === "/api/campaigns" && req.method === "POST") {
      if (!body.name?.trim()) return send(res, 400, { error: "Name is required" });
      const c: Campaign = { id: nextId++, name: body.name.trim(), status: "Draft", date: body.date ?? "", period: body.period ?? "1 week" };
      campaigns.push(c);
      send(res, 201, c);
    } else if (found && !one[2] && req.method === "GET") send(res, 200, found);
    else if (found && one[2] && req.method === "POST") {
      if (!found.date) return send(res, 400, { error: "Set an activation date before scheduling" });
      found.status = "Scheduled";
      send(res, 200, found);
    } else if (found && !one[2] && req.method === "DELETE") { campaigns = campaigns.filter(c => c !== found); send(res, 200, { ok: true }); }
    else send(res, 404, { error: "Not found" });
  });
  return new Promise<{ url: string; close: () => void }>(resolve =>
    server.listen(port, "127.0.0.1", () => {
      const { port: p } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${p}/`, close: () => server.close() });
    }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await start(Number(process.argv[2] ?? 5173));
  console.log(`Campaign manager on ${url}  (open ${url}?reset=1 for seed data)`);
}
