#!/usr/bin/env node
/**
 * Mock OpenAI-compatible embedding server for local development and tests.
 * Deterministic vectors (same text -> same vector) derived from a content
 * hash, so tests are reproducible without a real embedding model.
 *
 * Usage: node scripts/mock-embeddings.mjs [port] [dimensions]
 * Endpoint: POST /embeddings  { model, input: string[] }
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 11435);
const dims = Number(process.argv[3] ?? 64);

function hashToSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function vectorFor(text, dim) {
  let seed = hashToSeed(text);
  const vec = new Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const v = (seed / 0xffffffff) * 2 - 1;
    vec[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

const server = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*" });
    return res.end();
  }
  if (req.method !== "POST" || !req.url.startsWith("/embeddings")) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found" }));
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid json" }));
    }
    const input = Array.isArray(payload.input) ? payload.input : [payload.input];
    const data = input.map((text) => ({ embedding: vectorFor(String(text), dims) }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data, model: payload.model, usage: { total_tokens: 0 } }));
  });
});

server.listen(port, () => {
  console.log(`[mock-embeddings] listening on :${port} (dimensions=${dims})`);
});