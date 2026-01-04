import {createHash} from 'crypto';
import {ERROR} from './const.js';
import {wait} from '../util.js';

export default class AllDebrid {

  static id = 'alldebrid';
  static name = 'AllDebrid';
  static shortName = 'AD';
  static cacheCheckAvailable = false;
  static configFields = [
    {
      type: 'text', 
      name: 'debridApiKey', 
      label: `AllDebrid API Key`, 
      required: true, 
      href: {value: 'https://alldebrid.com/apikeys', label:'Get API Key Here'}
    }
  ];

  #apiKey;
  #ip;

  constructor(userConfig) {
    Object.assign(this, this.constructor);
    this.#apiKey = userConfig.debridApiKey;
    this.#ip = userConfig.ip || '';
  }

  async getTorrentsCached(torrents){
    return [];
  }

  async getProgressTorrents(torrents){
    const res = await this.#request('GET', '.1/magnet/status');
    return res.data.magnets.reduce((progress, magnet) => {
      progress[magnet.hash] = {
        percent: magnet.processingPerc || 0,
        speed: magnet.downloadSpeed || 0
      }
      return progress;
    }, {});
  }

  async getFilesFromHash(infoHash){
    return this.getFilesFromMagnet(infoHash, infoHash);
  }

  async getFilesFromMagnet(url, infoHash){
    const body = new FormData();
    body.append('magnets[]', url);
    const res = await this.#request('POST', `/magnet/upload`, {body});
    const magnet = res.data.magnets[0] || res.data.magnets;
    return this.#getFilesFromTorrent(magnet.id);
  }

  async getFilesFromBuffer(buffer, infoHash){
    const body = new FormData();
    body.append('files[0]', new Blob([buffer]), 'file.torrent');
    const res = await this.#request('POST', `/magnet/upload/file`, {body});
    const file = res.data.files[0] || res.data.files;
    return this.#getFilesFromTorrent(file.id);
  }

  async getDownload(file){
    const body = new FormData();
    body.append('link', file.url);
    const res = await this.#request('POST', '/link/unlock', {body});
    return res.data.link;
  }

  async getUserHash(){
    return createHash('md5').update(this.#apiKey).digest('hex');
  }

  async #getFilesFromTorrent(id){

    const query = {id};
    let torrent = (await this.#request('GET', '.1/magnet/status', {query})).data.magnets;

    console.log(`Torrent ${id} status:`, torrent.status, 'statusCode:', torrent.statusCode);
    
    if(torrent.status != 'Ready'){
      throw new Error(ERROR.NOT_READY);
    }

    const body = new FormData();
    body.append('id[]', id);
    const filesRes = await this.#request('POST', '/magnet/files', {body});
    const magnetFiles = filesRes.data.magnets[0] || filesRes.data.magnets;

    // Flatten the file tree structure recursively
    const flattenFiles = (items, path = '') => {
      const files = [];
      for (const item of items) {
        if (item.e) {
          // It's a folder, recurse into it
          files.push(...flattenFiles(item.e, path ? `${path}/${item.n}` : item.n));
        } else if (item.l) {
          // It's a file
          files.push({
            name: path ? `${path}/${item.n}` : item.n,
            size: item.s,
            url: item.l
          });
        }
      }
      return files;
    };

    const allFiles = flattenFiles(magnetFiles.files);

    return allFiles.map((file, index) => {
      return {
        name: file.name,
        size: file.size,
        id: `${torrent.id}:${index}`,
        url: file.url,
        ready: true
      };
    });

  }

  async #request(method, path, opts){

    opts = opts || {};
    opts = Object.assign(opts, {
      method,
      headers: Object.assign({
        'user-agent': 'jackettio',
        'accept': 'application/json',
        'authorization': `Bearer ${this.#apiKey}`
      }, opts.headers || {}),
      query: Object.assign({
        'agent': 'jackettio',
        'ip': this.#ip
      }, opts.query || {})
    });

    const url = `https://api.alldebrid.com/v4${path}?${new URLSearchParams(opts.query).toString()}`;
    const res = await fetch(url, opts);
    const data = await res.json();

    if(data.status != 'success'){
      console.log(data);
      switch(data.error.code || ''){
        case 'AUTH_BAD_APIKEY':
        case 'AUTH_MISSING_APIKEY':
          throw new Error(ERROR.EXPIRED_API_KEY);
        case 'AUTH_BLOCKED':
          throw new Error(ERROR.TWO_FACTOR_AUTH);
        case 'MAGNET_MUST_BE_PREMIUM':
        case 'FREE_TRIAL_LIMIT_REACHED':
        case 'MUST_BE_PREMIUM':
          throw new Error(ERROR.NOT_PREMIUM);
        default:
          throw new Error(`Invalid AD api result: ${JSON.stringify(data)}`);
      }
    }

    return data;

  }

}