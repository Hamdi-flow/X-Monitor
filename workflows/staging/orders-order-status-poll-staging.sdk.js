import { workflow, node, trigger, ifElse, switchCase, expr } from '@n8n/workflow-sdk';

// Orders - Order Status Poll (Staging)
// One poller for X, FB and IG orders. Called by pg_cron's trigger_order_polls()
// (X-Monitor db/migrations/2026-10-23-order-poll-unified.sql) ONLY when
// due_order_polls() has rows, so an idle day costs zero executions.

const PG = { postgres: { id: 'CyXakOvvENeDwRue', name: 'Supabase Staging Postgres' } };

const webhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Order Poll Webhook',
    position: [0, 0],
    parameters: { httpMethod: 'POST', path: 'order-poll-staging', responseMode: 'onReceived', options: {} }
  }
});

const verifySecret = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Verify Poll Secret',
    position: [224, 0],
    retryOnFail: false,
    alwaysOutputData: true,
    credentials: PG,
    parameters: {
      operation: 'executeQuery',
      query: `-- Compared IN SQL so the shared secret never enters n8n execution data; only
-- the boolean does. pg_cron's trigger_order_polls() signs with the same Vault
-- row. Fails closed: missing/empty/wrong header or missing Vault row -> false.
select exists (
  select 1 from vault.decrypted_secrets
  where name = 'order_poll_secret'
    and decrypted_secret = $1
) as authorized;`,
      options: { queryReplacement: expr("{{ [$json.headers['x-order-poll-secret'] || ''] }}") }
    }
  }
});

const ifAuthorized = ifElse({
  version: 2.2,
  config: {
    name: 'If Poll Authorized',
    position: [448, 0],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: 'poll-authorized', leftValue: expr('{{ $json.authorized }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const reject = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { name: 'Reject Unauthorized Poll Call', position: [672, 200], parameters: {} }
});

const fetchDue = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Fetch Due Orders',
    position: [672, 0],
    credentials: PG,
    parameters: {
      operation: 'executeQuery',
      query: `-- Every product's due orders in one shape, with the provider endpoint and key
-- joined on. The table-specific SQL lives in due_order_polls(), which is also
-- what the pg_cron gate counts, so 'due' there and 'fetched' here agree.
-- X rows join FB SMM Settings provider 'smmwiz_x'; until that row exists no X
-- order is returned, rather than being polled with the wrong account's key.
select * from public.due_order_polls(50);`,
      options: {}
    }
  }
});

const checkStatus = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Check Provider Order Status',
    position: [896, 0],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr('{{ $json.api_url }}'),
      sendBody: true,
      contentType: 'form-urlencoded',
      bodyParameters: {
        parameters: [
          { name: 'key', value: expr('{{ $json.api_key }}') },
          { name: 'action', value: 'status' },
          { name: 'order', value: expr('{{ $json.provider_order_id }}') }
        ]
      },
      options: { timeout: 30000, response: { response: { responseFormat: 'json' } } }
    }
  }
});

const normalizeCode = `// Runs ONCE PER ITEM and returns ONE object. Both halves matter: in all-items
// mode $itemIndex is always 0, so only the first due order would be processed
// (FB staging execution 42654); per-item mode with an array return errors.
//
// SMMWiz response traps (confirmed live on FB 2026-08-24 and IG 2026-10-06):
// - JSON under Content-Type text/html: responseFormat=json on the HTTP node AND
//   unwrapProviderBody() below. Do not remove either half.
// - start_count arrives as '' -> firstPresent treats '' as missing.
// - charge/remains arrive as strings -> toNumber/toInteger.
// The api_key is NOT carried past this node.
function unwrapProviderBody(raw) {
  const value = raw ?? {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (e) { return {}; }
  }
  if (value && typeof value.data === 'string') {
    try { return JSON.parse(value.data); } catch (e) { return {}; }
  }
  return value;
}

const esc = (value) => String(value === null || value === undefined ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const order = $('Fetch Due Orders').all()[$itemIndex]?.json || {};
const response = unwrapProviderBody($json);

function firstPresent(keys) {
  for (const key of keys) {
    if (response[key] !== undefined && response[key] !== null && response[key] !== '') return response[key];
  }
  return null;
}
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}
function toInteger(value) {
  const parsed = toNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}
function normalize(raw, hasError) {
  if (hasError) return 'failed';
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return 'pending';
  if (value.includes('complete')) return 'completed';
  if (value.includes('partial')) return 'partial';
  if (value.includes('cancel') || value.includes('refund')) return 'canceled';
  if (value.includes('fail') || value.includes('reject') || value.includes('error')) return 'failed';
  if (value.includes('progress') || value.includes('process')) return 'in_progress';
  if (value.includes('pending') || value.includes('wait') || value.includes('queue')) return 'pending';
  return 'pending';
}

const providerStatus = String(firstPresent(['status', 'Status', 'state', 'State']) || '').trim();
const rawError = firstPresent(['error', 'Error']);
// message counts as an error only when there is no status at all.
const messageWithoutStatus = !providerStatus ? firstPresent(['message', 'Message']) : null;
const errorMessage = rawError || messageWithoutStatus;
const normalizedStatus = normalize(providerStatus, Boolean(errorMessage));
const isFinal = ['completed', 'partial', 'canceled', 'failed'].includes(normalizedStatus);
const remains = toInteger(firstPresent(['remains', 'Remains']));
const kind = order.order_type === 'comments' ? 'comments' : 'likes';

// Each product keeps its own notice wording; every value is HTML-escaped and
// all three bots send with parse_mode HTML.
let lines;
if (order.product === 'ig') {
  const LABEL = { completed: 'Completed', partial: 'Partial', canceled: 'Canceled', failed: 'Failed', in_progress: 'In progress', pending: 'Pending' };
  lines = ['<b>IG Monitor Order Update</b>', '',
    'Order ID: <code>' + esc(order.provider_order_id) + '</code>',
    'Type: ' + (kind === 'comments' ? 'Comments' : 'Likes'),
    'Post ID: <code>' + esc(order.post_ref) + '</code>',
    'Ordered: ' + esc(order.quantity),
    'Status: ' + LABEL[normalizedStatus]];
  if (remains !== null && remains > 0) lines.push('Not delivered: ' + esc(remains));
  if (errorMessage) lines.push('Provider said: ' + esc(errorMessage));
} else if (order.product === 'fb') {
  lines = ['Your ' + kind + ' order has finished.', '',
    'Order ID: ' + esc(order.provider_order_id),
    'Post: ' + esc(order.post_ref),
    'Ordered: ' + esc(order.quantity),
    'Final status: ' + esc(normalizedStatus)];
  if (remains !== null && remains > 0) lines.push('Not delivered: ' + esc(remains));
  if (errorMessage) lines.push('Provider said: ' + esc(errorMessage));
} else {
  lines = ['Order status update', '',
    'Order ID: ' + esc(order.provider_order_id),
    'Type: ' + esc(order.order_type),
    'Post: ' + esc(order.post_ref),
    'Status: ' + esc(normalizedStatus),
    'Remains: ' + esc(remains === null ? 'unknown' : remains)];
}

return {
  json: {
    product: order.product,
    order_id: order.id,
    provider_order_id: order.provider_order_id,
    previous_normalized_status: order.previous_normalized_status,
    provider_status: providerStatus || (errorMessage ? 'Error' : 'Pending'),
    normalized_status: normalizedStatus,
    status_response: response,
    charge: toNumber(firstPresent(['charge', 'Charge'])),
    start_count: toInteger(firstPresent(['start_count', 'startCount', 'Start count', 'Start Count'])),
    remains: remains,
    currency: firstPresent(['currency', 'Currency']) ? String(firstPresent(['currency', 'Currency'])) : null,
    last_error: errorMessage ? String(errorMessage) : null,
    is_final: isFinal,
    notice_text: lines.join('\\n')
  }
};`;

const normalizeStatus = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Provider Status',
    position: [1120, 0],
    parameters: { mode: 'runOnceForEachItem', language: 'javaScript', jsCode: normalizeCode }
  }
});

const recordPoll = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Record Order Poll',
    position: [1344, 0],
    credentials: PG,
    parameters: {
      operation: 'executeQuery',
      query: `-- record_order_poll() writes to the right table: COALESCEs charge and
-- friends, freezes next_check_at once final, otherwise backs off
-- 15m/30m/1h/2h/4h by poll_attempts, and for X mirrors onto Posts.status.
select * from public.record_order_poll($1, $2::uuid, $3, $4, $5::jsonb, $6::numeric, $7::integer, $8::integer, $9, $10);`,
      options: {
        queryBatching: 'independently',
        queryReplacement: expr('{{ [$json.product, $json.order_id, $json.provider_status, $json.normalized_status, JSON.stringify($json.status_response), $json.charge, $json.start_count, $json.remains, $json.currency, $json.last_error] }}')
      }
    }
  }
});

const ifFinal = ifElse({
  version: 2.2,
  config: {
    name: 'If Final And Unnotified',
    position: [1568, 0],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: 'final-and-unnotified', leftValue: expr("{{ $('Normalize Provider Status').item.json.is_final && !$json.notified_at && !!$json.telegram_chat_id }}"), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const routeProduct = switchCase({
  version: 3.2,
  config: {
    name: 'Route By Product',
    position: [1792, 0],
    parameters: {
      rules: {
        values: [
          { outputKey: 'x', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.product }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'x' }], combinator: 'and' } },
          { outputKey: 'fb', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.product }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'fb' }], combinator: 'and' } },
          { outputKey: 'ig', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.product }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'ig' }], combinator: 'and' } }
        ]
      },
      options: {}
    }
  }
});

// One send node per bot: the notice must reach the chat the order came from.
const sendX = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Send X Notice',
    position: [2016, -200],
    onError: 'continueRegularOutput',
    credentials: { telegramApi: { id: '1PkKyBUkopLzyBuI', name: 'Testing Telegram API' } },
    parameters: {
      chatId: expr('{{ $json.telegram_chat_id }}'),
      text: expr("{{ $('Normalize Provider Status').item.json.notice_text }}"),
      additionalFields: { appendAttribution: false, parse_mode: 'HTML', disable_web_page_preview: true }
    }
  }
});

const sendFb = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Send FB Notice',
    position: [2016, 0],
    onError: 'continueRegularOutput',
    credentials: { telegramApi: { id: 'mVtQwhQMoZHa0lIy', name: 'FB Monitor Staging Telegram' } },
    parameters: {
      chatId: expr('{{ $json.telegram_chat_id }}'),
      text: expr("{{ $('Normalize Provider Status').item.json.notice_text }}"),
      additionalFields: { appendAttribution: false, parse_mode: 'HTML', disable_web_page_preview: true }
    }
  }
});

const sendIg = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Send IG Notice',
    position: [2016, 200],
    onError: 'continueRegularOutput',
    credentials: { telegramApi: { id: 'dpa0LnV02vd1SmRV', name: 'IG Monitor Telegram' } },
    parameters: {
      chatId: expr('{{ $json.telegram_chat_id }}'),
      text: expr("{{ $('Normalize Provider Status').item.json.notice_text }}"),
      additionalFields: { appendAttribution: false, parse_mode: 'HTML', disable_web_page_preview: true }
    }
  }
});

// The sends carry onError: continueRegularOutput, so a failed send arrives here
// as {error}. Only a clean send reaches the stamp; a failed one leaves
// notified_at NULL and the order is retried on the next run.
const ifSent = ifElse({
  version: 2.2,
  config: {
    name: 'If Notification Sent',
    position: [2240, 0],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: 'sent-ok', leftValue: expr('{{ !$json.error }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const markSent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Mark Order Notification Sent',
    position: [2464, 0],
    credentials: PG,
    parameters: {
      operation: 'executeQuery',
      query: `-- Stamps with AND notified_at IS NULL inside the function, so two racing
-- runs can only stamp once.
select public.mark_order_notified($1, $2::uuid) as notified_at;`,
      options: {
        queryBatching: 'independently',
        queryReplacement: expr("{{ [$('Record Order Poll').item.json.product, $('Record Order Poll').item.json.id] }}")
      }
    }
  }
});

const notify = ifFinal.onTrue(
  routeProduct
    .onCase(0, sendX.to(ifSent.onTrue(markSent)))
    .onCase(1, sendFb.to(ifSent))
    .onCase(2, sendIg.to(ifSent))
);

const pollChain = fetchDue.to(checkStatus.to(normalizeStatus.to(recordPoll.to(notify))));

export default workflow('orders-order-status-poll-staging', 'Orders - Order Status Poll (Staging)')
  .add(webhook)
  .to(verifySecret)
  .to(ifAuthorized.onTrue(pollChain).onFalse(reject));
