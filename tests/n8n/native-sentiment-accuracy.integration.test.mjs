import assert from 'node:assert/strict';
import fs from 'node:fs';

const SOURCE_WORKFLOW_ID = 'f2eFqB2wO91HAYMJ';
const WORKFLOW_NAME_PREFIX = 'XMonitor - Native Sentiment Accuracy Benchmark';
const TERMINAL_STATUSES = new Set(['success', 'error', 'canceled', 'crashed']);
const CASES_PATH = 'tests/n8n/native-sentiment-accuracy-cases.json';
const DEFAULT_RETRY_TRIES = 6;
const DEFAULT_RETRY_WAIT_MS = 60000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 12 * 60 * 1000;
const PARSER_COMPATIBLE_PROMPT = [
  'You are a precise sentiment classifier for replies to social-media posts.',
  'The text may be Lebanese Arabic, Modern Standard Arabic, English, French, Arabizi, emojis, or code-switching.',
  'Classify the reply sentiment toward the original post or its author.',
  'Treat insults, mockery, threats, hostile sarcasm, and dismissive ridicule as Negative;',
  'clear praise, support, gratitude, and friendly humor as Positive;',
  'factual, ambiguous, mixed, unrelated, or unclear content as Neutral.',
  'Consider negation and context.',
  'Categorize it into exactly one of: {categories}.',
  'Follow the provided formatting instructions exactly.',
].join(' ');
const OPENAI_JSON_SYSTEM_PROMPT = [
  'Classify the sentiment of the reply toward the original post or its author.',
  'Use exactly one sentiment label: Positive, Neutral, or Negative.',
  'Return one JSON object only with a sentiment field.',
  'Example: {"sentiment":"Neutral"}',
].join(' ');

function readEnv(path) {
  const values = {};
  for (const rawLine of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const separator = line.indexOf('=');
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

function requireEnv(env, name) {
  assert.ok(env[name], `${name} is required in keys.env`);
  return env[name];
}

function apiBase(rawBase) {
  const base = rawBase.replace(/\/$/, '');
  return base.endsWith('/api/v1') ? base : `${base}/api/v1`;
}

async function apiRequest(base, apiKey, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-N8N-API-KEY': apiKey,
      ...options.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`n8n API ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function parseMcpResponse(responseText) {
  const dataLine = responseText.split(/\r?\n/).find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : responseText);
}

async function callMcp(url, token, name, args, id) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`n8n MCP ${response.status}: ${text}`);
  const envelope = parseMcpResponse(text);
  if (envelope.error) throw new Error(`n8n MCP error: ${JSON.stringify(envelope.error)}`);
  const content = envelope.result?.content?.find((item) => item.type === 'text')?.text;
  assert.ok(content, `n8n MCP ${name} returned no text result`);
  const result = JSON.parse(content);
  if ((envelope.result?.isError || result.error) && !result.executionId) {
    throw new Error(`${name} failed: ${content}`);
  }
  return result;
}

function codeNode(name, position, jsCode) {
  return {
    parameters: { jsCode },
    id: crypto.randomUUID(),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  };
}

function findNode(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `${name} not found in source workflow ${workflow.id || SOURCE_WORKFLOW_ID}`);
  return node;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function promptVariantFromArgs() {
  const prefix = '--prompt-variant=';
  const explicit = process.argv.find((arg) => arg.startsWith(prefix));
  if (explicit) return explicit.slice(prefix.length);
  if (process.argv.includes('--parser-compatible')) return 'parser-compatible';
  return 'current';
}

function autoFixingFromArgs() {
  return process.argv.includes('--enable-auto-fixing');
}

function modelOverrideFromArgs() {
  const prefix = '--model=';
  const explicit = process.argv.find((arg) => arg.startsWith(prefix));
  return explicit ? explicit.slice(prefix.length).trim() : '';
}

function maxTokensOverrideFromArgs() {
  const prefix = '--max-tokens=';
  const explicit = process.argv.find((arg) => arg.startsWith(prefix));
  if (!explicit) return null;
  const maxTokens = Number(explicit.slice(prefix.length));
  assert.ok(Number.isInteger(maxTokens) && maxTokens > 0, '--max-tokens must be a positive integer');
  return maxTokens;
}

function categoriesOverrideFromArgs() {
  const prefix = '--categories=';
  const explicit = process.argv.find((arg) => arg.startsWith(prefix));
  return explicit ? explicit.slice(prefix.length).trim() : '';
}

function useResponsesApiFromArgs() {
  return process.argv.includes('--responses-api');
}

function engineFromArgs() {
  const prefix = '--engine=';
  const explicit = process.argv.find((arg) => arg.startsWith(prefix));
  return explicit ? explicit.slice(prefix.length).trim() : 'native';
}

function pinAnalysisOutputFromArgs() {
  return process.argv.includes('--pin-analysis-output');
}

function numericArg(name, defaultValue) {
  const prefix = `--${name}=`;
  const explicit = process.argv.find((arg) => arg.startsWith(prefix));
  if (!explicit) return defaultValue;
  const value = Number(explicit.slice(prefix.length));
  assert.ok(Number.isFinite(value) && value >= 0, `--${name} must be a non-negative number`);
  return value;
}

function filteredCasesFromArgs(cases) {
  const idPrefix = '--case-id=';
  const maxPrefix = '--max-cases=';
  const requestedIds = process.argv
    .filter((arg) => arg.startsWith(idPrefix))
    .flatMap((arg) => arg.slice(idPrefix.length).split(',').map((id) => id.trim()).filter(Boolean));
  const requested = requestedIds.length
    ? cases.filter((testCase) => requestedIds.includes(testCase.id))
    : [...cases];
  const maxArg = process.argv.find((arg) => arg.startsWith(maxPrefix));
  if (!maxArg) return requested;
  const maxCases = Number(maxArg.slice(maxPrefix.length));
  assert.ok(Number.isInteger(maxCases) && maxCases > 0, '--max-cases must be a positive integer');
  return requested.slice(0, maxCases);
}

function buildPrepareCode(cases) {
  return `const cases = ${JSON.stringify(cases, null, 2)};

return cases.map((testCase) => {
  const postContext = String(testCase.postText || '').replace(/\\s+/g, ' ').trim().slice(0, 500);
  const replyText = String(testCase.replyText || '').replace(/\\s+/g, ' ').trim().slice(0, 700);
  return {
    json: {
      ...testCase,
      analysisText: \`Original post:\\n\${postContext}\\n\\nReply to classify:\\n\${replyText}\`,
    },
  };
});`;
}

function buildAttachSentimentCode(sourceNodeName) {
  return `function parseJsonCandidate(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' ? value : null;
}

function extractSentiment(item) {
  const data = item.json || {};
  const candidates = [
    data.sentimentAnalysis?.category,
    data.sentiment,
    data.category,
    data.output?.[0]?.content?.[0]?.text,
    data.output,
    data.text,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && ['positive', 'neutral', 'negative'].includes(candidate.trim().toLowerCase())) {
      return candidate;
    }

    const parsed = parseJsonCandidate(candidate);
    const value = parsed?.sentiment ?? parsed?.category ?? parsed?.label;
    if (typeof value === 'string' && ['positive', 'neutral', 'negative'].includes(value.trim().toLowerCase())) {
      return value;
    }
  }

  throw new Error('Sentiment response did not contain Positive, Neutral, or Negative.');
}

const sourceItems = $('${sourceNodeName}').all();
return items.map((item, index) => {
  const source = sourceItems[index]?.json || {};
  const sentiment = extractSentiment(item);
  const normalized = sentiment.trim().toLowerCase();
  const category = normalized[0].toUpperCase() + normalized.slice(1);

  return {
    json: {
      ...source,
      sentimentAnalysis: { category },
    },
  };
});`;
}

function buildScoreCode(
  promptVariant,
  enableAutoFixing,
  modelOverride,
  maxTokensOverride,
  categoriesOverride,
  useResponsesApi,
) {
  return `const labels = ['Positive', 'Neutral', 'Negative'];
const labelByLower = new Map(labels.map((label) => [label.toLowerCase(), label]));
const normalize = (value) => labelByLower.get(String(value || '').trim().toLowerCase()) || 'Missing';
const confusion = Object.fromEntries(
  labels.map((expected) => [expected, Object.fromEntries([...labels, 'Missing'].map((actual) => [actual, 0]))]),
);

const sourceRows = $('Prepare Accuracy Cases').all();
const cases = items.map((item, index) => {
  const row = { ...(sourceRows[index]?.json || {}), ...(item.json || {}) };
  const expectedLabel = normalize(row.expectedLabel);
  const actualLabel = normalize(row.sentimentAnalysis?.category);
  if (confusion[expectedLabel]) confusion[expectedLabel][actualLabel] += 1;
  return {
    id: row.id,
    phenomenon: row.phenomenon,
    expectedLabel,
    actualLabel,
    correct: expectedLabel === actualLabel,
    postText: row.postText,
    replyText: row.replyText,
  };
});

const correct = cases.filter((row) => row.correct).length;
const total = cases.length;
const byExpected = labels.map((label) => {
  const rows = cases.filter((row) => row.expectedLabel === label);
  const hits = rows.filter((row) => row.correct).length;
  return {
    label,
    total: rows.length,
    correct: hits,
    accuracy: rows.length ? Number((hits / rows.length).toFixed(4)) : null,
    accuracyPct: rows.length ? Math.round((hits / rows.length) * 1000) / 10 : null,
  };
});

return [{
  json: {
    benchmark: 'native-sentiment-synthetic-v1',
    sourceWorkflowId: '${SOURCE_WORKFLOW_ID}',
    promptVariant: '${promptVariant}',
    enableAutoFixing: ${enableAutoFixing},
    modelOverride: '${modelOverride}',
    maxTokensOverride: ${maxTokensOverride ?? 'null'},
    categoriesOverride: ${JSON.stringify(categoriesOverride)},
    useResponsesApi: ${useResponsesApi},
    total,
    correct,
    accuracy: total ? Number((correct / total).toFixed(4)) : null,
    accuracyPct: total ? Math.round((correct / total) * 1000) / 10 : null,
    byExpected,
    confusion,
    mismatches: cases.filter((row) => !row.correct),
    cases,
  },
}];`;
}

function buildWorkflow(
  sourceWorkflow,
  cases,
  promptVariant,
  enableAutoFixing,
  modelOverride,
  maxTokensOverride,
  categoriesOverride,
  useResponsesApi,
) {
  const engine = engineFromArgs();
  const sourceSentiment = findNode(sourceWorkflow, 'Analyze Reply Sentiment');
  const sourceModel = sourceWorkflow.nodes.find((candidate) => candidate.name === 'OpenAI Chat Model - Sentiment');
  const sentimentParameters = jsonClone(sourceSentiment.parameters);
  const modelParameters = sourceModel
    ? jsonClone(sourceModel.parameters)
    : { model: jsonClone(sourceSentiment.parameters?.modelId || { __rl: true, mode: 'list', value: 'gpt-4o-mini' }) };
  const openAiCredentials = sourceModel?.credentials || sourceSentiment.credentials;

  if (promptVariant === 'parser-compatible') {
    sentimentParameters.options.systemPromptTemplate = PARSER_COMPATIBLE_PROMPT;
  } else if (promptVariant !== 'current') {
    throw new Error(`Unsupported prompt variant: ${promptVariant}`);
  }
  if (enableAutoFixing) {
    sentimentParameters.options.enableAutoFixing = true;
  }
  if (categoriesOverride) {
    sentimentParameters.options.categories = categoriesOverride;
  }
  if (modelOverride) {
    if (typeof modelParameters.model === 'object' && modelParameters.model) {
      modelParameters.model = { ...modelParameters.model, value: modelOverride };
    } else {
      modelParameters.model = modelOverride;
    }
  }
  if (maxTokensOverride) {
    modelParameters.options = {
      ...(modelParameters.options || {}),
      maxTokens: maxTokensOverride,
    };
  }
  if (useResponsesApi) {
    modelParameters.responsesApiEnabled = true;
  }

  if (!['native', 'openai-json'].includes(engine)) {
    throw new Error(`Unsupported engine: ${engine}`);
  }
  if (engine === 'native' && !sourceModel) {
    throw new Error('The source workflow no longer has a native Sentiment Analysis chat-model subnode.');
  }

  const analysisNode = engine === 'openai-json'
    ? {
        parameters: {
          modelId: modelOverride
            ? { __rl: true, mode: 'list', value: modelOverride }
            : jsonClone(modelParameters.model),
          responses: {
            values: [
              { role: 'system', content: OPENAI_JSON_SYSTEM_PROMPT },
              { content: '={{ $json.analysisText }}' },
            ],
          },
          builtInTools: {},
          options: { textFormat: { textOptions: { type: 'json_object' } } },
        },
        id: crypto.randomUUID(),
        name: 'Analyze Reply Sentiment',
        type: '@n8n/n8n-nodes-langchain.openAi',
        typeVersion: 2.1,
        position: [520, 0],
        credentials: openAiCredentials,
        retryOnFail: true,
        maxTries: numericArg('retry-tries', DEFAULT_RETRY_TRIES),
        waitBetweenTries: numericArg('retry-wait-ms', DEFAULT_RETRY_WAIT_MS),
      }
    : {
        parameters: sentimentParameters,
        id: crypto.randomUUID(),
        name: 'Analyze Reply Sentiment',
        type: sourceSentiment.type,
        typeVersion: sourceSentiment.typeVersion,
        position: [520, 0],
      };

  const nodes = [
    {
      parameters: {},
      id: crypto.randomUUID(),
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 0],
    },
    codeNode('Prepare Accuracy Cases', [240, 0], buildPrepareCode(cases)),
    analysisNode,
  ];

  if (engine === 'native') {
    nodes.push(
      {
        parameters: modelParameters,
        id: crypto.randomUUID(),
        name: 'OpenAI Chat Model - Sentiment',
        type: sourceModel.type,
        typeVersion: sourceModel.typeVersion,
        position: [520, 220],
        credentials: openAiCredentials,
      },
      {
        parameters: { mode: 'append', numberInputs: 3 },
        id: crypto.randomUUID(),
        name: 'Merge Sentiment Categories',
        type: 'n8n-nodes-base.merge',
        typeVersion: 3.2,
        position: [800, 0],
      },
    );
  } else {
    nodes.push(codeNode('Attach Sentiment Metadata', [800, 0], buildAttachSentimentCode('Prepare Accuracy Cases')));
  }

  nodes.push(
    codeNode(
      'Score Sentiment Accuracy',
      [1040, 0],
      buildScoreCode(
        promptVariant,
        enableAutoFixing,
        modelOverride,
        maxTokensOverride,
        categoriesOverride,
        useResponsesApi,
      ),
    ),
  );

  const connections = engine === 'native'
    ? {
        'Manual Trigger': { main: [[{ node: 'Prepare Accuracy Cases', type: 'main', index: 0 }]] },
        'Prepare Accuracy Cases': { main: [[{ node: 'Analyze Reply Sentiment', type: 'main', index: 0 }]] },
        'OpenAI Chat Model - Sentiment': {
          ai_languageModel: [[{ node: 'Analyze Reply Sentiment', type: 'ai_languageModel', index: 0 }]],
        },
        'Analyze Reply Sentiment': {
          main: [
            [{ node: 'Merge Sentiment Categories', type: 'main', index: 0 }],
            [{ node: 'Merge Sentiment Categories', type: 'main', index: 1 }],
            [{ node: 'Merge Sentiment Categories', type: 'main', index: 2 }],
          ],
        },
        'Merge Sentiment Categories': { main: [[{ node: 'Score Sentiment Accuracy', type: 'main', index: 0 }]] },
      }
    : {
        'Manual Trigger': { main: [[{ node: 'Prepare Accuracy Cases', type: 'main', index: 0 }]] },
        'Prepare Accuracy Cases': { main: [[{ node: 'Analyze Reply Sentiment', type: 'main', index: 0 }]] },
        'Analyze Reply Sentiment': { main: [[{ node: 'Attach Sentiment Metadata', type: 'main', index: 0 }]] },
        'Attach Sentiment Metadata': { main: [[{ node: 'Score Sentiment Accuracy', type: 'main', index: 0 }]] },
      };

  return {
    name: `${WORKFLOW_NAME_PREFIX} ${promptVariant}${enableAutoFixing ? ' autofix' : ''}${modelOverride ? ` ${modelOverride}` : ''}${maxTokensOverride ? ` maxtok${maxTokensOverride}` : ''} ${Date.now()}`,
    nodes,
    connections,
    settings: { executionOrder: 'v1', availableInMCP: true },
  };
}

async function waitForExecution(mcpUrl, mcpToken, workflowId, executionId) {
  const timeoutMs = numericArg('execution-timeout-ms', DEFAULT_EXECUTION_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    const execution = await callMcp(mcpUrl, mcpToken, 'get_execution', {
      workflowId,
      executionId,
      includeData: true,
      nodeNames: ['Score Sentiment Accuracy'],
      truncateData: 200,
    }, 100 + attempt);
    if (TERMINAL_STATUSES.has(execution.execution?.status)) return execution;
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Execution ${executionId} did not finish within ${Math.round(timeoutMs / 1000)} seconds`);
}

function extractScore(execution) {
  const runDataCandidates = [
    execution.execution?.data?.resultData?.runData,
    execution.data?.resultData?.runData,
    execution.execution?.data?.runData,
    execution.runData,
  ].filter(Boolean);
  for (const runData of runDataCandidates) {
    const runs = runData['Score Sentiment Accuracy'];
    if (!Array.isArray(runs)) continue;
    for (const run of runs) {
      const firstItem = run.data?.main?.[0]?.[0]?.json;
      if (firstItem?.benchmark === 'native-sentiment-synthetic-v1') return firstItem;
    }
  }
  throw new Error('Score Sentiment Accuracy output was not present in execution data.');
}

function throwIfExecutionFailed(execution, executionId) {
  const status = execution.execution?.status;
  if (status === 'success') return;
  const resultData = execution.data?.resultData || execution.execution?.data?.resultData || {};
  const error = resultData.error || {};
  const lastNode = resultData.lastNodeExecuted || error.node?.name || 'unknown';
  const message = error.message || 'No error message returned';
  throw new Error(`Benchmark execution ${executionId} ended with status ${status}; last node: ${lastNode}; error: ${message}`);
}

const env = readEnv('keys.env');
const base = apiBase(requireEnv(env, 'N8N_BASE_URL'));
const apiKey = requireEnv(env, 'N8N_API_KEY');
const mcpUrl = requireEnv(env, 'N8N_MCP_URL');
const mcpToken = requireEnv(env, 'N8N_MCP_ACCESS_TOKEN');
const allCases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
const cases = filteredCasesFromArgs(allCases);
const engine = engineFromArgs();
const promptVariant = promptVariantFromArgs();
const enableAutoFixing = autoFixingFromArgs();
const modelOverride = modelOverrideFromArgs();
const maxTokensOverride = maxTokensOverrideFromArgs();
const categoriesOverride = categoriesOverrideFromArgs();
const useResponsesApi = useResponsesApiFromArgs();
const pinAnalysisOutput = pinAnalysisOutputFromArgs();
assert.ok(cases.length > 0, 'No benchmark cases selected');

let workflow;
try {
  const sourceWorkflow = await apiRequest(base, apiKey, `/workflows/${SOURCE_WORKFLOW_ID}`);
  workflow = await apiRequest(base, apiKey, '/workflows', {
    method: 'POST',
    body: JSON.stringify(buildWorkflow(
      sourceWorkflow,
      cases,
      promptVariant,
      enableAutoFixing,
      modelOverride,
      maxTokensOverride,
      categoriesOverride,
      useResponsesApi,
    )),
  });
  const delayBeforeRunMs = numericArg('delay-before-run-ms', 0);
  if (delayBeforeRunMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayBeforeRunMs));
  }
  const started = await callMcp(mcpUrl, mcpToken, 'test_workflow', {
    workflowId: workflow.id,
    triggerNodeName: 'Manual Trigger',
    pinData: {
      'Manual Trigger': [{ json: {} }],
      ...(pinAnalysisOutput
        ? {
            'Analyze Reply Sentiment': cases.map((testCase) => ({
              json: {
                output: [
                  {
                    content: [
                      {
                        text: JSON.stringify({ sentiment: testCase.expectedLabel }),
                      },
                    ],
                  },
                ],
              },
            })),
          }
        : {}),
    },
  }, 1);
  const execution = await waitForExecution(mcpUrl, mcpToken, workflow.id, started.executionId);
  throwIfExecutionFailed(execution, started.executionId);
  const score = extractScore(execution);
  console.log(JSON.stringify({
    sourceWorkflowId: SOURCE_WORKFLOW_ID,
    benchmarkWorkflowId: workflow.id,
    executionId: started.executionId,
    engine,
    promptVariant,
    enableAutoFixing,
    modelOverride,
    maxTokensOverride,
    categoriesOverride,
    useResponsesApi,
    pinAnalysisOutput,
    total: score.total,
    correct: score.correct,
    accuracyPct: score.accuracyPct,
    byExpected: score.byExpected,
    confusion: score.confusion,
    mismatches: score.mismatches.map((row) => ({
      id: row.id,
      phenomenon: row.phenomenon,
      expectedLabel: row.expectedLabel,
      actualLabel: row.actualLabel,
      replyText: row.replyText,
    })),
  }, null, 2));
} finally {
  if (workflow?.id) await apiRequest(base, apiKey, `/workflows/${workflow.id}`, { method: 'DELETE' });
}
