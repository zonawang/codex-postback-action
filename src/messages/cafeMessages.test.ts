import assert from 'node:assert/strict';
import test from 'node:test';

import { createCafeResultMessages } from './cafeMessages.js';

const result = {
  summary: '測試推薦',
  sources: [
    {
      title: 'Cafe A',
      uri: 'https://maps.google.com/cafe-a'
    }
  ]
};

test('adds postback actions when a search session is available', () => {
  const messages = createCafeResultMessages(result, 'session_123');
  const flex = messages[1];

  assert.equal(flex?.type, 'flex');
  if (flex?.type !== 'flex') return;

  assert.deepEqual(
    (flex.quickReply?.items ?? []).flatMap((item) =>
      item.action ? [item.action.type] : []
    ),
    ['postback', 'postback', 'location']
  );
});

test('only offers a new location when session storage is unavailable', () => {
  const messages = createCafeResultMessages(result);
  const flex = messages[1];

  assert.equal(flex?.type, 'flex');
  if (flex?.type !== 'flex') return;

  assert.deepEqual(
    (flex.quickReply?.items ?? []).flatMap((item) =>
      item.action ? [item.action.type] : []
    ),
    ['location']
  );
});
