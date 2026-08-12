import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function port(): number {
  const value = Number(process.env.PORT ?? 3000);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('PORT must be a positive integer');
  }

  return value;
}

export const env = {
  PORT: port(),
  LINE_CHANNEL_SECRET: required('LINE_CHANNEL_SECRET'),
  LINE_CHANNEL_ACCESS_TOKEN: required('LINE_CHANNEL_ACCESS_TOKEN'),
  GOOGLE_CLOUD_PROJECT: required('GOOGLE_CLOUD_PROJECT'),
  GOOGLE_CLOUD_LOCATION:
    process.env.GOOGLE_CLOUD_LOCATION?.trim() || 'global',
  GEMINI_MAPS_MODEL: process.env.GEMINI_MAPS_MODEL?.trim() || 'gemini-2.5-flash',
  GEMINI_TRANSLATION_MODEL:
    process.env.GEMINI_TRANSLATION_MODEL?.trim() || 'gemini-2.5-flash'
};
