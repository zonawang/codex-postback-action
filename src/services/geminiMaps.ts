import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';

import { env } from '../utils/env.js';
import { logger } from '../utils/logger.js';

export type MapsSource = {
  title: string;
  uri: string;
};

export type CafeSearchResult = {
  summary: string;
  sources: MapsSource[];
};

const ai = new GoogleGenAI({
  enterprise: true,
  project: env.GOOGLE_CLOUD_PROJECT,
  location: env.GOOGLE_CLOUD_LOCATION,
  apiVersion: 'v1'
});

function collectSources(response: GenerateContentResponse): MapsSource[] {
  const sources =
    response.candidates?.flatMap((candidate) =>
      (candidate.groundingMetadata?.groundingChunks ?? []).flatMap((chunk) => {
        const maps = chunk.maps;

        if (!maps?.uri || !/^https:\/\//u.test(maps.uri)) {
          return [];
        }

        return [
          {
            title: maps.title?.trim() || 'Google Maps 地點',
            uri: maps.uri
          }
        ];
      })
    ) ?? [];

  const uniqueSources = new Map<string, MapsSource>();

  sources.forEach((source) => {
    if (!uniqueSources.has(source.uri)) {
      uniqueSources.set(source.uri, source);
    }
  });

  return Array.from(uniqueSources.values()).slice(0, 5);
}

function cleanSummary(text: string): string {
  return text.replace(/\n{3,}/gu, '\n\n').trim().slice(0, 3500);
}

async function translateToTraditionalChinese(text: string): Promise<string> {
  try {
    const response = await ai.models.generateContent({
      model: env.GEMINI_TRANSLATION_MODEL,
      contents: [
        'Translate the following grounded cafe recommendations into natural Traditional Chinese used in Taiwan.',
        'Preserve all place names, numbers, caveats, and factual meaning.',
        'Do not add new facts. Do not add URLs. Return only the translated recommendation text.',
        '',
        text
      ].join('\n')
    });

    return cleanSummary(response.text || text);
  } catch (error) {
    logger.error('Gemini translation failed; using English fallback', {
      error: error instanceof Error ? error.message : String(error)
    });
    return cleanSummary(text);
  }
}

export async function findNearbyCafes(
  latitude: number,
  longitude: number
): Promise<CafeSearchResult> {
  const response = await ai.models.generateContent({
    model: env.GEMINI_MAPS_MODEL,
    contents: [
      'Find 3 to 5 good cafes near the supplied user location.',
      'Prioritize places that are practical for sitting down with a laptop.',
      'For each recommendation, state the exact place name, why it is a good choice, and any useful factual details available from Google Maps.',
      'Do not invent outlet, Wi-Fi, time-limit, or noise information when it is unavailable.',
      'Keep the full answer concise and respond in English.'
    ].join(' '),
    config: {
      tools: [{ googleMaps: {} }],
      toolConfig: {
        retrievalConfig: {
          latLng: { latitude, longitude },
          languageCode: 'en_US'
        }
      }
    }
  });

  const rawText = cleanSummary(response.text || '');
  const sources = collectSources(response);

  if (!rawText) {
    throw new Error('Gemini Maps returned no recommendation text');
  }

  if (sources.length === 0) {
    throw new Error('Gemini Maps returned no Google Maps sources');
  }

  return {
    summary: await translateToTraditionalChinese(rawText),
    sources
  };
}

export const geminiMapsInternals = {
  collectSources
};
