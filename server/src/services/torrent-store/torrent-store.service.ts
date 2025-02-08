import { stat, rm } from 'fs/promises';
import WebTorrent from 'webtorrent';
import { globSync } from 'glob';
import type { TorrentSourceManager } from '../torrent-source';
import type { TorrentStoreStats } from './types';
import { formatBytes } from '@/utils/bytes';
import { env } from '@/env';

type TorrentFilePath = string;
type InfoHash = string;

export class TorrentStoreService {
  constructor(private torrentSource: TorrentSourceManager) {}

  private torrentFilePaths = new Map<InfoHash, TorrentFilePath>();
  // Cache download paths to avoid repetitive filesystem checks.
  private downloadPathCache = new Map<string, string>();
  private client = new WebTorrent({
    dht: false,
    webSeeds: false,
  });

  public addTorrent(torrentFilePath: string): Promise<WebTorrent.Torrent> {
    return new Promise<WebTorrent.Torrent>((resolve, reject) => {
      const torrent = this.client.add(
        torrentFilePath,
        {
          path: env.DOWNLOADS_DIR,
          deselect: true,
          storeCacheSlots: 0,
        },
        (torrent) => {
          console.log(`Torrent ${torrent.name} - ${torrent.infoHash} verified and added.`);
          this.torrentFilePaths.set(torrent.infoHash, torrentFilePath);
          resolve(torrent);
        },
      );
      torrent.on('error', reject);
    });
  }

  public async getTorrent(infoHash: InfoHash) {
    return this.client.get(infoHash);
  }

  // Asynchronously obtain and cache the torrent download path.
  private async getTorrentDownloadPath(torrent: WebTorrent.Torrent): Promise<string | undefined> {
    const key = torrent.infoHash;
    if (this.downloadPathCache.has(key)) return this.downloadPathCache.get(key);

    const pathWithInfoHash = `${env.DOWNLOADS_DIR}/${torrent.name} - ${torrent.infoHash.slice(0, 8)}`;
    const pathWithoutInfoHash = `${env.DOWNLOADS_DIR}/${torrent.name}`;
    try {
      const stat1 = await stat(pathWithInfoHash);
      if (stat1.isDirectory()) {
        this.downloadPathCache.set(key, pathWithInfoHash);
        return pathWithInfoHash;
      }
    } catch {}
    try {
      const stat2 = await stat(pathWithoutInfoHash);
      if (stat2.isDirectory()) {
        this.downloadPathCache.set(key, pathWithoutInfoHash);
        return pathWithoutInfoHash;
      }
    } catch {}
    return undefined;
  }

  public async deleteTorrent(infoHash: InfoHash) {
    const torrentFilePath = this.torrentFilePaths.get(infoHash);
    const torrent = await this.getTorrent(infoHash);
    if (!torrent || !torrentFilePath) return;
    
    const torrentDownloadPath = await this.getTorrentDownloadPath(torrent);
    await this.client.remove(infoHash, { destroyStore: false });
    if (torrentDownloadPath) {
      await rm(torrentDownloadPath, { recursive: true });
      console.log(`Successfully deleted download for ${torrent.name} - ${torrent.infoHash}.`);
    }
    await rm(torrentFilePath);
    console.log(`Successfully deleted torrent file for ${torrent.name} - ${torrent.infoHash}.`);
  }

  public getStoreStats(): TorrentStoreStats[] {
    return this.client.torrents
      .map((torrent) => {
        if (!torrent.infoHash) return null;
        const totalSize = torrent.files.reduce((acc, file) => acc + file.length, 0);
        const downloadedSize = torrent.downloaded;
        return {
          hash: torrent.infoHash ?? 'no hash',
          name: torrent.name ?? 'no name',
          progress: `${((downloadedSize / totalSize) * 100).toFixed(2)}%`,
          size: formatBytes(totalSize),
          downloaded: formatBytes(downloadedSize),
        };
      })
      .filter((item): item is TorrentStoreStats => !!item);
  }

  public async loadExistingTorrents(): Promise<void> {
    console.log('Looking for torrent files...');
    const savedTorrentFilePaths = globSync(`${env.TORRENTS_DIR}/*.torrent`);
    console.log(`Found ${savedTorrentFilePaths.length} torrent files.`);
    await Promise.allSettled(savedTorrentFilePaths.map((filePath) => this.addTorrent(filePath)));
    console.log('Torrent files loaded and verified.');
  }

  public async deleteUnnecessaryTorrents() {
    console.log('Gathering unnecessary torrents...');
    const deletableInfoHashes = await this.torrentSource.getRemovableInfoHashes();
    console.log(`Found ${deletableInfoHashes.length} deletable torrents.`);
    await Promise.all(
      deletableInfoHashes.map(async (infoHash) => {
        const torrent = await this.getTorrent(infoHash);
        if (torrent) {
          await this.deleteTorrent(infoHash);
          console.log(`Successfully deleted ${torrent.name} - ${torrent.infoHash}.`);
        }
      }),
    );
  }
}
