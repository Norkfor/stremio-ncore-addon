import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import mime from 'mime';
import path from 'path';
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
  // In-memory cache for MIME lookups.
  private mimeCache = new Map<string, string>();

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
      throw new HTTPException(HttpStatusCode.BAD_REQUEST, { message: result.error.message });
    }
    const { imdbId, type, episode, season, deviceToken } = result.data;

    // Run independent async operations in parallel.
    const [user, torrents] = await Promise.all([
      this.userService.getUserByDeviceTokenOrThrow(deviceToken),
      this.torrentSource.getTorrentsForImdbId({ imdbId, type, season, episode }),
    ]);

    const orderedTorrents = await this.streamService.orderTorrents({ torrents, season, episode, user });

    // Map each torrent to a stream conversion.
    const streams = orderedTorrents.map((torrent, i) =>
      this.streamService.convertTorrentToStream({
        torrent,
        isRecommended: i === 0,
        deviceToken,
        season,
        episode,
      })
    );
    return c.json({ streams });
  }

  public async play(c: Context) {
    const params = c.req.param();
    const result = playSchema.safeParse(params);
    if (!result.success) {
      throw new HTTPException(HttpStatusCode.BAD_REQUEST, { message: result.error.message });
    }
    const { sourceName, sourceId, infoHash, fileIdx } = result.data;

    let torrent = await this.torrentStoreService.getTorrent(infoHash);
    if (!torrent) {
      const torrentUrl = await this.torrentSource.getTorrentUrlBySourceId({ sourceId, sourceName });
      if (!torrentUrl) {
        throw new HTTPException(HttpStatusCode.NOT_FOUND, { message: 'Torrent not found' });
      }
      const torrentFilePath = await this.torrentService.downloadTorrentFile(torrentUrl);
      torrent = await this.torrentStoreService.addTorrent(torrentFilePath);
    }

    const index = Number(fileIdx);
    if (index < 0 || index >= torrent.files.length) {
      throw new HTTPException(HttpStatusCode.BAD_REQUEST, { message: 'Invalid file index' });
    }
    const file = torrent.files[index];

    // Get MIME type from file extension.
    const ext = path.extname(file.path);
    let fileType = this.mimeCache.get(ext);
    if (!fileType) {
      fileType = mime.getType(file.path) || 'application/octet-stream';
      this.mimeCache.set(ext, fileType);
    }

    if (c.req.method === 'HEAD') {
      return c.body(null, 200, {
        'Content-Length': `${file.length}`,
        'Content-Type': fileType,
      });
    }

    // Parse the Range header.
    const range = parseRangeHeader(c.req.header('range'), file.length);
    if (!range) {
      return c.body(null, 416, { 'Content-Range': `bytes */${file.length}` });
    }
    let { start, end } = range;

    // For an initial request (starting at 0), extend the range to at least MIN_INITIAL_CHUNK_SIZE.
    const MIN_INITIAL_CHUNK_SIZE = 1 * 1024 * 1024; // 10 MB
    if (start === 0) {
      const currentSize = end - start + 1;
      if (currentSize < MIN_INITIAL_CHUNK_SIZE) {
        end = Math.min(file.length - 1, start + MIN_INITIAL_CHUNK_SIZE - 1);
      }
    }
    // For resumed playback (start > 0), prioritize a larger block.
    else if (torrent.pieceLength) {
      const FAST_START_CHUNK_SIZE = 2 * 1024 * 1024; // 30 MB
      this.torrentStoreService.prioritizeFileDownload(torrent, index, start, FAST_START_CHUNK_SIZE);
    }

    // Create a stream for the determined byte range.
    const stream = file.stream({ start, end });
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${file.length}`,
        'Content-Length': `${end - start + 1}`,
        'Content-Type': fileType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=604800',
      },
    });
  }
}
