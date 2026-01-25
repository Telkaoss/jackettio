import pLimit from 'p-limit';
import {parseWords, numberPad, sortBy, bytesToSize, wait, promiseTimeout} from './util.js';
import config from './config.js';
import cache from './cache.js';
import { updateUserConfigWithMediaFlowIp, applyMediaflowProxyIfNeeded } from './mediaflowProxy.js';
import * as meta from './meta.js';
import * as jackett from './jackett.js';
import * as debrid from './debrid.js';
import * as torrentInfos from './torrentInfos.js';

const slowIndexers = {};

const actionInProgress = {
  getTorrents: {},
  getDownload: {}
};

// Global cache for extractMediaInfo results
const mediaInfoCache = new Map();

// Helper function to extract codec and source information from torrent name
const extractMediaInfo = (name) => {
  // Check if the result is already cached
  if (mediaInfoCache.has(name)) {
    return mediaInfoCache.get(name);
  }
  
  // Use a single pass for all regular expressions
  let codecInfo = '';
  let sourceInfo = '';
  let audioInfo = '';
  
  // Video codecs (search once)
  if (/[Hh][Ee][Vv][Cc]|[Xx]265|[Hh]\.?265/.test(name)) {
    codecInfo = 'H265';
  } else if (/[Aa][Vv][Cc]|[Xx]264|[Hh]\.?264/.test(name)) {
    codecInfo = 'H264';
  } else if (/[Aa][Vv]1/.test(name)) {
    codecInfo = 'AV1';
  }
  
  // Sources (search once)
  if (/[Rr][Ee][Mm][Uu][Xx]/.test(name)) {
    sourceInfo = 'REMUX';
  } else if (/[Bb][Ll][Uu][Rr][Aa][Yy]|[Bb][Dd][Rr][Ii][Pp]/.test(name)) {
    sourceInfo = 'BLURAY';
  } else if (/[Ww][Ee][Bb][ -._]?[Dd][Ll]/.test(name)) {
    sourceInfo = 'WEB-DL';
  } else if (/[Ww][Ee][Bb][Rr][Ii][Pp]/.test(name)) {
    sourceInfo = 'WEBRIP';
  } else if (/\b[Ww][Ee][Bb]\b/.test(name)) {
    sourceInfo = 'WEB';
  } else if (/[Hh][Dd][Tt][Vv]/.test(name)) {
    sourceInfo = 'HDTV';
  } else if (/[Dd][Vv][Dd][Rr][Ii][Pp]/.test(name)) {
    sourceInfo = 'DVDRIP';
  }
  
  // Audio (search once)
  if (/[Dd][Tt][Ss][ -._]?[Hh][Dd]/.test(name)) {
    audioInfo = 'DTS-HD';
  } else if (/[Dd][Tt][Ss][ -._]?[Xx]/.test(name)) {
    audioInfo = 'DTS:X';
  } else if (/[Aa][Tt][Mm][Oo][Ss]/.test(name)) {
    audioInfo = 'ATMOS';
  } else if (/[Tt][Rr][Uu][Ee][Hh][Dd]/.test(name)) {
    audioInfo = 'TRUEHD';
  } else if (/[Dd][Dd]\+|[Ee][-_]?[Aa][Cc][-_]?3/.test(name)) {
    audioInfo = 'DD+';
  } else if (/[Dd][Dd]/.test(name)) {
    audioInfo = 'DD';
  } else if (/[Dd][Tt][Ss]/.test(name)) {
    audioInfo = 'DTS';
  } else if (/[Aa][Aa][Cc]/.test(name)) {
    audioInfo = 'AAC';
  }
  
  const result = { codecInfo, sourceInfo, audioInfo };
  
  // Cache the result
  mediaInfoCache.set(name, result);
  
  return result;
};

function parseStremioId(stremioId){
  const [id, season, episode] = stremioId.split(':');
  return {id, season: parseInt(season || 0), episode: parseInt(episode || 0)};
}

async function getMetaInfos(type, stremioId, language){
  const {id, season, episode} = parseStremioId(stremioId);
  if(type == 'movie'){
    return meta.getMovieById(id, language);
  }else if(type == 'series'){
    return meta.getEpisodeById(id, season, episode, language);
  }else{
    throw new Error(`Unsupported type ${type}`);
  }
}

async function mergeDefaultUserConfig(userConfig){
  config.immulatableUserConfigKeys.forEach(key => delete userConfig[key]);
  userConfig = Object.assign({}, config.defaultUserConfig, userConfig);
  userConfig = await updateUserConfigWithMediaFlowIp(userConfig);
  return userConfig;
}

function priotizeItems(allItems, priotizeItems, max){
  max = max || 0;
  if(typeof(priotizeItems) == 'function'){
    priotizeItems = allItems.filter(priotizeItems);
    if(max > 0)priotizeItems.splice(max);
  }
  if(priotizeItems && priotizeItems.length){
    allItems = allItems.filter(item => !priotizeItems.find(i => i == item));
    allItems.unshift(...priotizeItems);
  }
  return allItems;
}

function searchEpisodeFile(files, season, episode){
  // Traditional formats for TV series
  return files.find(file => file.name.includes(`S${numberPad(season, 2)}E${numberPad(episode, 3)}`))
    || files.find(file => file.name.includes(`S${numberPad(season, 2)}E${numberPad(episode, 2)}`))
    || files.find(file => file.name.includes(`${season}${numberPad(episode, 2)}`))
    // Specific formats for anime
    || files.find(file => new RegExp(`\\bE(pisode)?\\s*${numberPad(episode, 2)}\\b`, 'i').test(file.name))
    || files.find(file => new RegExp(`\\bEP\\s*${numberPad(episode, 2)}\\b`, 'i').test(file.name))
    || files.find(file => new RegExp(`\\[\\s*${numberPad(episode, 2)}\\s*\\]`).test(file.name))
    || files.find(file => new RegExp(`\\s-\\s*${numberPad(episode, 2)}\\b`).test(file.name))
    // Simple format with just the episode number (use as last resort)
    || files.find(file => file.name.includes(`${numberPad(episode, 2)}`))
    || false;
}

function getSlowIndexerStats(indexerId){
  slowIndexers[indexerId] = (slowIndexers[indexerId] || []).filter(item => new Date() - item.date < config.slowIndexerWindow);
  return {
    min: Math.min(...slowIndexers[indexerId].map(item => item.duration)),
    avg: Math.round(slowIndexers[indexerId].reduce((acc, item) => acc + item.duration, 0) / slowIndexers[indexerId].length),
    max: Math.max(...slowIndexers[indexerId].map(item => item.duration)),
    count: slowIndexers[indexerId].length
  }
}

async function timeoutIndexerSearch(indexerId, promise, timeout){
  const start = new Date();
  const res = await promiseTimeout(promise, timeout).catch(err => []);
  const duration = new Date() - start;
  if(timeout > config.slowIndexerDuration){
    if(duration > config.slowIndexerDuration){
      console.log(`Slow indexer detected : ${indexerId} : ${duration}ms`);
      slowIndexers[indexerId].push({duration, date: new Date()});
    }else{
      slowIndexers[indexerId] = [];
    }
  }
  return res;
}

async function getTorrents(userConfig, metaInfos, debridInstance){

  while(actionInProgress.getTorrents[metaInfos.stremioId]){
    await wait(500);
  }
  actionInProgress.getTorrents[metaInfos.stremioId] = true;

  try {

    const {qualities, excludeKeywords, maxTorrents, sortCached, sortUncached, priotizePackTorrents, priotizeLanguages, indexerTimeoutSec} = userConfig;
    const {id, season, episode, type, stremioId, year} = metaInfos;

    let torrents = [];
    let startDate = new Date();

    const sortSearch = [['seeders', true]];
    const filterSearch = (torrent) => {
      if(!qualities.includes(torrent.quality))return false;
      const torrentWords = parseWords(torrent.name.toLowerCase());
      if(excludeKeywords.find(word => torrentWords.includes(word)))return false;
      if(type === 'series'){
        // If season is present in the name, ensure it matches the requested season
        const seasonMatch = torrent.name.match(/S(\d{1,2})/i) || torrent.name.match(/season[ ._-]?(\d{1,2})/i);
        if(seasonMatch && parseInt(seasonMatch[1]) !== season){
          return false;
        }
      }
      return true;
    };
    const filterLanguage = (torrent) => {
      if(priotizeLanguages.length == 0)return true;
      // If we cannot detect language, don't drop the torrent
      if(!torrent.languages || torrent.languages.length === 0)return true;
      return torrent.languages.find(lang => ['multi'].concat(priotizeLanguages).includes(lang.value));
    };
    const filterYear = (torrent) => {
      if (!torrent.year) {
        return true; // Always allow if no year is detected in the title
      }
      // Allow if the detected year is within the range [requested year - 1, requested year + 1]
      const delta = Math.abs(torrent.year - year);
      return delta <= 1;
    };
    const filterSlowIndexer = (indexer) => config.slowIndexerRequest <= 0 || getSlowIndexerStats(indexer.id).count < config.slowIndexerRequest;

    let indexers = (await jackett.getIndexers());
    let availableIndexers = indexers.filter(indexer => indexer.searching[type].available);
    let availableFastIndexers = availableIndexers.filter(filterSlowIndexer);
    if(availableFastIndexers.length)availableIndexers = availableFastIndexers;
    let userIndexers = availableIndexers.filter(indexer => (userConfig.indexers.includes(indexer.id) || userConfig.indexers.includes('all')));

    if(userIndexers.length){
      indexers = userIndexers;
    }else if(availableIndexers.length){
      console.log(`${stremioId} : User defined indexers "${userConfig.indexers.join(', ')}" not available, fallback to all "${type}" indexers`);
      indexers = availableIndexers;
    }else if(indexers.length){
      // console.log(`${stremioId} : User defined indexers "${userConfig.indexers.join(', ')}" or "${type}" indexers not available, fallback to all indexers`);
    }else{
      throw new Error(`${stremioId} : No indexer configured in jackett`);
    }

    console.log(`${stremioId} : ${indexers.length} indexers selected : ${indexers.map(indexer => indexer.title).join(', ')}`);

    if(type == 'movie'){

      // Search only with the primary title
      const primaryTitle = metaInfos.name;
      
      let searchPromises = [];

      // Promises for the primary title
      if (primaryTitle) {
        const primaryPromises = indexers.map(indexer => 
          timeoutIndexerSearch(
            indexer.id, 
            jackett.searchMovieTorrents({
              ...metaInfos, 
              name: primaryTitle, 
              imdbId: metaInfos.imdb_id || metaInfos.id, 
              indexer: indexer.id,
              supportedParams: indexer.searching.movie.supportedParams
            }), 
            indexerTimeoutSec*1000
          )
        );
        searchPromises.push(...primaryPromises);
      } else {
        // console.warn(`${stremioId} : Primary title (metaInfos.name) is missing, cannot search movies.`);
        // If no primary title, we can't do anything for movies
        searchPromises = []; // Ensure the list is empty
      }

      // Execute all searches in parallel and handle individual errors
      const searchResults = await Promise.allSettled(searchPromises);
      
      // Filter successful results and merge torrent lists
      const rawTorrents = searchResults
        .filter(result => result.status === 'fulfilled' && Array.isArray(result.value))
        .flatMap(result => result.value);

      // console.log(`${stremioId} : ${rawTorrents.length} raw torrents found from ${searchPromises.length} search queries in ${(new Date() - startDate) / 1000}s`);

      // Deduplicate torrents based on a unique identifier (e.g., guid or infoHash)
      const uniqueTorrentsMap = new Map();
      for (const torrent of rawTorrents) {
        const key = torrent.guid || torrent.infoHash; // Use guid or infoHash as the unique key
        if (key && !uniqueTorrentsMap.has(key)) {
          uniqueTorrentsMap.set(key, torrent);
        }
      }
      torrents = Array.from(uniqueTorrentsMap.values());
      // console.log(`${stremioId} : ${torrents.length} unique torrents after deduplication. Details:`, torrents.map(t => ({ name: t.name, year: t.year, size: t.size, seeders: t.seeders })).slice(0, 10)); // Log first 10 for brevity

      const torrentsBeforeYearFilter = torrents.length;
      torrents = torrents.filter(filterYear);
      // console.log(`${stremioId} : ${torrents.length} torrents after filterYear (removed ${torrentsBeforeYearFilter - torrents.length}).`);

      const torrentsBeforeSearchFilter = torrents.length;
      torrents = torrents.filter(filterSearch);
      // console.log(`${stremioId} : ${torrents.length} torrents after filterSearch (removed ${torrentsBeforeSearchFilter - torrents.length}).`);

      torrents = torrents.sort(sortBy(...sortSearch));
      // console.log(`${stremioId} : ${torrents.length} torrents after initial sort. Top 5:`, torrents.map(t => ({ name: t.name, year: t.year, size: t.size, seeders: t.seeders })).slice(0, 5));

      torrents = priotizeItems(torrents, filterLanguage, Math.max(1, Math.round(maxTorrents * 0.33)));
      // console.log(`${stremioId} : ${torrents.length} torrents after priotizeItems. Top 5:`, torrents.map(t => ({ name: t.name, year: t.year, size: t.size, seeders: t.seeders })).slice(0, 5));

      torrents = torrents.slice(0, maxTorrents + 2);
      // console.log(`${stremioId} : ${torrents.length} torrents after slice(0, ${maxTorrents + 2}).`);

    }else if(type == 'series'){

      const episodesPromises = indexers.map(indexer => timeoutIndexerSearch(
        indexer.id, 
        jackett.searchEpisodeTorrents({
          ...metaInfos, 
          imdbId: metaInfos.imdb_id || metaInfos.id, 
          indexer: indexer.id,
          supportedParams: indexer.searching.series.supportedParams
        }), 
        indexerTimeoutSec*1000
      ));
      // const packsPromises = indexers.map(indexer => promiseTimeout(jackett.searchSeasonTorrents({...metaInfos, indexer: indexer.id}), indexerTimeoutSec*1000).catch(err => []));
      const packsPromises = indexers.map(indexer => timeoutIndexerSearch(
        indexer.id, 
        jackett.searchSerieTorrents({
          ...metaInfos, 
          imdbId: metaInfos.imdb_id || metaInfos.id, 
          indexer: indexer.id,
          supportedParams: indexer.searching.series.supportedParams
        }), 
        indexerTimeoutSec*1000
      ));

      const episodesTorrents = [].concat(...(await Promise.all(episodesPromises))).filter(filterSearch);
      // const packsTorrents = [].concat(...(await Promise.all(packsPromises))).filter(torrent => filterSearch(torrent) && parseWords(torrent.name.toUpperCase()).includes(`S${numberPad(season)}`));
      const packsTorrents = [].concat(...(await Promise.all(packsPromises))).filter(torrent => {
        if(!filterSearch(torrent))return false;
        const words = parseWords(torrent.name.toLowerCase());
        const wordsStr = words.join(' ');
        if(
          // Season x
          wordsStr.includes(`season ${season}`)
          // SXX
          || words.includes(`s${numberPad(season, 2)}`)
        ){
          return true;
        }
        // From SXX to SXX
        const range = wordsStr.match(/s([\d]{2,}) s([\d]{2,})/);
        if(range && season >= parseInt(range[1]) && season <= parseInt(range[2])){
          return true;
        }
        // Complete without season number (serie pack)
        if(words.includes('complete') && !wordsStr.match(/ (s[\d]{2,}|season [\d]) /)){
          return true;
        }
        return false;
      });

      torrents = [].concat(episodesTorrents, packsTorrents);

      // console.log(`${stremioId} : ${torrents.length} torrents found in ${(new Date() - startDate) / 1000}s`);

      torrents = torrents.filter(filterYear);
      torrents = torrents.filter(filterSearch).sort(sortBy(...sortSearch));
      torrents = priotizeItems(torrents, filterLanguage, Math.max(1, Math.round(maxTorrents * 0.33)));
      torrents = torrents.slice(0, maxTorrents + 2);

      if(priotizePackTorrents > 0 && packsTorrents.length && !torrents.find(t => packsTorrents.includes(t))){
        const bestPackTorrents = packsTorrents.slice(0, Math.min(packsTorrents.length, priotizePackTorrents));
        torrents.splice(bestPackTorrents.length * -1, bestPackTorrents.length, ...bestPackTorrents);
      }

    }

    // console.log(`${stremioId} : ${torrents.length} torrents filtered, get torrents infos ...`);
    startDate = new Date();

    const limit = pLimit(5);
    torrents = await Promise.all(torrents.map(torrent => limit(async () => {
      try {
        torrent.infos = await promiseTimeout(torrentInfos.get(torrent), Math.min(30, indexerTimeoutSec)*1000);
        return torrent;
      }catch(err){
        console.log(`${stremioId} Failed getting torrent infos for ${torrent.id} from indexer ${torrent.indexerId}`);
        console.log(`${stremioId} ${torrent.link.replace(/apikey=[a-z0-9\-]+/, 'apikey=****')}`, err);
        return false;
      }
    })));
    torrents = torrents.filter(torrent => torrent && torrent.infos)
      .filter((torrent, index, items) => items.findIndex(t => t.infos.infoHash == torrent.infos.infoHash) === index)
      .slice(0, maxTorrents);

    // console.log(`${stremioId} : ${torrents.length} torrents infos found in ${(new Date() - startDate) / 1000}s`);

    if(torrents.length == 0){
      throw new Error(`No torrent infos for type ${type} and id ${stremioId}`);
    }

    if(debridInstance){

      try {

        const isValidCachedFiles = type == 'series' ? files => !!searchEpisodeFile(files, season, episode) : files => true;
        
        // Get cached torrents and their status
        let statusTorrents = [];
        let cachedTorrents = [];
        
        if (debridInstance.constructor.id === 'stremthru') {
          // For StremThru, retrieve status of all torrents
          // We store the status for all torrents, but only keep
          // the torrents in cache in cachedTorrents to not disturb existing behavior
          
          // Save statuses
          const origStatuses = {};
          for (const torrent of torrents) {
            if (torrent.status) {
              origStatuses[torrent.infos.infoHash] = torrent.status;
            }
          }
          
          // Obtain cached torrents and their status
          cachedTorrents = (await debridInstance.getTorrentsCached(torrents, isValidCachedFiles)).map(torrent => {
            torrent.isCached = true;
            return torrent;
          });
          
          // Restore statuses for all torrents
          for (const torrent of torrents) {
            if (origStatuses[torrent.infos.infoHash]) {
              torrent.status = origStatuses[torrent.infos.infoHash];
            }
          }
        } else {
          // For other services, normal behavior
          cachedTorrents = (await debridInstance.getTorrentsCached(torrents, isValidCachedFiles)).map(torrent => {
            torrent.isCached = true;
            return torrent;
          });
        }
        
        const uncachedTorrents = torrents.filter(torrent => cachedTorrents.indexOf(torrent) === -1);

        if(config.replacePasskey && !(userConfig.passkey && userConfig.passkey.match(new RegExp(config.replacePasskeyPattern)))){
          uncachedTorrents.forEach(torrent => {
            if(torrent.infos.private){
              torrent.disabled = true;
              torrent.infoText = 'Uncached torrent requires a passkey configuration';
            }
          });
        }

        // console.log(`${stremioId} : ${cachedTorrents.length} cached torrents on ${debridInstance.shortName}`);

        // Custom function to sort torrents by quality in descending order of resolutions
        const sortByQuality = (torrents) => {
          return [...torrents].sort((a, b) => {
            // Order of qualities: 2160p > 1080p > 720p > 480p > 360p > 0 (Unknown)
            const qualityOrder = { 2160: 5, 1080: 4, 720: 3, 480: 2, 360: 1, 0: 0 };
            const qualityA = qualityOrder[a.quality] || 0;
            const qualityB = qualityOrder[b.quality] || 0;
            
            if (qualityA !== qualityB) {
              return qualityB - qualityA; // Sort in descending order by quality
            }
            
            // If the qualities are the same, use other sorting criteria
            for (const [key, reverse] of sortCached) {
              if (key !== 'quality') { // Ignore the quality criterion since it has already been processed
                if (a[key] > b[key]) return reverse ? -1 : 1;
                if (a[key] < b[key]) return reverse ? 1 : -1;
              }
            }
            return 0;
          });
        };

        // Mark torrents as cached
        cachedTorrents.forEach(torrent => {
          torrent.isCached = true;
        });

        // Combine all torrents (cached and uncached)
        let allTorrents = [...cachedTorrents];
        
        if(!userConfig.hideUncached || !debrid.cacheCheckAvailable){
          allTorrents = [...allTorrents, ...uncachedTorrents];
        }
        
        // Sort all torrents by quality
        torrents = priotizeItems(sortByQuality(allTorrents), filterLanguage);
      
        const progress = await debridInstance.getProgressTorrents(torrents);
        torrents.forEach(torrent => torrent.progress = progress[torrent.infos.infoHash] || null);

      }catch(err){

        console.log(`${stremioId} : ${debridInstance.shortName} : ${err.message || err}`);

        if(err.message == debrid.ERROR.EXPIRED_API_KEY){
          torrents.forEach(torrent => {
            torrent.disabled = true;
            torrent.infoText = 'Unable to verify cache (+): Expired Debrid API Key.';
          });
        }

      }

    }

    // console.log(`${stremioId} : ${torrents.length} torrents after fetching infos, final deduplication and slice. Top 5:`, torrents.map(t => ({ name: t.name, infoHash: t.infos?.infoHash, size: t.infos?.size, seeders: t.seeders })).slice(0, 5));
    // console.log(`${stremioId} : ${torrents.length} torrents infos found in ${(new Date() - startDate) / 1000}s`);

    if(torrents.length == 0){
      throw new Error(`No torrent infos for type ${type} and id ${stremioId}`);
    }

    return torrents;

  }finally{

    delete actionInProgress.getTorrents[metaInfos.stremioId];

  }

}

function getFile(files, type, season, episode){
  files = files.sort(sortBy('size', true));
  if(type == 'movie'){
    return files[0];
  }else if(type == 'series'){
    // Only return the file matching the episode, no fallback to the first file
    return searchEpisodeFile(files, season, episode);
  }
}

async function prepareNextEpisode(userConfig, metaInfos, debridInstance){

  try {

    const {stremioId} = metaInfos;
    const nextEpisodeIndex = metaInfos.episodes.findIndex(e => e.episode == metaInfos.episode && e.season == metaInfos.season) + 1;
    const nextEpisode = metaInfos.episodes[nextEpisodeIndex] || false;

    if(nextEpisode){

      metaInfos = await meta.getEpisodeById(metaInfos.id, nextEpisode.season, nextEpisode.episode, userConfig.metaLanguage);
      const torrents = await getTorrents(userConfig, metaInfos, debridInstance);

      // Cache next episode on debrid when not cached
      if(userConfig.forceCacheNextEpisode && torrents.length && !torrents.find(torrent => torrent.isCached)){
        console.log(`${stremioId} : Force cache next episode (${metaInfos.episode}) on debrid`);
        const bestTorrent = torrents.find(torrent => !torrent.disabled);
        if(bestTorrent)await getDebridFiles(userConfig, bestTorrent.infos, debridInstance);
      }

    }

  }catch(err){

    if(err.message != debrid.ERROR.NOT_READY){
      console.log('cache next episode:', err);
    }

  }

}

async function getDebridFiles(userConfig, infos, debridInstance){

  // If the debridder is StremThru, use the new getFilesFromTorrent method
  if (debridInstance.constructor.id === 'stremthru' && typeof debridInstance.getFilesFromTorrent === 'function') {
    return debridInstance.getFilesFromTorrent(infos);
  }

  if(infos.magnetUrl){

    return debridInstance.getFilesFromMagnet(infos.magnetUrl, infos.infoHash);

  }else{

    let buffer = await torrentInfos.getTorrentFile(infos);

    if(config.replacePasskey){

      if(infos.private && !userConfig.passkey){
        return debridInstance.getFilesFromHash(infos.infoHash);
      }

      if(!userConfig.passkey.match(new RegExp(config.replacePasskeyPattern))){
        throw new Error(`Invalid user passkey, pattern not match: ${config.replacePasskeyPattern}`);
      }

      const from = buffer.toString('binary');
      let to = from.replace(new RegExp(config.replacePasskey, 'g'), userConfig.passkey);
      const diffLength = from.length - to.length;
      const announceLength = from.match(/:announce([\d]+):/);
      if(diffLength && announceLength && announceLength[1]){
        to = to.replace(announceLength[0], `:announce${parseInt(announceLength[1]) - diffLength}:`);
      }
      buffer = Buffer.from(to, 'binary');

    }

    return debridInstance.getFilesFromBuffer(buffer, infos.infoHash);

  }

}

function formatLanguages(languages, torrentName = '') {
  // If no language is specified, return an empty array
  if (!languages || languages.length === 0) return [];
  
  // Check if "multi" is present
  const hasMulti = languages.some(lang => lang.value === 'multi');
  
  // Check if French is present (VF, VFF, VFI, french)
  const hasFrench = languages.some(lang => 
    lang.value === 'french' || 
    (lang.value && (
      lang.value.toLowerCase().includes('vf') ||
      lang.value.toLowerCase().includes('français') ||
      lang.value.toLowerCase().includes('francais')
    ))
  );
  
  // Also check in the torrent name for "multi.vff", "multi.vfi", etc.
  const hasFrenchInName = torrentName && (
    (torrentName.toLowerCase().includes('multi') || torrentName.toLowerCase().includes('dual')) && 
    (torrentName.toLowerCase().includes('.vf') || torrentName.toLowerCase().includes('vff') || 
     torrentName.toLowerCase().includes('vfi') || torrentName.toLowerCase().includes('truefrench') ||
     torrentName.toLowerCase().includes('french'))
  );
  
  // Get all language emojis
  const languageEmojis = languages.map(lang => lang.emoji);
  
  // If "multi" is present and French is also present (in the language or the name), add the French flag next to the globe
  if (hasMulti && (hasFrench || hasFrenchInName)) {
    // Find the index of the globe emoji (multi)
    const multiIndex = languages.findIndex(lang => lang.value === 'multi');
    if (multiIndex !== -1) {
      // Replace the globe emoji with "globe+French flag"
      const frenchEmoji = '🇫🇷';
      languageEmojis[multiIndex] = `${languages[multiIndex].emoji} ${frenchEmoji}`;
    }
  }
  
  return languageEmojis;
}

export async function getStreams(userConfig, type, stremioId, publicUrl){

  userConfig = await mergeDefaultUserConfig(userConfig);
  const debridInstance = debrid.instance(userConfig);
  const {id, season, episode} = parseStremioId(stremioId);

  let metaInfos = await getMetaInfos(type, stremioId, userConfig.metaLanguage);

  const torrents = await getTorrents(userConfig, metaInfos, debridInstance);
  
  // Retrieve the torrents already clicked from localStorage
  const clickedHashes = [];
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const stored = window.localStorage.getItem('jackettio_clicked_torrents');
      if (stored) {
        Object.assign(clickedHashes, JSON.parse(stored));
      }
    } catch (err) {
      console.error('Error when retrieving clicked torrents:', err);
    }
  }
  
  // Mark torrents as clicked if present in localStorage
  torrents.forEach(torrent => {
    if (torrent.infos && torrent.infos.infoHash && clickedHashes.includes(torrent.infos.infoHash)) {
      torrent.clicked = true;
    }
  });
  
  // Initialize torrent statuses if it's StremThru
  // This is much more efficient because it's a single request for all torrents
  if (debridInstance && debridInstance.constructor.id === 'stremthru' && debridInstance.initTorrentStatuses) {
    try {
      await debridInstance.initTorrentStatuses(torrents);
      console.log(`${stremioId} : Torrent statuses initialized`);
    } catch (err) {
      console.error(`Error when initializing statuses: ${err.message}`);
    }
  }
  
  if (!torrents.length) return [];

  // Prepare next episode torrents list
  if(type == 'series'){
    prepareNextEpisode({...userConfig, forceCacheNextEpisode: false}, metaInfos, debridInstance);
  }

  return torrents.map(torrent => {
    const file = getFile(torrent.infos.files || [], type, season, episode) || {};
    const quality = torrent.quality > 0 ? `(${config.qualities.find(q => q.value == torrent.quality).label})` : '';
    const { codecInfo, sourceInfo, audioInfo } = extractMediaInfo(torrent.name);
    
    // Format media information nicely
    const mediaInfo = [];
    if (codecInfo) mediaInfo.push(`🎬 ${codecInfo}`);
    if (sourceInfo) mediaInfo.push(`📀 ${sourceInfo}`);
    if (audioInfo) mediaInfo.push(`🔊 ${audioInfo}`);
    
    const rows = [torrent.name];
    if(type == 'series' && file.name) rows.push(file.name);
    if(torrent.infoText) rows.push(`ℹ️ ${torrent.infoText}`);
    
    // Format main info line with improved styling
    rows.push([
      `💾 ${bytesToSize(file.size || torrent.size)}`,
      `👥 ${torrent.seeders}`,
      `⚙️ ${torrent.indexerId}`,
      ...formatLanguages(torrent.languages || [], torrent.name)
    ].join(' '));
    
    // Add media info if available
    if (mediaInfo.length > 0) {
      rows.push(mediaInfo.join(' '));
    }
    
    // Only show download progress if there's actual progress (not 0%)
    if(torrent.progress && !torrent.isCached && (torrent.progress.percent > 0 || torrent.progress.speed > 0)) {
      rows.push(`⬇️ ${torrent.progress.percent}% ${bytesToSize(torrent.progress.speed)}/s`);
    }
    
    // Use the appropriate status icon if available, otherwise default behavior
    let statusIcon = '';
    if (debridInstance.constructor.id === 'stremthru') {
      if (torrent.isCached) {
        // For cached torrents, use the yellow lightning bolt
        statusIcon = '⚡';
      } else {
        // For all others, use the blue square with a downward arrow
        statusIcon = '⬇️';
      }
    } else if (torrent.isCached) {
      // Default behavior for cached torrents from other services
      statusIcon = '+';
    } else {
      // For non-cached torrents, use the down arrow
      statusIcon = '⬇️';
    }
    
    return {
      name: `[${debridInstance.shortName}${statusIcon}] ${userConfig.enableMediaFlow ? '🕵🏼‍♂️ ' : ''}${config.addonName} ${quality}`,
      title: rows.join("\n"),
      url: torrent.disabled ? '#' : `${publicUrl}/${btoa(JSON.stringify(userConfig))}/download/${type}/${stremioId}/${torrent.id}/${file.name || torrent.name}`,
      infoHash: torrent.infos.infoHash
    };
  });

}

export async function getDownload(userConfig, type, stremioId, torrentId){

  userConfig = await mergeDefaultUserConfig(userConfig);
  const debridInstance = debrid.instance(userConfig);
  const infos = await torrentInfos.getById(torrentId);
  const {id, season, episode} = parseStremioId(stremioId);
  const cacheKey = `download:2:${await debridInstance.getUserHash()}${userConfig.enableMediaFlow ? ':mfp': ''}:${stremioId}:${torrentId}`;
  let files;
  let download;
  let waitMs = 0;

  // Record this torrent as "clicked" in localStorage
  if (infos && infos.infoHash && typeof window !== 'undefined' && window.localStorage) {
    try {
      let clickedHashes = [];
      const stored = window.localStorage.getItem('jackettio_clicked_torrents');
      if (stored) {
        clickedHashes = JSON.parse(stored);
      }
      
      // Add the hash if it's not already present
      if (!clickedHashes.includes(infos.infoHash)) {
        clickedHashes.push(infos.infoHash);
        window.localStorage.setItem('jackettio_clicked_torrents', JSON.stringify(clickedHashes));
        console.log(`${stremioId} : Torrent ${infos.infoHash} marked as clicked`);
      }
    } catch (err) {
      console.error('Error when recording clicked torrent:', err);
    }
  }

  // Immediately update status to "queued" so that the hourglass is displayed
  // even if the rest fails due to API errors
  if (debridInstance && debridInstance.constructor.id === 'stremthru' && debridInstance.constructor.setStatus && infos && infos.infoHash) {
    debridInstance.constructor.setStatus(infos.infoHash, 'queued');
    console.log(`${stremioId} : Status updated to 'queued' for ${infos.infoHash}`);
  }

  while(actionInProgress.getDownload[cacheKey]){
    await wait(Math.min(300, waitMs+=50));
  }
  actionInProgress.getDownload[cacheKey] = true;

  try {

    // Prepare next episode debrid cache
    if(type == 'series' && userConfig.forceCacheNextEpisode){
      getMetaInfos(type, stremioId, userConfig.metaLanguage).then(metaInfos => prepareNextEpisode(userConfig, metaInfos, debridInstance));
    }

    download = await cache.get(cacheKey);
    if(download)return download;

    console.log(`${stremioId} : ${debridInstance.shortName} : ${infos.infoHash} : get files ...`);
    
    // We have already updated the status at the beginning of the function
    const filesResult = await getDebridFiles(userConfig, infos, debridInstance);
    
    // For StremThru, filesResult can be an object with files and errorType
    if (filesResult && typeof filesResult === 'object' && 'files' in filesResult) {
      files = filesResult.files;
      
      // If an error type is present and there are no files, return the appropriate error video
      if (filesResult.errorType && (!files || files.length === 0)) {
        console.log(`${stremioId} : Error detected: ${filesResult.errorType}`);
        return {
          url: `/videos/${filesResult.errorType}.mp4`,
          notReady: true,
          errorType: filesResult.errorType,
          reason: 'Error from StremThru'
        };
      }
    } else {
      // For other debridders, filesResult is directly an array of files
      files = filesResult;
    }
    
    console.log(`${stremioId} : ${debridInstance.shortName} : ${infos.infoHash} : ${files.length} files found`);

    // If no files are available, return the not_ready.mp4 video
    if (!files || files.length === 0) {
      console.log(`${stremioId} : No files available, redirect to not_ready.mp4`);
      return {
        url: `/videos/not_ready.mp4`,
        notReady: true,
        errorType: 'not_ready',
        reason: 'No files available'
      };
    }

    const selectedFile = getFile(files, type, season, episode);
    
    // If no matching file is found, return the not_ready.mp4 video
    if (!selectedFile) {
      console.log(`${stremioId} : No matching file found, redirect to not_ready.mp4`);
      return {
        url: `/videos/not_ready.mp4`,
        notReady: true,
        errorType: 'not_ready',
        reason: 'No matching file found'
      };
    }

    download = await debridInstance.getDownload(selectedFile);

    // Check if the download object contains the notReady property (specific to StremThru)
    if (download && download.notReady) {
      console.log(`${stremioId} : File not ready: ${download.reason || 'Unknown reason'}`);
      
      // Use the error type provided by StremThru or default to 'not_ready'
      const errorType = download.errorType || 'not_ready';
      
      // Redirect to the appropriate error video
      return {
        url: `/videos/${errorType}.mp4`,
        notReady: true,
        errorType,
        reason: download.reason || 'Unknown reason'
      };
    }

    if(download){
      download = applyMediaflowProxyIfNeeded(download, userConfig);
      await cache.set(cacheKey, download, {ttl: 3600});
      return download;
    }

    // If no download is available, redirect to the not_ready.mp4 video
    console.log(`${stremioId} : No download available, redirect to not_ready.mp4`);
    return {
      url: `/videos/not_ready.mp4`,
      notReady: true,
      errorType: 'not_ready',
      reason: 'No download available'
    };

  }finally{

    delete actionInProgress.getDownload[cacheKey];

  }

}
