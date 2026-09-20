import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateRequest } from "@/lib/authn";
import { createMcpServer } from "@/lib/mcp/server";
import { errorBody } from "@/lib/errors";

/**
 * MCP endpoint over streamable HTTP. Machine authentication only: agents
 * authenticate with an API key (Authorization: Bearer rt_...), never with a
 * browser session. Each request gets a fresh server+transport (stateless).
 */
export async function POST(request: Request): Promise<Response> {
  const principal = await authenticateRequest(request);
  if (!principal) {
    return Response.json(
      errorBody(new Error("Authentication required: provide an API key via Authorization: Bearer")),
      { status: 401 },
    );
  }
  const server = createMcpServer(principal);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export async function GET(request: Request): Promise<Response> {
  const principal = await authenticateRequest(request);
  if (!principal) {
    return Response.json(
      errorBody(new Error("Authentication required: provide an API key via Authorization: Bearer")),
      { status: 401 },
    );
  }
  return Response.json({
    name: "repotrace MCP",
    version: "1.0.0",
    tools: [
      "list_projects",
      "search_code",
      "search_docs",
      "find_symbol",
      "find_references",
      "find_dependencies",
      "find_tests",
      "get_file",
      "get_project",
      "get_index_status",
      "get_context",
    ],
    auth: "Bearer API key (create one in Settings → API Keys)",
  });
}