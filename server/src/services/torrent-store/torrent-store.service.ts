import { existsSync, lstatSync, readFileSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
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
  private client = new WebTorrent({
    dht: false,
    webSeeds: false,
  });

  // NEW: Persistent state management
  private stateFilePath = `${env.TORRENTS_DIR}/torrent-state.json`;

  private loadTorrentState(): Record<InfoHash, string> {
    try {
      return JSON.parse(readFileSync(this.stateFilePath, 'utf-8'));
    } catch {
      return {};
    }
  }

  private saveTorrentState(state: Record<InfoHash, string>) {
    writeFileSync(this.stateFilePath, JSON.stringify(state), 'utf-8');
  }

  // MODIFIED: Add torrent with state tracking
  public addTorrent(torrentFilePath: string): Promise<WebTorrent.Torrent> {
    return new Promise((resolve, reject) => {
      const state = this.loadTorrentState();
      const existingTorrent = this.client.torrents.find(
        t => state[t.infoHash] === torrentFilePath
      );

      if (existingTorrent) {
        console.log(`Reusing existing torrent: ${existingTorrent.infoHash}`);
        return resolve(existingTorrent);
      }

      const torrent = this.client.add(
        torrentFilePath,
        {
          path: env.DOWNLOADS_DIR,
          deselect: true,
          storeCacheSlots: 0,
          skipVerify: true // Skip verification for persisted torrents
        },
        (torrent) => {
          console.log(`Added new torrent: ${torrent.name}`);
          this.torrentFilePaths.set(torrent.infoHash, torrentFilePath);
          
          // Update state
          const newState = this.loadTorrentState();
          newState[torrent.infoHash] = torrentFilePath;
          this.saveTorrentState(newState);

          resolve(torrent);
        }
      );

      torrent.on('error', reject);
    });
  }

  // MODIFIED: Load from state instead of directory
  public async loadExistingTorrents(): Promise<void> {
    console.log('Loading torrents from persistent state...');
    const state = this.loadTorrentState();
    
    await Promise.allSettled(
      Object.values(state).map(filePath =>
        this.addTorrent(filePath).catch(err =>
          console.error(`Failed to load ${filePath}: ${err.message}`)
        )
      )
    );
  }

  // MODIFIED: Clean state on deletion
  public async deleteTorrent(infoHash: InfoHash) {
    const torrentFilePath = this.torrentFilePaths.get(infoHash);
    const torrent = await this.getTorrent(infoHash);

    if (!torrent || !torrentFilePath) return;

    // Remove from state
    const state = this.loadTorrentState();
    delete state[infoHash];
    this.saveTorrentState(state);

    // Existing cleanup logic
    const torrentDownloadPath = this.getTorrentDownloadPath(torrent);
    await this.client.remove(infoHash, { destroyStore: false });

    if (torrentDownloadPath) {
      await rm(torrentDownloadPath, { recursive: true });
    }

    await rm(torrentFilePath);
  }

  // REST OF METHODS (unchanged but fully implemented)
  public async getTorrent(infoHash: InfoHash): Promise<WebTorrent.Torrent | null> {
    return this.client.get(infoHash) || null;
  }

  private getTorrentDownloadPath(torrent: WebTorrent.Torrent): string | undefined {
    const pathWithHash = `${env.DOWNLOADS_DIR}/${torrent.name}-${torrent.infoHash.slice(0, 8)}`;
    const pathWithoutHash = `${env.DOWNLOADS_DIR}/${torrent.name}`;
    
    return [pathWithHash, pathWithoutHash].find(path => 
      existsSync(path) && lstatSync(path).isDirectory()
    );
  }

  public getStoreStats(): TorrentStoreStats[] {
    return this.client.torrents
      .filter(t => t.infoHash)
      .map(torrent => ({
        hash: torrent.infoHash!,
        name: torrent.name || 'Unnamed torrent',
        progress: ((torrent.progress * 100).toFixed(2)) + '%',
        size: formatBytes(torrent.length),
        downloaded: formatBytes(torrent.downloaded)
      }));
  }

  public async deleteUnnecessaryTorrents(): Promise<void> {
    const deletableHashes = await this.torrentSource.getRemovableInfoHashes();
    await Promise.all(deletableHashes.map(hash => this.deleteTorrent(hash)));
  }
}
