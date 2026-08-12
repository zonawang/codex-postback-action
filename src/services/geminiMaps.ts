import { GoogleGenAI } from '@google/genai';

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

type UnknownRecord = Record<string, unknown>;

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null
    ? (value as UnknownRecord)
    : undefined;
}

function firstString(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function collectText(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectText);
  }

  const record = asRecord(value);

  if (!record) {
    return [];
  }

  const directText = firstString(record, ['text', 'outputText', 'output_text']);
  const nested = Object.entries(record)
    .filter(
      ([key]) =>
        ![
          'text',
          'outputText',
          'output_text',
          'annotations',
          'type',
          'role',
          'status',
          'id',
          'model'
        ].includes(key)
    )
    .flatMap(([, child]) => collectText(child));

  return directText ? [directText, ...nested] : nested;
}

function collectSources(value: unknown): MapsSource[] {
  const sources: MapsSource[] = [];

  function visit(node: unknown) {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const record = asRecord(node);

    if (!record) {
      return;
    }

    const sourceRecord =
      asRecord(record.source) ??
      asRecord(record.googleMaps) ??
      asRecord(record.google_maps) ??
      record;
    const uri = firstString(sourceRecord, ['uri', 'url']);
    const title = firstString(sourceRecord, ['title', 'name']);

    if (uri && /^https:\/\//u.test(uri)) {
      sources.push({
        title: title || 'Google Maps 地點',
        uri
      });
    }

    Object.values(record).forEach(visit);
  }

  visit(value);

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
  const interaction = await ai.interactions.create({
    model: env.GEMINI_MAPS_MODEL,
    input: [
      'Find 3 to 5 good cafes near the supplied user location.',
      'Prioritize places that are practical for sitting down with a laptop.',
      'For each recommendation, state the exact place name, why it is a good choice, and any useful factual details available from Google Maps.',
      'Do not invent outlet, Wi-Fi, time-limit, or noise information when it is unavailable.',
      'Keep the full answer concise and respond in English.'
    ].join(' '),
    tools: [
      {
        type: 'google_maps',
        latitude,
        longitude
      }
    ]
  });

  const rawText = cleanSummary(collectText(interaction).join('\n'));
  const sources = collectSources(interaction);

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
  collectSources,
  collectText
};
