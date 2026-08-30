#!/usr/bin/env node
// Pull a live workflow and write it to its local export path, in the same
// shape the existing exports use. Live n8n is the truth; this keeps the
// repository copy honest after an edit.
//
//   node scripts/export-workflow.mjs <workflowId> <outFile>

import { writeFileSync } from 'node:fs';
import { callTool } from './n8n-mcp.mjs';

const [, , workflowId, outFile] = process.argv;
if (!workflowId || !outFile) {
  console.error('usage: node scripts/export-workflow.mjs <workflowId> <outFile>');
  process.exit(2);
}

const { workflow } = await callTool('get_workflow_details', { workflowId });

// Match the key order the existing exports use so diffs stay readable.
const ORDER = [
  'id', 'name', 'active', 'activeVersionId', 'nodeCount', 'settings',
  'parentFolderId', 'canExecute', 'connections', 'nodes', 'nodeGroups',
  'activeVersion', 'versionId',
];

const out = {};
for (const k of ORDER) if (k in workflow) out[k] = workflow[k];
for (const k of Object.keys(workflow)) if (!(k in out)) out[k] = workflow[k];

writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
console.log(
  `${outFile}  nodes=${workflow.nodes.length} active=${workflow.active} ` +
    `published=${workflow.versionId === workflow.activeVersionId}`,
);
