import assert from 'node:assert/strict';
import fs from 'node:fs';

const path = 'workflows/staging/xmonitor-scheduled-post-tracking-native-sentiment-staging.json';
const workflow = JSON.parse(fs.readFileSync(path, 'utf8'));
const node = (name) => workflow.nodes.find((candidate) => candidate.name === name);

assert.equal(node('Analyze Reply Sentiment').type, '@n8n/n8n-nodes-langchain.sentimentAnalysis');
assert.equal(node('OpenAI Chat Model - Sentiment').parameters.options.maxRetries, 1);
assert.equal(node('Analyze Reply Sentiment').parameters.options.enableAutoFixing, false);
assert.equal(workflow.connections['Analyze Reply Sentiment'].main.length, 3);

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

const classifiedItems = builtItems.map((item) => ({
  json: {
    ...item.json,
    sentimentAnalysis: {
      category: item.json.analysisText.includes('Terrible') ? 'Negative' : 'Positive',
    },
  },
}));

const calculateCode = node('Calculate/Filter Sentiment Counts').parameters.jsCode;
const calculated = await new Function('items', `return (async () => { ${calculateCode} })();`)(
  classifiedItems,
);
const post = calculated[0].json.posts[0];

assert.equal(post.comments_count, 3);
assert.equal(post.negative_count, 2);
assert.equal(post.positive_count, 1);
assert.equal(post.negative_percentage, 67);
assert.equal(post.replies.length, 3, 'deduplicated classifications must expand to every reply');

console.log('Native sentiment workflow regression test passed.');
