#!/usr/bin/env node
// T5 — stamp "Moderation Queue".client_id at enqueue time.
//
// The client is read from the "Posts" row inside the statement rather than
// threaded through the row builder: Posts.client_id is NOT NULL and is
// maintained by the posts_set_client trigger, so it is the authoritative
// answer to "who owns this hide" and cannot drift from what the caller sent.
//
//   node scripts/apply-t5-queue-client.mjs <workflowId>

import { callTool } from './n8n-mcp.mjs';

const workflowId = process.argv[2];
if (!workflowId) {
  console.error('usage: node scripts/apply-t5-queue-client.mjs <workflowId>');
  process.exit(2);
}

const QUERY = `-- Enqueue every candidate reply. Section 2.2: "one pending hide per reply,
-- ever" is the UNIQUE (reply_id) constraint; ON CONFLICT DO UPDATE re-arms a
-- row sitting in failed/abandoned/done so a retry after /auth_x still works,
-- while an in_flight row is left alone because its request may already be
-- airborne.
--
-- T5: client_id is resolved from the owning "Posts" row here rather than being
-- threaded through the row builder. Posts.client_id is NOT NULL and trigger-
-- maintained, so it is authoritative and cannot disagree with the post.
WITH input AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb)
    AS r(post_id text, reply_id text, x_user_id text, telegram_chat_id text)
),
upserted AS (
  INSERT INTO public."Moderation Queue"
    (post_id, reply_id, x_user_id, telegram_chat_id, client_id, batch_id, action, status, attempts, not_before)
  SELECT i.post_id, i.reply_id, i.x_user_id, i.telegram_chat_id,
         (SELECT p.client_id FROM public."Posts" p WHERE p.post_id = i.post_id),
         $2::uuid, 'hide', 'queued', 0, now()
  FROM input i
  ON CONFLICT (reply_id) DO UPDATE
    SET status = 'queued',
        attempts = 0,
        not_before = now(),
        last_error = NULL,
        last_error_code = NULL,
        batch_id = EXCLUDED.batch_id,
        telegram_chat_id = EXCLUDED.telegram_chat_id,
        telegram_message_id = NULL,
        post_id = EXCLUDED.post_id,
        x_user_id = EXCLUDED.x_user_id,
        client_id = EXCLUDED.client_id
    WHERE public."Moderation Queue".status <> 'in_flight'
  RETURNING id
)
SELECT (SELECT count(*) FROM input)    AS submitted,
       (SELECT count(*) FROM upserted) AS queued,
       $2::uuid AS batch_id;`;

const res = await callTool('update_workflow', {
  workflowId,
  versionName: 'T5: stamp Moderation Queue.client_id at enqueue',
  versionDescription: 'client_id resolved from the owning Posts row inside the enqueue statement.',
  operations: [
    {
      type: 'setNodeParameter',
      nodeName: 'Enqueue Hide Requests',
      path: '/query',
      value: QUERY,
    },
  ],
});

console.log(
  JSON.stringify(
    {
      workflowId: res.workflowId,
      nodeCount: res.nodeCount,
      appliedOperations: res.appliedOperations,
      newWarnings: (res.validationWarnings || []).filter((w) => !w.preExisting),
    },
    null,
    2,
  ),
);
