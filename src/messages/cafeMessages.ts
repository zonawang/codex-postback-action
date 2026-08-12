import type { messagingApi } from '@line/bot-sdk';

import type { CafeSearchResult } from '../services/geminiMaps.js';

const LOCATION_QUICK_REPLY: messagingApi.QuickReply = {
  items: [
    {
      type: 'action',
      action: {
        type: 'location',
        label: '傳送目前位置'
      }
    }
  ]
};

export function createWelcomeMessage(): messagingApi.TextMessage {
  return {
    type: 'text',
    text: [
      '☕ 我可以用 Google Maps 資料幫你找附近咖啡廳。',
      '',
      '點下面按鈕傳送位置，我會推薦 3–5 間適合坐下來喝咖啡或使用筆電的店。'
    ].join('\n'),
    quickReply: LOCATION_QUICK_REPLY
  };
}

function createSourceBubble(
  source: CafeSearchResult['sources'][number],
  index: number
): messagingApi.FlexBubble {
  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        {
          type: 'text',
          text: `推薦 ${index + 1}`,
          size: 'xs',
          color: '#8A6D3B',
          weight: 'bold'
        },
        {
          type: 'text',
          text: source.title,
          wrap: true,
          weight: 'bold',
          size: 'lg'
        },
        {
          type: 'text',
          text: '資料來源：Google Maps',
          wrap: true,
          size: 'xs',
          color: '#777777'
        }
      ]
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#6F4E37',
          action: {
            type: 'uri',
            label: '在 Google Maps 查看',
            uri: source.uri
          }
        }
      ]
    }
  };
}

export function createCafeResultMessages(
  result: CafeSearchResult
): messagingApi.Message[] {
  const summary: messagingApi.TextMessage = {
    type: 'text',
    text: `☕ 附近咖啡廳推薦\n\n${result.summary}\n\n以下是本次回答使用的 Google Maps 來源：`
  };

  const sourceCarousel: messagingApi.FlexMessage = {
    type: 'flex',
    altText: 'Google Maps 咖啡廳來源',
    contents: {
      type: 'carousel',
      contents: result.sources.map(createSourceBubble)
    }
  };

  return [summary, sourceCarousel];
}

