import type { NextRequest } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const BACKEND = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:4001";

async function proxy(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const url = `${BACKEND}/api/${path.join("/")}${request.nextUrl.search}`;

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    // Skip hop-by-hop headers
    if (["host", "connection", "transfer-encoding"].includes(key.toLowerCase()))
      continue;
    headers.set(key, value);
  }
  // Prevent compression so the response body is never buffered for decompression
  headers.set("accept-encoding", "identity");

  const upstream = await fetch(url, {
    method: request.method,
    headers,
    body:
      request.method !== "GET" && request.method !== "HEAD"
        ? request.body
        : undefined,
    // @ts-expect-error Node fetch supports duplex for streaming request bodies
    duplex: "half",
  });

  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers) {
    if (
      ["transfer-encoding", "connection", "content-encoding"].includes(
        key.toLowerCase(),
      )
    )
      continue;
    responseHeaders.set(key, value);
  }
  // Disable any intermediate proxy/CDN buffering
  responseHeaders.set("x-accel-buffering", "no");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
