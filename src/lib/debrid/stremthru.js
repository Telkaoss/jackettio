// Status cache to avoid unnecessary API calls
const StatusCache = {
  data: {},
  set: function(hash, status) {
    this.data[hash] = {
      status: status,
      timestamp: Date.now()
    };
  },
  get: function(hash) {
    const cacheEntry = this.data[hash];
    // Cache validity duration: 5 minutes
    if (cacheEntry && (Date.now() - cacheEntry.timestamp) < 5 * 60 * 1000) {
      return cacheEntry.status;
    }
    return null;
  },
  clear: function() {
    this.data = {};
  }
};

import {createHash} from 'crypto';
import {ERROR} from './const.js';
import {wait, isVideo} from '../util.js';

export default class StremThru {

  static id = 'stremthru';
  static name = 'StremThru';
  static shortName = 'ST';
  static cacheCheckAvailable = true;
  static configFields = [
    {
      type: 'text', 
      name: 'stremthruUrl', 
      label: `StremThru URL`, 
      required: true, 
      value: 'https://stremthru.13377001.xyz'
    },
    {
      type: 'text', 
      name: 'stremthruStore', 
      label: `StremThru Store`, 
      required: true, 
      value: 'realdebrid'
    },
    {
      type: 'text', 
      name: 'debridApiKey', 
      label: `API Key`, 
      required: true
    }
  ];

  #apiKey;
  #storeType;
  #baseUrl;
  #ip;

  constructor(userConfig) {
    Object.assign(this, this.constructor);
    this.#apiKey = userConfig.debridApiKey;
    this.#storeType = userConfig.stremthruStore || 'realdebrid';
    this.#baseUrl = userConfig.stremthruUrl || 'https://stremthru.13377001.xyz';
    this.#ip = userConfig.ip || '';
    
    // Use original abbreviations for debrid services
    const debridShortNames = {
      'realdebrid': 'RD',
      'alldebrid': 'AD',
      'debridlink': 'DL',
      'premiumize': 'PM',
      'pikpak': 'PP',
      'easydebrid': 'ED',
      'offcloud': 'OC',
      'torbox': 'TB'
    };
    
    // If the store is known, use its original abbreviation, otherwise use ST
    this.shortName = debridShortNames[this.#storeType] || 'ST';
  }

  async getTorrentsCached(torrents, isValidCachedFiles) {
    if (!torrents || torrents.length === 0) {
      return [];
    }
    
    const hashList = torrents.map(torrent => torrent.infos.infoHash).filter(hash => hash);
    
    if (hashList.length === 0) {
      return [];
    }
    
    const hashGroups = [];
    for (let i = 0; i < hashList.length; i += 50) {
      hashGroups.push(hashList.slice(i, i + 50));
    }

    const cachedResults = []; // Torrents en cache à retourner
    
    // Assigner un statut à tous les torrents
    for (const group of hashGroups) {
      try {
        const magnets = group.map(hash => `magnet:?xt=urn:btih:${hash}`);
        const query = magnets.join(',');
        const res = await this.#request('GET', `/magnets/check?magnet=${encodeURIComponent(query)}&client_ip=${this.#ip}&sid=${torrents[0]?.metaInfos?.stremioId || ''}`);
        
        if (res && res.data && res.data.items) {
          for (const item of res.data.items) {
            const hash = item.hash;
            const torrent = torrents.find(t => t.infos.infoHash === hash);
            
            if (torrent) {
              // Stocker le statut dans le cache
              StatusCache.set(hash, item.status);
              
              // Stocker le statut pour tous les torrents
              torrent.status = item.status;
              
              // Pour les torrents qui sont en cache ou téléchargés,
              // les ajouter aux résultats
              if (item.status === 'cached' || item.status === 'downloaded') {
                const files = item.files.map(file => ({
                  name: file.name,
                  size: file.size
                }));

                if (files.length > 0 && isValidCachedFiles(files)) {
                  const largestFile = files.reduce((a, b) => a.size > b.size ? a : b, files[0]);
                  if (largestFile) torrent.size = largestFile.size;
                  cachedResults.push(torrent);
                }
              }
            }
          }
        }
      } catch (err) {
        console.error(`Error checking cache status: ${err.message}`);
      }
    }

    return cachedResults;
  }

  async getProgressTorrents(torrents) {
    // StremThru does not directly provide this information
    // Return an empty object for each torrent
    return torrents.reduce((progress, torrent) => {
      progress[torrent.infos.infoHash] = {
        percent: 0,
        speed: 0
      };
      return progress;
    }, {});
  }

  async getFilesFromHash(infoHash) {
    return this.getFilesFromMagnet(`magnet:?xt=urn:btih:${infoHash}`, infoHash);
  }

  async getFilesFromMagnet(magnet, infoHash) {
    try {
      // Add the magnet
      const addRes = await this.#request('POST', '/magnets', {
        body: JSON.stringify({ magnet })
      });
      
      if (!addRes || !addRes.data || !addRes.data.id) {
        console.error('Failed to add magnet');
        return { files: [], errorType: 'not_ready' }; // Retourner un objet avec le type d'erreur
      }
      
      const magnetId = addRes.data.id;
      
      // Vérifier immédiatement le statut du magnet
      try {
        const magnetInfo = await this.#request('GET', `/magnets/${magnetId}`);
        
        if (!magnetInfo || !magnetInfo.data) {
          console.error('Failed to get magnet info');
          return { files: [], errorType: 'not_ready' };
        }
        
        // Si le statut est "queued" ou autre chose que "downloaded" ou "cached",
        // renvoyer immédiatement un tableau vide
        if (magnetInfo.data.status !== 'downloaded' && magnetInfo.data.status !== 'cached') {
          console.log(`Magnet not ready, status: ${magnetInfo.data.status}`);
          return { files: [], errorType: 'not_ready' };
        }
        
        // Si nous arrivons ici, le magnet est prêt (downloaded ou cached)
        if (magnetInfo.data.files && magnetInfo.data.files.length > 0) {
          return {
            files: magnetInfo.data.files.map(file => {
              return {
                name: file.name.split('/').pop(),
                size: file.size,
                id: `${magnetId}:${file.index}`,
                url: '',
                ready: true,
                status: magnetInfo.data.status
              };
            })
          };
        } else {
          console.error('No files found in magnet');
          return { files: [], errorType: 'not_ready' };
        }
      } catch (err) {
        console.error(`Error checking magnet status: ${err.message}`);
        // Utiliser analyzeError pour déterminer le type d'erreur
        const errorType = this.constructor.analyzeError(err);
        return { files: [], errorType };
      }
    } catch (err) {
      console.error(`Error getting files from magnet: ${err.message}`);
      // Utiliser analyzeError pour déterminer le type d'erreur
      const errorType = this.constructor.analyzeError(err);
      return { files: [], errorType };
    }
  }

  async getFilesFromBuffer(buffer, infoHash) {
    try {
      // Convertir le buffer en lien magnet
      const parseTorrent = (await import('parse-torrent')).default;
      const toMagnetURI = (await import('parse-torrent')).toMagnetURI;
      
      const parsedTorrent = await parseTorrent(new Uint8Array(buffer));
      const magnet = toMagnetURI(parsedTorrent);
      
      console.log(`Converted torrent buffer to magnet: ${magnet}`);
      
      return this.getFilesFromMagnet(magnet, infoHash);
    } catch (err) {
      console.error(`Error converting torrent buffer to magnet: ${err.message}`);
      
      // Fallback to infoHash if available
      if (infoHash) {
        return this.getFilesFromHash(infoHash);
      } else {
        throw new Error('Cannot convert torrent buffer to magnet and no infoHash available');
      }
    }
  }

  async getFilesFromTorrent(torrentInfos) {
    // S'assurer que nous avons un lien magnet
    let magnet = torrentInfos.magnetUrl;
    
    // Si nous n'avons pas de lien magnet mais que nous avons un fichier torrent, le convertir
    if (!magnet && torrentInfos.torrentLocation) {
      try {
        const torrentInfosModule = await import('../torrentInfos.js');
        const torrentBuffer = await torrentInfosModule.getTorrentFile(torrentInfos);
        const parseTorrent = (await import('parse-torrent')).default;
        const toMagnetURI = (await import('parse-torrent')).toMagnetURI;
        
        const parsedTorrent = await parseTorrent(new Uint8Array(torrentBuffer));
        magnet = toMagnetURI(parsedTorrent);
        
        // Mettre à jour les infos du torrent avec le lien magnet généré
        torrentInfos.magnetUrl = magnet;
        
        console.log(`Converted torrent file to magnet: ${magnet}`);
      } catch (err) {
        console.error(`Error converting torrent to magnet: ${err.message}`);
        // Utiliser analyzeError pour déterminer le type d'erreur
        const errorType = this.constructor.analyzeError(err);
        
        // Fallback to infoHash if available
        if (torrentInfos.infoHash) {
          magnet = `magnet:?xt=urn:btih:${torrentInfos.infoHash}`;
        } else {
          return { files: [], errorType };
        }
      }
    } else if (!magnet && torrentInfos.infoHash) {
      // Si nous n'avons pas de lien magnet mais que nous avons un infoHash, créer un lien magnet basique
      magnet = `magnet:?xt=urn:btih:${torrentInfos.infoHash}`;
    }
    
    if (!magnet) {
      return { files: [], errorType: 'not_ready' };
    }
    
    const result = await this.getFilesFromMagnet(magnet, torrentInfos.infoHash);
    return result;
  }

  async getDownload(file) {
    try {
      if (!file.id || file.id === 'undefined' || !file.id.includes(':')) {
        console.error('No valid file.id available');
        return { notReady: true, errorType: 'not_ready', reason: 'No valid file.id' };
      }

      const [magnetId] = file.id.split(':');
      const magnetInfo = await this.#request('GET', `/magnets/${magnetId}`);

      if (!magnetInfo || !magnetInfo.data) {
        console.error('Failed to get magnet info');
        return { notReady: true, errorType: 'not_ready', reason: 'Failed to get magnet info' };
      }

      if (magnetInfo.data.status !== 'downloaded' && magnetInfo.data.status !== 'cached') {
        console.log(`File not ready, status: ${magnetInfo.data.status}`);
        return { notReady: true, errorType: 'not_ready', reason: `File not ready, status: ${magnetInfo.data.status}` };
      }

      const targetFile = magnetInfo.data.files.find(f => {
        const fileName = f.name.split('/').pop();
        return fileName === file.name || f.name === file.name;
      });

      if (!targetFile || !targetFile.link) {
        console.error('File not found or link not available');
        return { notReady: true, errorType: 'not_ready', reason: 'File not found or link not available' };
      }

      const linkRes = await this.#request('POST', '/link/generate', {
        body: JSON.stringify({ link: targetFile.link })
      });
      
      if (!linkRes || !linkRes.data || !linkRes.data.link) {
        console.error('Failed to generate download link');
        return { notReady: true, errorType: 'not_ready', reason: 'Failed to generate download link' };
      }
      
      return linkRes.data.link;
    } catch (err) {
      console.error(`Error getting download link: ${err.message}`);
      const errorType = this.constructor.analyzeError(err);
      return { notReady: true, errorType, reason: err.message };
    }
  }

  async getUserHash() {
    return createHash('md5').update(this.#apiKey).digest('hex');
  }

  /**
   * Check the current status of torrents
   * @param {Array} torrents - List of torrents to check
   * @returns {Promise<Object>} - An object with the statuses for each hash
   */
  async checkTorrentsStatus(torrents) {
    if (!torrents || torrents.length === 0) {
      return {};
    }
    
    const hashList = torrents.map(torrent => torrent.infos.infoHash).filter(hash => hash);
    
    if (hashList.length === 0) {
      return {};
    }
    
    const hashGroups = [];
    for (let i = 0; i < hashList.length; i += 50) {
      hashGroups.push(hashList.slice(i, i + 50));
    }

    const statusMap = {};
    
    for (const group of hashGroups) {
      try {
        const magnets = group.map(hash => `magnet:?xt=urn:btih:${hash}`);
        const query = magnets.join(',');
        const res = await this.#request('GET', `/magnets/check?magnet=${encodeURIComponent(query)}&client_ip=${this.#ip}&sid=${torrents[0]?.metaInfos?.stremioId || ''}`);
        
        if (res && res.data && res.data.items) {
          for (const item of res.data.items) {
            statusMap[item.hash] = item.status;
          }
        }
      } catch (err) {
        console.error(`Error checking torrent status: ${err.message}`);
      }
    }

    return statusMap;
  }

  async addTorrent(magnetUrl) {
    const res = await this.#request('POST', '/torrents/add', {
      body: JSON.stringify({
        magnet: magnetUrl,
        client_ip: this.#ip
      })
    });

    if (!res || !res.data || !res.data.id) {
      throw new Error('Failed to add torrent');
    }

    // Update the status in the cache - we know the status will be "queued" or "processing"
    const infoHash = magnetUrl.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();
    if (infoHash) {
      StatusCache.set(infoHash, 'queued');
    }

    return res.data;
  }

  /**
   * Initialize the statuses in the cache from a list of torrents
   * @param {Array} torrents - List of torrents
   */
  async initTorrentStatuses(torrents) {
    if (!torrents || torrents.length === 0) {
      return;
    }
    
    const hashList = torrents.map(torrent => torrent.infos.infoHash).filter(hash => hash);
    
    if (hashList.length === 0) {
      return;
    }
    
    const hashGroups = [];
    for (let i = 0; i < hashList.length; i += 50) {
      hashGroups.push(hashList.slice(i, i + 50));
    }
    
    for (const group of hashGroups) {
      try {
        const magnets = group.map(hash => `magnet:?xt=urn:btih:${hash}`);
        const query = magnets.join(',');
        const res = await this.#request('GET', `/magnets/check?magnet=${encodeURIComponent(query)}&client_ip=${this.#ip}&sid=${torrents[0]?.metaInfos?.stremioId || ''}`);
        
        if (res && res.data && res.data.items) {
          for (const item of res.data.items) {
            const hash = item.hash;
            // Store the status in the cache
            StatusCache.set(hash, item.status);
            
            // Update the corresponding torrent
            const torrent = torrents.find(t => t.infos.infoHash === hash);
            if (torrent) {
              torrent.status = item.status;
            }
          }
        }
      } catch (err) {
        console.error(`Error initializing torrent statuses: ${err.message}`);
      }
    }
  }

  async #request(method, path, opts = {}) {
    opts = Object.assign(opts, {
      method,
      headers: { 
        'accept': 'application/json',
        'content-type': 'application/json',
        'X-StremThru-Store-Name': this.#storeType,
        'X-StremThru-Store-Authorization': `Bearer ${this.#apiKey}`,
        ...opts.headers 
      }
    });

    // Options for retries in case of error
    const maxRetries = 0; // Aucune tentative de reconnexion
    const retryDelay = 1000; 
    let retryCount = 0;
    let lastError = null;

    while (retryCount <= maxRetries) {
      try {
        const fullUrl = `${this.#baseUrl}/v0/store${path}`;
        
        console.log(`StremThru API request: ${method} ${fullUrl}`);
        const response = await fetch(fullUrl, opts);
        const data = await response.json();

        // Check if the response contains an error
        if (data.error) {
          const error = new Error(`StremThru API error: ${JSON.stringify(data.error)}`);
          error.data = { error: data.error };
          throw error;
        }

        return data;
      } catch (err) {
        // Toutes les erreurs sont directement propagées
        if (err.data && err.data.error) {
          throw err;
        }
        
        // Formater les erreurs non formatées
        console.error(`StremThru request error: ${err.message}`);
        const formattedError = new Error(`StremThru request error: ${err.message}`);
        formattedError.originalError = err;
        throw formattedError;
      }
    }

    // Si on arrive ici, toutes les tentatives ont échoué
    if (lastError) {
      console.error(`StremThru request failed after ${maxRetries} retries: ${lastError.message}`);
      throw lastError;
    }
  }

  // Convert a StremThru status to the corresponding icon
  static getStatusIcon(status) {
    const statusIcons = {
      'cached': '⚡', // yellow lightning bolt for cached files
      'queued': '⏳', // hourglass for queued files
      'downloading': '⏬', // download in progress
      'processing': '⚙️', // processing in progress
      'downloaded': '✅', // download complete
      'uploading': '⏫', // upload in progress
      'failed': '❌', // failed
      'invalid': '⛔', // invalid
      'unknown': '❓', // unknown status
    };
    
    return statusIcons[status] || '❓'; // question mark by default
  }

  /**
   * Set the status of a torrent in the cache
   * @param {string} hash - Hash of the torrent
   * @param {string} status - Status to set
   */
  static setStatus(hash, status) {
    if (hash) {
      StatusCache.set(hash, status);
    }
  }

  /**
   * Get the status of a torrent from the cache
   * @param {string} hash - Hash of the torrent
   * @returns {string|null} - The status or null if not found
   */
  static getStatus(hash) {
    return hash ? StatusCache.get(hash) : null;
  }

  /**
   * Analyze an error from StremThru API and determine which error video to show
   * @param {Error} error - The error object
   * @returns {string} - The error type to use for selecting the appropriate video
   */
  static analyzeError(error) {
    if (!error) return 'error';
    
    // Check if it's a StremThru API error
    if (error.data && error.data.error) {
      const apiError = error.data.error;
      
      // Check for authentication errors
      if (apiError.code === 'FORBIDDEN') {
        // Check for two-factor authentication
        if (apiError.message && (
            apiError.message.includes('new location') || 
            apiError.message.includes('new device') || 
            apiError.message.includes('email has been sent')
          )) {
          return 'two_factor_auth';
        }
        
        // Check for expired API key
        if (apiError.message && (
            apiError.message.includes('expired') || 
            apiError.message.includes('invalid token')
          )) {
          return 'expired_api_key';
        }
        
        // Default for other forbidden errors
        return 'access_denied';
      }
      
      // Check for premium account required
      if (apiError.code === 'PAYMENT_REQUIRED' || 
          (apiError.message && apiError.message.includes('premium'))) {
        return 'not_premium';
      }
      
      // Check for invalid API key
      if (apiError.code === 'UNAUTHORIZED' || 
          apiError.code === 'INVALID_CREDENTIALS' ||
          (apiError.message && apiError.message.includes('invalid key'))) {
        return 'access_denied';
      }
    }
    
    // Check the error message for specific patterns
    const errorMsg = error.message || '';
    
    if (errorMsg.includes('premium') || errorMsg.includes('subscription')) {
      return 'not_premium';
    }
    
    if (errorMsg.includes('expired') || errorMsg.includes('invalid token')) {
      return 'expired_api_key';
    }
    
    if (errorMsg.includes('email has been sent') || 
        errorMsg.includes('verification') || 
        errorMsg.includes('two factor') || 
        errorMsg.includes('2FA')) {
      return 'two_factor_auth';
    }
    
    if (errorMsg.includes('invalid key') || 
        errorMsg.includes('unauthorized') || 
        errorMsg.includes('access denied')) {
      return 'access_denied';
    }
    
    // Default to not_ready for other errors
    return 'not_ready';
  }
}
