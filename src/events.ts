import type { Response } from "express";

// Minimal Server-Sent Events hub. Channels:
//   staff:<restaurantId>   -> staff board for a restaurant
//   session:<sessionId>    -> every guest phone on a table's tab
const channels = new Map<string, Set<Response>>();

export function subscribe(channel: string, res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: hello\ndata: {}\n\n`);
  let set = channels.get(channel);
  if (!set) channels.set(channel, (set = new Set()));
  set.add(res);
  const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
  res.on("close", () => {
    clearInterval(ping);
    set!.delete(res);
    if (set!.size === 0) channels.delete(channel);
  });
}

export function publish(channel: string, event: string, data: unknown = {}) {
  const set = channels.get(channel);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(payload);
}
