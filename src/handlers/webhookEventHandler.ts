import type { WebhookEvent, messagingApi } from '@line/bot-sdk';

import {
  createCafeResultMessages,
  createWelcomeMessage
} from '../messages/cafeMessages.js';
import { findNearbyCafes } from '../services/geminiMaps.js';
import { lineClient } from '../services/lineClient.js';
import { logger } from '../utils/logger.js';

async function reply(replyToken: string, messages: messagingApi.Message[]) {
  await lineClient.replyMessage({ replyToken, messages });
}

function getTargetId(event: WebhookEvent): string | undefined {
  if (event.source.type === 'user') {
    return event.source.userId;
  }

  if (event.source.type === 'group') {
    return event.source.groupId;
  }

  if (event.source.type === 'room') {
    return event.source.roomId;
  }

  return undefined;
}

export async function handleWebhookEvent(event: WebhookEvent): Promise<void> {
  logger.info('Webhook event received', {
    eventType: event.type,
    webhookEventId: event.webhookEventId
  });

  if (event.type !== 'message') {
    return;
  }

  if (event.message.type === 'text') {
    await reply(event.replyToken, [createWelcomeMessage()]);
    return;
  }

  if (event.message.type !== 'location') {
    return;
  }

  const startedAt = Date.now();
  const targetId = getTargetId(event);

  if (targetId) {
    try {
      await lineClient.showLoadingAnimation({
        chatId: targetId,
        loadingSeconds: 60
      });
    } catch (error) {
      logger.error('Loading animation failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  logger.info('Cafe search started', {
    webhookEventId: event.webhookEventId
  });

  try {
    const result = await findNearbyCafes(
      event.message.latitude,
      event.message.longitude
    );

    const messages = createCafeResultMessages(result);

    if (targetId) {
      await lineClient.pushMessage({ to: targetId, messages });
    } else {
      await reply(event.replyToken, messages);
    }

    logger.info('Cafe search reply sent', {
      webhookEventId: event.webhookEventId,
      sourceCount: result.sources.length,
      elapsedMs: Date.now() - startedAt
    });
  } catch (error) {
    logger.error('Cafe search failed', {
      error: error instanceof Error ? error.message : String(error),
      webhookEventId: event.webhookEventId,
      elapsedMs: Date.now() - startedAt
    });

    const messages: messagingApi.Message[] = [
      {
        type: 'text',
        text: '目前無法取得附近咖啡廳，請稍後再傳一次位置。',
        quickReply: {
          items: [
            {
              type: 'action',
              action: {
                type: 'location',
                label: '重新傳送位置'
              }
            }
          ]
        }
      }
    ];

    if (targetId) {
      await lineClient.pushMessage({ to: targetId, messages });
    } else {
      await reply(event.replyToken, messages);
    }
  }
}
