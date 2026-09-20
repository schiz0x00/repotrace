"use client"

import * as React from "react"
import Link from "next/link"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CopyIcon, CheckIcon, PlugZapIcon } from "lucide-react"

const TOOLS: [string, string][] = [
  ["list_projects", "List indexed projects and their slugs (run this first)."],
  ["search_code", "Hybrid semantic + lexical + symbol search over a project's code."],
  ["search_docs", "Search markdown / docs/ files inside a project."],
  ["find_symbol", "Locate a symbol's definition (name or qualified name)."],
  ["find_references", "Find callers/importers of a symbol."],
  ["find_dependencies", "A symbol's imports and calls."],
  ["find_tests", "Tests covering a symbol."],
  ["get_file", "Full contents of a file."],
  ["get_project", "Repository + index metadata."],
  ["get_index_status", "How current the index is for a project."],
  ["get_context", "Curated context bundle (symbols + docs + relationships) for a question."],
]

function buildPrompt(origin: string): string {
  return `You are connected to a Repotrace MCP server — a code-intelligence backend that has indexed a set of git repositories and can answer questions about their code.

MCP SERVER URL: ${origin}/mcp
AUTHENTICATION: send the header \`Authorization: Bearer rt_<API_KEY>\` on every MCP request. Obtain an API key (it starts with rt_) from the Repotrace dashboard: Settings → API Keys → New key.

If you are being wired into an MCP-capable client (Claude Code, Cursor, Cline, …), register the server as a Streamable HTTP MCP server:

  claude mcp add repotrace --transport http --url ${origin}/mcp --header "Authorization: Bearer rt_<API_KEY>"

(In Cursor: Settings → MCP → Add new server → Server URL ${origin}/mcp with header Authorization: Bearer rt_<API_KEY>.)

TOOLS AVAILABLE (every tool takes a \`project\` argument = the project slug or id):
${TOOLS.map(([name, desc]) => `- ${name} — ${desc}`).join("\n")}

WORKFLOW:
1. Always start with list_projects to learn the available project slugs.
2. For a code question, prefer get_context({project, query}) to assemble the relevant symbols and docs, then drill into specific files with get_file.
3. Use search_code for open-ended "where is X handled" questions and find_symbol / find_references for precise structural questions.
4. If get_index_status shows the index lagging, tell the user to trigger a reindex in the Repotrace dashboard.`
}

export function MCPInstall({ origin }: { origin: string }) {
  const mcpUrl = `${origin}/mcp`
  const prompt = buildPrompt(origin)
  const installCommand = `claude mcp add repotrace --transport http --url ${mcpUrl} --header "Authorization: Bearer rt_<API_KEY>"`

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${label} copied.`)
    } catch {
      toast.error("Could not copy — your browser blocked clipboard access.")
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PlugZapIcon />
            Install the MCP server for an AI agent
          </CardTitle>
          <CardDescription>
            Repotrace exposes all of its search and structural tools to agentic
            AI over the Model Context Protocol. Copy the prompt below into your
            agent (Claude Code, Cursor, Cline, …) — it points at this server,
            includes the tool list, and explains how to wire it up.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2 rounded-md border bg-muted px-3 py-2">
            <code className="truncate text-sm">{mcpUrl}</code>
            <Button size="sm" variant="outline" onClick={() => void copy(mcpUrl, "MCP URL")}>
              <CopyIcon />
              Copy URL
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2 rounded-md border bg-muted px-3 py-2">
            <code className="truncate text-xs">{installCommand}</code>
            <Button size="sm" variant="outline" onClick={() => void copy(installCommand, "Config command")}>
              <CopyIcon />
              Copy
            </Button>
          </div>
          <AlertBox />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Copy-paste prompt for your agent</CardTitle>
          <CardDescription>Paste the whole block into the AI agent you want to give code access to.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <pre className="no-scrollbar max-h-96 overflow-y-auto rounded-lg border bg-muted p-3 text-xs whitespace-pre-wrap">
            {prompt}
          </pre>
          <Button onClick={() => void copy(prompt, "Prompt")}>
            <CopyIcon />
            Copy prompt
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tools</CardTitle>
          <CardDescription>Every tool requires a <code>project</code> argument (slug or id).</CardDescription>
        </CardHeader>
        <CardContent className="p-0!">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tool</TableHead>
                <TableHead>What it does</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {TOOLS.map(([name, desc]) => (
                <TableRow key={name}>
                  <TableCell className="font-mono text-xs">{name}</TableCell>
                  <TableCell>{desc}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function AlertBox() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
      <CheckIcon className="mt-0.5 size-4 shrink-0" />
      <span>
        You need an API key first: create one in <Link className="underline" href="/settings">Settings → API Keys</Link>.
        Keys are scoped — leave the project empty for all projects, or pick one to lock the agent to a single repo.
      </span>
    </div>
  )
}