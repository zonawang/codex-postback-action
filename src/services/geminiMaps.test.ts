import assert from 'node:assert/strict';
import test from 'node:test';

process.env.LINE_CHANNEL_SECRET = 'test-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';
process.env.GEMINI_API_KEY = 'test-key';

const { geminiMapsInternals } = await import('./geminiMaps.js');

test('collectText extracts nested interaction text', () => {
  const interaction = {
    outputs: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: 'Cafe recommendation' }]
      }
    ]
  };

  assert.deepEqual(geminiMapsInternals.collectText(interaction), [
    'Cafe recommendation'
  ]);
});

test('collectSources deduplicates Google Maps URLs', () => {
  const interaction = {
    outputs: [
      {
        content: [
          {
            annotations: [
              {
                source: {
                  title: 'Cafe A',
                  uri: 'https://maps.google.com/example-a'
                }
              },
              {
                source: {
                  title: 'Cafe A duplicate',
                  uri: 'https://maps.google.com/example-a'
                }
              }
            ]
          }
        ]
      }
    ]
  };

  assert.deepEqual(geminiMapsInternals.collectSources(interaction), [
    {
      title: 'Cafe A',
      uri: 'https://maps.google.com/example-a'
    }
  ]);
});

