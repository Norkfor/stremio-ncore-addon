// src/controllers/stream.controller.ts
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import mime from 'mime';
import { streamQuerySchema } from '@/schemas/stream.schema';
import type { TorrentService } from '@/services/torrent';
import type { StreamService } from '@/services/stream';
import type { UserService } from '@/services/user';
import type { TorrentStoreService } from '@/services/torrent-store';
import { playSchema } from '@/schemas/play.schema';
import { parseRangeHeader } from '@/utils/parse-range-header';
import { HttpStatusCode } from '@/types/http';
import type { TorrentSourceManager } from '@/services/torrent-source';

export class StreamController {
  constructor(
    private torrentSource: TorrentSourceManager,
    private torrentService: TorrentService,
    private streamService: StreamService,
    private userService: UserService,
    private torrentStoreService: TorrentStoreService,
  ) {}

  public async getStreamsForMedia(c: Context) {
    const params = c.req.param();
    const result = streamQuerySchema.safeParse(params);
    if (!result.success) {
      throw new HTTPException(HttpStatusCode.BAD_REQUEST, {
        message: result.error.message,
      });
    }
    const { imdbId, type, episode, season, deviceToken } = result.data;

    // Original working code with cached user lookup
    const user = await this.userService.getUserByDeviceTokenOrThrow(deviceToken);

    // Parallel torrent fetching (existing implementation)
    const torrents = await this.torrentSource.getTorrentsForImdbId({
      imdbId,
      type,
      season,
      episode,
    });

    // Existing ordering logic
    const orderedTorrents = await this.streamService.orderTorrents({
      torrents,
      season,
      episode,
      user,
    });

    // Original stream conversion
    const streams = orderedTorrents.map((torrent, i) =>
      this.streamService.convertTorrentToStream({
        torrent,
        isRecommended: i === 0,
        deviceToken,
        season,
        episode,
      }),
    );

    return c.json({ streams });
  }

  public async play(c: Context) {
    const params = c.req.param();
    const result = playSchema.safeParse(params);
    if (!result.success) {
      throw new HTTPException(HttpStatusCode.BAD_REQUEST, {
        message: result.error.message,
      });
    }
    const { sourceName, sourceId, infoHash, fileIdx } = result.data;

    // Existing torrent cache implementation
    let torrent = await this.torrentStoreService.getTorrent(infoHash);

    if (!torrent) {
      const torrentUrl = await this.torrentSource.getTorrentUrlBySourceId({
        sourceId,
        sourceName,
      });
      if (!torrentUrl) {
        throw new HTTPException(HttpStatusCode.NOT_FOUND, {
          message: 'Torrent not found',
        });
      }
      
      // Original torrent download logic
      const torrentFilePath = await this.torrentService.downloadTorrentFile(torrentUrl);
      torrent = await this.torrentStoreService.addTorrent(torrentFilePath);
    }

    // Safe file index validation
    const index = Number(fileIdx);
    if (index < 0 || index >= torrent.files.length) {
      throw new HTTPException(HttpStatusCode.BAD_REQUEST, {
        message: 'Invalid file index',
      });
    }

    const file = torrent.files[index];
    const fileType = mime.getType(file.path) || 'application/octet-stream';

    // Original HEAD request handling
    if (c.req.method === 'HEAD') {
      return c.body(null, 200, {
        'Content-Length': `${file.length}`,
        'Content-Type': fileType,
      });
    }

    // Range parsing from original code
    const range = parseRangeHeader(c.req.header('range'), file.length);
    if (!range) {
      return c.body(null, 416, {
        'Content-Range': `bytes */${file.length}`,
      });
    }

    const { start, end } = range;
    
    // Optimized streaming with proper typing
    const stream = file.stream({ start, end });
    
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${file.length}`,
        'Content-Length': `${end - start + 1}`,
        'Content-Type': fileType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=604800', // Safe cache header
      },
    });
  }
}