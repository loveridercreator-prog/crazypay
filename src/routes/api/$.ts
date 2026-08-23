import { createFileRoute } from "@tanstack/react-router";

const BACKEND_URL =
  "https://ais-dev-qn4foozn3gqijpr4qn5j43-383014714207.asia-southeast1.run.app";

async function proxy({ request }: { request: Request }) {
  // LIVE MODE: no local mock layer. Every /api/* request goes straight to the
  // live backend so the preview renders real network data.




  const incoming = new URL(request.url);
  const target = new URL(
    incoming.pathname + incoming.search,
    BACKEND_URL,
  );

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");

  const response = await fetch(target, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method)
      ? null
      : new Uint8Array(await request.arrayBuffer()),
  });


  const outHeaders = new Headers(response.headers);
  outHeaders.delete("content-encoding");
  outHeaders.delete("content-length");
  outHeaders.set("cache-control", "no-store");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: outHeaders,
  });
}

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: proxy,
      POST: proxy,
      PUT: proxy,
      PATCH: proxy,
      DELETE: proxy,
      OPTIONS: proxy,
    },
  },
});
