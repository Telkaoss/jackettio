import crypto from 'crypto';
import {Parser} from "xml2js";
import config from './config.js';
import cache from './cache.js';
import {numberPad} from './util.js';

export const CATEGORY = {
  MOVIE: 2000,
  SERIES: 5000
};

export async function searchMovieTorrents({indexer, name, year, imdbId, supportedParams = []}){
  const supports = (param) => supportedParams.includes(param);

  indexer = indexer || 'all';
  const cacheKey = `jackettItems:4:movie:${indexer}:${name}:${year}:${imdbId || '-'}`;
  let items = await cache.get(cacheKey);

  if(!items){
    const imdbPart = imdbId ? imdbId.replace(/^tt/, '') : '';
    // Many indexers choke if the raw imdb number is appended to the query.
    // Prefer plain title search, and only send the imdb id via the dedicated param when supported.
    const query = {t: 'search', cat: CATEGORY.MOVIE, q: name /*, year: year*/};
    if (imdbId && supports('imdbid')) query.imdbid = imdbPart;
    const res = await jackettApi(
      `/api/v2.0/indexers/${indexer}/results/torznab/api`,
      // year is buggy with some indexers
      query
    );
    items = res?.rss?.channel?.item || [];
    // If nothing was found and imdb isn't supported, fall back to title + imdb number as a last resort.
    if(!items.length && imdbPart && !supports('imdbid')){
      const retryQuery = {t: 'search', cat: CATEGORY.MOVIE, q: `${name} ${imdbPart}`};
      items = (await jackettApi(
        `/api/v2.0/indexers/${indexer}/results/torznab/api`,
        retryQuery
      ))?.rss?.channel?.item || [];
    }
    if(items.length){
      cache.set(cacheKey, items, {ttl: 3600*36});
    }
  }

  return normalizeItems(items);

}

export async function searchSerieTorrents({indexer, name, year, imdbId, supportedParams = []}){
  const supports = (param) => supportedParams.includes(param);
  const baseName = name.includes(':') ? name.split(':')[0] : name;

  indexer = indexer || 'all';
  const cacheKey = `jackettItems:4:serie:${indexer}:${name}:${year}:${imdbId || '-'}`;
  let items = await cache.get(cacheKey);

  if(!items){
    // Toloka does not handle imdb/season/ep well, keep simple title searches
    if(indexer === 'toloka'){
      const queries = [name, baseName].filter(Boolean);
      for(const q of queries){
        const res = await jackettApi(`/api/v2.0/indexers/${indexer}/results/torznab/api`, {t: 'search', q});
        items = res?.rss?.channel?.item || [];
        if(items.length)break;
      }
    }else{
      const imdbPart = imdbId ? imdbId.replace(/^tt/, '') : '';
      // For generic packs, use broad search to let indexer match by title
      const query = {t: 'search', q: imdbPart ? `${name} ${imdbPart}` : `${name}`, cat: CATEGORY.SERIES};
      if (imdbId && supports('imdbid')) query.imdbid = imdbId.replace(/^tt/, '');
      const res = await jackettApi(
        `/api/v2.0/indexers/${indexer}/results/torznab/api`,
        query
      );
      items = res?.rss?.channel?.item || [];

      if(!items.length && imdbPart){
        const retryQuery = {t: 'search', q: `${name}`, cat: CATEGORY.SERIES};
        items = (await jackettApi(
          `/api/v2.0/indexers/${indexer}/results/torznab/api`,
          retryQuery
        ))?.rss?.channel?.item || [];
      }

      if(!items.length && baseName !== name){
        const altQuery = {t: 'search', q: baseName, cat: CATEGORY.SERIES};
        items = (await jackettApi(
          `/api/v2.0/indexers/${indexer}/results/torznab/api`,
          altQuery
        ))?.rss?.channel?.item || [];
      }
    }
    if(items.length){
      cache.set(cacheKey, items, {ttl: 3600*36});
    }
  }

  return normalizeItems(items);

}

export async function searchSeasonTorrents({indexer, name, year, season, imdbId, supportedParams = []}){
  const supports = (param) => supportedParams.includes(param);
  const baseName = name.includes(':') ? name.split(':')[0] : name;

  indexer = indexer || 'all';
  const cacheKey = `jackettItems:4:season:${indexer}:${name}:${year}:${season}:${imdbId || '-'}`;
  let items = await cache.get(cacheKey);

  if(!items){
    if(indexer === 'toloka'){
      const queries = [
        `${name} S${numberPad(season)}`,
        `${baseName} S${numberPad(season)}`,
        baseName
      ].filter(Boolean);
      for(const q of queries){
        const res = await jackettApi(`/api/v2.0/indexers/${indexer}/results/torznab/api`, {t: 'search', q});
        items = res?.rss?.channel?.item || [];
        if(items.length)break;
      }
    }else{
      const imdbPart = imdbId ? imdbId.replace(/^tt/, '') : '';
      const query = {t: 'tvsearch', q: imdbPart ? `${name} ${imdbPart} S${numberPad(season)}` : `${name} S${numberPad(season)}`, cat: CATEGORY.SERIES};
      if (imdbId && supports('imdbid')) query.imdbid = imdbId.replace(/^tt/, '');
      if (supports('season')) query.season = season;
      const res = await jackettApi(
        `/api/v2.0/indexers/${indexer}/results/torznab/api`,
        query
      );
      items = res?.rss?.channel?.item || [];

      if(!items.length && imdbPart){
        const retryQuery = {t: 'tvsearch', q: `${name} S${numberPad(season)}`, cat: CATEGORY.SERIES};
        if (supports('season')) retryQuery.season = season;
        items = (await jackettApi(
          `/api/v2.0/indexers/${indexer}/results/torznab/api`,
          retryQuery
        ))?.rss?.channel?.item || [];
      }

      if(!items.length && baseName !== name){
        const altQuery = {t: 'tvsearch', q: `${baseName} S${numberPad(season)}`, cat: CATEGORY.SERIES};
        items = (await jackettApi(
          `/api/v2.0/indexers/${indexer}/results/torznab/api`,
          altQuery
        ))?.rss?.channel?.item || [];
      }
    }
    if(items.length){
      cache.set(cacheKey, items, {ttl: 3600*36});
    }
  }

  return normalizeItems(items);

}

export async function searchEpisodeTorrents({indexer, name, year, season, episode, imdbId, supportedParams = []}){
  const supports = (param) => supportedParams.includes(param);
  const baseName = name.includes(':') ? name.split(':')[0] : name;

  indexer = indexer || 'all';
  const cacheKey = `jackettItems:4:episode:${indexer}:${name}:${year}:${season}:${episode}:${imdbId || '-'}`;
  let items = await cache.get(cacheKey);

  if(!items){
    if(indexer === 'toloka'){
      const queries = [
        baseName
      ].filter(Boolean);
      for(const q of queries){
        const res = await jackettApi(`/api/v2.0/indexers/${indexer}/results/torznab/api`, {t: 'search', q});
        items = res?.rss?.channel?.item || [];
        if(items.length)break;
      }
    }else{
      const imdbPart = imdbId ? imdbId.replace(/^tt/, '') : '';
      const query = {t: 'tvsearch', q: imdbPart ? `${name} ${imdbPart} S${numberPad(season)}E${numberPad(episode)}` : `${name} S${numberPad(season)}E${numberPad(episode)}`, cat: CATEGORY.SERIES};
      if (imdbId && supports('imdbid')) query.imdbid = imdbId.replace(/^tt/, '');
      if (supports('season')) query.season = season;
      if (supports('ep')) query.ep = episode;
      const res = await jackettApi(
        `/api/v2.0/indexers/${indexer}/results/torznab/api`,
        query
      );
      items = res?.rss?.channel?.item || [];

      if(!items.length && imdbPart){
        const retryQuery = {t: 'tvsearch', q: `${name} S${numberPad(season)}E${numberPad(episode)}`, cat: CATEGORY.SERIES};
        if (supports('season')) retryQuery.season = season;
        if (supports('ep')) retryQuery.ep = episode;
        items = (await jackettApi(
          `/api/v2.0/indexers/${indexer}/results/torznab/api`,
          retryQuery
        ))?.rss?.channel?.item || [];
      }

      if(!items.length && baseName !== name){
        const altQuery = {t: 'tvsearch', q: `${baseName} S${numberPad(season)}E${numberPad(episode)}`, cat: CATEGORY.SERIES};
        items = (await jackettApi(
          `/api/v2.0/indexers/${indexer}/results/torznab/api`,
          altQuery
        ))?.rss?.channel?.item || [];
      }
    }
    if(items.length){
      cache.set(cacheKey, items, {ttl: 3600*36});
    }
  }

  return normalizeItems(items);

}

export async function getIndexers(){

  const res = await jackettApi(
    '/api/v2.0/indexers/all/results/torznab/api',
    {t: 'indexers', configured: 'true'}
  );

  return normalizeIndexers(res?.indexers?.indexer || []);

}

async function jackettApi(path, query){

  const params = new URLSearchParams(query || {});
  params.set('apikey', config.jackettApiKey);

  const url = `${config.jackettUrl}${path}?${params.toString()}`;

  let data;
  const res = await fetch(url);
  if(res.headers.get('content-type').includes('application/json')){
    data = await res.json();
  }else{
    const text = await res.text();
    const parser = new Parser({explicitArray: false, ignoreAttrs: false});
    data = await parser.parseStringPromise(text);
  }

  if(data.error){
    throw new Error(`jackettApi: ${url.replace(/apikey=[a-z0-9\-]+/, 'apikey=****')} : ${data.error?.$?.description || data.error}`);
  }

  return data;

}

function normalizeItems(items){
  return forceArray(items).map(item => {
    item = mergeDollarKeys(item);
    const attrs = forceArray(item['torznab:attr'] || []).reduce((obj, item) => {
      if (item?.name) obj[item.name] = item.value;
      return obj;
    }, {});
    const quality = item.title.match(/(2160|1080|720|480|360)p/);
    const normalizedTitle = `${item.title || ''}`.toLowerCase();
    // Correction de la regex pour capturer 19xx ou 20xx
    const year = item.title.replace(quality ? quality[1] : '', '').match(/\b(19\d{2}|20\d{2})\b/);
    const magnetUrl = attrs.magneturl || attrs.magneturi || '';
    return {
      name: item.title,
      guid: item.guid,
      indexerId: item.jackettindexer.id,
      id: crypto.createHash('sha1').update(item.guid).digest('hex'),
      size: parseInt(item.size),
      link: item.link,
      seeders: parseInt(attrs.seeders || 0),
      peers: parseInt(attrs.peers || 0),
      infoHash: attrs.infohash || '',
      // Keep both camelCase and legacy casing to avoid breaking callers
      magnetUrl,
      magneturl: magnetUrl,
      type: item.type,
      quality: quality ? parseInt(quality[1]) : 0,
      // Correction pour utiliser le premier élément du match (l'année complète)
      year: year ? parseInt(year[0]) : 0,
      languages: config.languages.filter(lang => lang.pattern.test(normalizedTitle))
    };
  });
}

function normalizeIndexers(items){
  return forceArray(items).map(item => {
    item = mergeDollarKeys(item);
    const searching = item.caps.searching;
    return {
      id: item.id,
      configured: item.configured == 'true',
      title: item.title,
      language: item.language,
      type: item.type,
      categories: forceArray(item.caps.categories.category).map(category => parseInt(category.id)),
      searching: {
        movie: {
          available: searching['movie-search'].available == 'yes', 
          supportedParams: searching['movie-search'].supportedParams.split(',')
        },
        series: {
          available: searching['tv-search'].available == 'yes', 
          supportedParams: searching['tv-search'].supportedParams.split(',')
        }
      }
    };
  });
}

function mergeDollarKeys(item){
  if(item.$){
    item = {...item.$, ...item};
    delete item.$;
  }
  for(let key in item){
    if(typeof(item[key]) === 'object'){
      item[key] = mergeDollarKeys(item[key]);
    }
  }
  return item;
}

function forceArray(value){
  return Array.isArray(value) ? value : [value];
}
