import assert from 'node:assert/strict';
import fs from 'node:fs';

const path = 'workflows/staging/xmonitor-scheduled-post-tracking-native-sentiment-staging.json';
const workflow = JSON.parse(fs.readFileSync(path, 'utf8'));
const node = (name) => workflow.nodes.find((candidate) => candidate.name === name);

assert.equal(node('Analyze Reply Sentiment').type, '@n8n/n8n-nodes-langchain.openAi');
assert.equal(node('Analyze Reply Sentiment').parameters.options.textFormat.textOptions.type, 'json_object');
assert.equal(node('Analyze Reply Sentiment').retryOnFail, true);
assert.equal(node('Analyze Reply Sentiment').maxTries, 6);
assert.equal(node('Analyze Reply Sentiment').waitBetweenTries, 60000);
assert.ok(node('Attach Sentiment Metadata'));
assert.equal(node('OpenAI Chat Model - Sentiment'), undefined);
assert.equal(node('Merge Sentiment Categories'), undefined);
assert.equal(workflow.connections['Analyze Reply Sentiment'].main[0][0].node, 'Attach Sentiment Metadata');
assert.equal(workflow.connections['Attach Sentiment Metadata'].main[0][0].node, 'Calculate/Filter Sentiment Counts');

const buildCode = node('Build Deduplicated Reply Items').parameters.jsCode;
const sourceData = {
  'Keep Posts With 10+ Replies': [
    {
      json: {
        id: 'post-1',
        conversation_id: 'conversation-1',
        author_id: 'user-1',
        text: 'Original post',
      },
    },
  ],
  'Get Replies': [
    {
      json: {
        data: [
          { id: 'reply-1', conversation_id: 'conversation-1', text: 'Terrible take' },
          { id: 'reply-2', conversation_id: 'conversation-1', text: '  TERRIBLE   take ' },
          { id: 'reply-3', conversation_id: 'conversation-1', text: 'Great point' },
        ],
      },
    },
  ],
};

const n8nLookup = (name) => ({ all: () => sourceData[name] });
const builtItems = await new Function('$', `return (async () => { ${buildCode} })();`)(n8nLookup);

assert.equal(builtItems.length, 2, 'normalized duplicate replies should use one classification call');
assert.equal(builtItems[0].json.duplicateReplies.length, 2);

const analyzedItems = builtItems.map((item) => ({
  json: {
    output: [
      {
        content: [
          {
            text: item.json.analysisText.includes('Terrible')
              ? '{"sentiment":"Negative"}'
              : '{"sentiment":"Positive"}',
          },
        ],
      },
    ],
  },
}));

const attachCode = node('Attach Sentiment Metadata').parameters.jsCode;
const attachedItems = await new Function('items', '$', `return (async () => { ${attachCode} })();`)(
  analyzedItems,
  (name) => {
    assert.equal(name, 'Build Deduplicated Reply Items');
    return { all: () => builtItems };
  },
);

assert.equal(attachedItems[0].json.sentimentAnalysis.category, 'Negative');
assert.equal(attachedItems[0].json.duplicateReplies.length, 2);
assert.equal(attachedItems[1].json.sentimentAnalysis.category, 'Positive');

const calculateCode = node('Calculate/Filter Sentiment Counts').parameters.jsCode;
const calculated = await new Function('items', `return (async () => { ${calculateCode} })();`)(
  attachedItems,
);
const post = calculated[0].json.posts[0];

assert.equal(post.comments_count, 3);
assert.equal(post.negative_count, 2);
assert.equal(post.positive_count, 1);
assert.equal(post.negative_percentage, 67);
assert.equal(post.replies.length, 3, 'deduplicated classifications must expand to every reply');

console.log('Native sentiment workflow regression test passed.');
