import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateRequest } from "@/lib/authn";
import { createMcpServer } from "@/lib/mcp/server";
import { unauthorized } from "@/lib/errors";
import { route, json } from "@/lib/http";

/**
 * MCP endpoint over streamable HTTP. Machine authentication only: agents
 * authenticate with an API key (Authorization: Bearer rt_...), never with a
 * browser session. Each request gets a fresh server+transport (stateless).
 *
 * Wrapped in `route()` like every other endpoint. Previously an invalid or
 * revoked key threw straight out of the handler, producing an unhandled 500
 * instead of the documented JSON 401.
 */
export async function POST(request: Request): Promise<Response> {
  return route(async (req) => {
    const principal = await authenticateRequest(req);
    if (!principal) {
      throw unauthorized(
        "authentication_required",
        "Provide an API key via Authorization: Bearer rt_...",
      );
    }
    const server = createMcpServer(principal);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  })(request, {});
}

export async function GET(request: Request): Promise<Response> {
  return route(async (req) => {
    const principal = await authenticateRequest(req);
    if (!principal) {
      throw unauthorized(
        "authentication_required",
        "Provide an API key via Authorization: Bearer rt_...",
      );
    }

    // Per the streamable-HTTP spec an HTTP GET opens the server-to-client SSE
    // stream. This server is stateless (no session id, no server-initiated
    // messages), so there is no stream to offer and the spec allows 405.
    //
    // Answering 200 with a JSON body instead meant the client opened the
    // listener, saw the body end immediately, and reconnected on its backoff
    // timer — a loop, one authenticated request per second, each one an API
    // key lookup that writes `lastUsedAt`. A single misbehaving client turned
    // into steady database traffic.
    const accept = req.headers.get("accept") ?? "";
    if (accept.includes("text/event-stream")) {
      return json(
        {
          error: {
            code: "sse_not_supported",
            message:
              "This MCP endpoint is stateless and does not offer a server-to-client SSE stream. " +
              "Use POST for requests, and call `tools/list` to discover tools.",
          },
        },
        405,
      );
    }

    // A plain discovery request. The tool list is deliberately not inlined:
    // it drifted from the real registry every time a tool was added. Callers
    // get it authoritatively from `tools/list`.
    return json({
      name: "repotrace MCP",
      version: "1.0.0",
      transport: "streamable-http (stateless)",
      discoverTools: "POST a JSON-RPC `tools/list` request to this endpoint",
      auth: "Bearer API key (create one in Settings → API Keys)",
    });
  })(request, {});
}