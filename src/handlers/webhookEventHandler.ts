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

export async function handleWebhookEvent(event: WebhookEvent): Promise<void> {
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

  try {
    const result = await findNearbyCafes(
      event.message.latitude,
      event.message.longitude
    );

    await reply(event.replyToken, createCafeResultMessages(result));
  } catch (error) {
    logger.error('Cafe search failed', {
      error: error instanceof Error ? error.message : String(error),
      latitude: event.message.latitude,
      longitude: event.message.longitude
    });

    await reply(event.replyToken, [
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
    ]);
  }
}

