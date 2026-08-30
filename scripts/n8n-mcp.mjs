#!/usr/bin/env node
// Thin JSON-RPC client for the n8n MCP HTTP endpoint.
//
// Exists so large workflow payloads can be written to disk and inspected with
// grep/node instead of being pulled through an agent's context window. The
// claude.ai n8n connector is the preferred route for *edits*; this is for bulk
// reads. Credentials come from keys.env and are never printed.
//
//   node scripts/n8n-mcp.mjs <tool> '<json-args>' [outfile]
//
// Prints the JSON result to stdout, or writes it to outfile and prints a summary.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// keys.env is gitignored, so it exists only in the main checkout — a worktree
// never has its own copy. Fall back to the main working tree, which
// `git rev-parse --path-format=absolute --git-common-dir` locates.
function keysEnvPath() {
  const local = resolve(repoRoot, 'keys.env');
  if (existsSync(local)) return local;
  const commonDir = execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim();
  const mainRoot = resolve(commonDir, '..');
  const shared = resolve(mainRoot, 'keys.env');
  if (existsSync(shared)) return shared;
  throw new Error('keys.env not found in this worktree or the main checkout');
}

function loadEnv() {
  const env = {};
  const text = readFileSync(keysEnvPath(), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

// The endpoint replies as SSE: one or more "data: {...}" lines. Take the last
// one carrying a JSON-RPC envelope.
function parseSse(body) {
  const payloads = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      const raw = line.slice(5).trim();
      if (!raw) continue;
      try { payloads.push(JSON.parse(raw)); } catch { /* keepalive noise */ }
    }
  }
  if (!payloads.length) {
    try { return JSON.parse(body); } catch { throw new Error('no JSON-RPC payload in response'); }
  }
  return payloads[payloads.length - 1];
}

export async function callTool(name, args) {
  const env = loadEnv();
  const url = env.N8N_MCP_URL;
  const token = env.N8N_MCP_ACCESS_TOKEN;
  if (!url || !token) throw new Error('N8N_MCP_URL / N8N_MCP_ACCESS_TOKEN missing from keys.env');

  // Running a whole fixture suite trips the endpoint's rate limit, so back off
  // and retry rather than losing the run partway through.
  let res;
  for (let attempt = 0; ; attempt += 1) {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });

    if (res.status !== 429 || attempt >= 6) break;
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(30_000, 2000 * 2 ** attempt);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const env2 = parseSse(await res.text());
  if (env2.error) throw new Error(`MCP error: ${JSON.stringify(env2.error)}`);

  const content = env2.result?.content;
  if (Array.isArray(content)) {
    const text = content.map((c) => c.text ?? '').join('');
    try { return JSON.parse(text); } catch { return text; }
  }
  return env2.result;
}

// CLI only when run directly — this module is also imported by the apply-*
// scripts, which pass their own argv.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const [, , tool, argsJson, outfile] = process.argv;
  if (!tool) {
    console.error("usage: node scripts/n8n-mcp.mjs <tool> '<json-args>' [outfile]");
    process.exit(2);
  }

  const result = await callTool(tool, argsJson ? JSON.parse(argsJson) : {});
  const text = JSON.stringify(result, null, 2);

  if (outfile) {
    writeFileSync(outfile, text);
    console.log(`wrote ${outfile} (${text.length} bytes)`);
  } else {
    console.log(text);
  }
}
