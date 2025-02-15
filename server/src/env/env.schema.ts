import { z } from 'zod';

export const envSchema = z
  .object({
    PORT: z.coerce.number().default(4000),
    ADDON_DIR: z.string().default('/addon'),
    TORRENT_DIR: z.string().default('/downloads'),
    NCORE_USERNAME: z.string(),
    NCORE_PASSWORD: z.string(),

    TORRENTS_DIR: z.string().optional(),
    DOWNLOADS_DIR: z.string().optional(),
    NCORE_URL: z.string().url().default('https://ncore.pro'),
    CINEMETA_URL: z.string().url().default('https://v3-cinemeta.strem.io'),
  })
  .transform((env) => ({
    ...env,
    TORRENTS_DIR: env.TORRENTS_DIR ?? `${env.TORRENT_DIR}/torrents`,
    DOWNLOADS_DIR: env.DOWNLOADS_DIR ?? `${env.TORRENT_DIR}/downloads`,
  }));
