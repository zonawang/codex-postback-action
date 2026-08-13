import type { messagingApi, WebhookEvent } from '@line/bot-sdk';

import { parseCafePostbackData } from '../actions/cafePostbackActions.js';
import { createCafeResultMessages } from '../messages/cafeMessages.js';
import { findNearbyCafes } from '../services/geminiMaps.js';
import { lineClient } from '../services/lineClient.js';
import {
  claimSearchSession,
  completeSearchSession,
  releaseSearchSession,
  SearchSessionError,
  type CafeSearchPreference
} from '../services/searchSessionStore.js';
import { getActorId, getConversationId } from '../utils/lineEvent.js';
import { logger } from '../utils/logger.js';

function errorText(error: unknown): string {
  if (error instanceof SearchSessionError) {
    switch (error.code) {
      case 'busy':
        return '上一個搜尋還在進行中，請稍等結果出現。';
      case 'forbidden':
        return '這個搜尋按鈕屬於其他使用者，請重新傳送你的位置。';
      case 'expired':
      case 'not_found':
        return '這次搜尋已經過期，請重新傳送位置。';
    }
  }

  return '目前無法更新咖啡廳推薦，請稍後再試一次。';
}

function retryMessage(text: string): messagingApi.TextMessage {
  return {
    type: 'text',
    text,
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
  };
}

export async function handlePostbackEvent(
  event: Extract<WebhookEvent, { type: 'postback' }>
): Promise<void> {
  const parsed = parseCafePostbackData(event.postback.data);

  if (!parsed) {
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [retryMessage('無法辨識這個操作，請重新傳送位置。')]
    });
    return;
  }

  const ownerId = getActorId(event.source);
  const conversationId = getConversationId(event.source);

  if (!ownerId || !conversationId) {
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [retryMessage('目前無法確認操作來源，請重新傳送位置。')]
    });
    return;
  }

  let sessionClaimed = false;

  try {
    const session = await claimSearchSession(
      parsed.sessionId,
      ownerId,
      conversationId
    );
    sessionClaimed = true;

    try {
      await lineClient.showLoadingAnimation({
        chatId: conversationId,
        loadingSeconds: 60
      });
    } catch (error) {
      logger.error('Postback loading animation failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    const preference: CafeSearchPreference =
      parsed.action === 'work_friendly'
        ? 'work_friendly'
        : session.preference;
    const result = await findNearbyCafes(session.latitude, session.longitude, {
      preference,
      excludeNames: session.previousCafeNames
    });

    await completeSearchSession(
      session.id,
      preference,
      result.sources.map((source) => source.title)
    );
    sessionClaimed = false;

    await lineClient.pushMessage({
      to: conversationId,
      messages: createCafeResultMessages(result, session.id)
    });

    logger.info('Cafe postback search reply sent', {
      action: parsed.action,
      sessionId: session.id,
      sourceCount: result.sources.length
    });
  } catch (error) {
    if (sessionClaimed) {
      try {
        await releaseSearchSession(parsed.sessionId);
      } catch (releaseError) {
        logger.error('Failed to release cafe search session lock', {
          error:
            releaseError instanceof Error
              ? releaseError.message
              : String(releaseError)
        });
      }
    }

    logger.error('Cafe postback search failed', {
      action: parsed.action,
      sessionId: parsed.sessionId,
      error: error instanceof Error ? error.message : String(error)
    });

    await lineClient.pushMessage({
      to: conversationId,
      messages: [retryMessage(errorText(error))]
    });
  }
}
