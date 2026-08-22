import { createFileRoute } from "@tanstack/react-router";
import html from "../../public/index.html?raw";

// The original Crazy Pay site is served verbatim at "/".
export const Route = createFileRoute("/")({
  server: {
    handlers: {
      GET: () =>
        new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        }),
    },
  },
});
