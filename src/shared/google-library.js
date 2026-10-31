// Imports a signed-in user's YouTube / YouTube Music likes and playlists through InnerTube browse.
// Caller supplies the SAPISID cookie value and a fetch that sends the Google session cookies
// (Electron: session.fetch of the login partition; Pulse host: fetch + cookie header from yt-cookies.txt).
const crypto = require('crypto');

async function importGoogleLibrary(opts, { sapisid, fetchImpl }) {
  const platform = (opts && opts.platform === 'ytmusic') ? 'ytmusic' : 'youtube';
  const doLikes = !opts || opts.doLikes !== false;
  const doPlaylists = !opts || opts.doPlaylists !== false;

  if (!sapisid) return { success: false, error: 'Not logged in to Google' };

  const isYtm = platform === 'ytmusic';
  const browseUrl = isYtm
    ? 'https://music.youtube.com/youtubei/v1/browse?prettyPrint=false'
    : 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false';
  const origin = isYtm ? 'https://music.youtube.com' : 'https://www.youtube.com';
  const clientName = isYtm ? 'WEB_REMIX' : 'WEB';
  const clientVersion = isYtm ? '1.20240401.01.00' : '2.20240401.01.00';
  const likedBrowseId = isYtm ? 'VLLM' : 'VLLL';
  const playlistsBrowseId = isYtm ? 'FEmusic_liked_playlists' : 'FEplaylist_aggregation';

  function extractText(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (typeof node.simpleText === 'string') return node.simpleText;
    if (Array.isArray(node.runs)) return node.runs.map(r => (r && r.text) || '').join('');
    return '';
  }

  function parseDurationSec(val) {
    if (!val) return 0;
    if (typeof val === 'number') return val;
    const str = String(val).trim();
    const m = str.match(/(?:(\d+):)?(\d+):(\d+)/);
    if (m) {
      const h = m[1] ? parseInt(m[1], 10) : 0;
      const min = parseInt(m[2], 10);
      const sec = parseInt(m[3], 10);
      return h * 3600 + min * 60 + sec;
    }
    const num = parseInt(str, 10);
    return Number.isFinite(num) ? num : 0;
  }

  function findContinuationToken(node, visited = new Set()) {
    if (!node || typeof node !== 'object') return null;
    if (visited.has(node)) return null;
    visited.add(node);
    if (node.continuationItemViewModel) {
      const c = node.continuationItemViewModel.continuationCommand;
      const t = c?.token || c?.continuationCommand?.token || c?.innertubeCommand?.continuationCommand?.token;
      if (typeof t === 'string' && t) return t;
    }
    if (typeof node.continuation === 'string' && node.continuation) return node.continuation;
    if (typeof node.token === 'string' && node.token) return node.token;
    if (node.continuationCommand && typeof node.continuationCommand.token === 'string') {
      return node.continuationCommand.token;
    }
    if (node.nextContinuationData && typeof node.nextContinuationData.continuation === 'string') {
      return node.nextContinuationData.continuation;
    }
    for (const k of Object.keys(node)) {
      const res = findContinuationToken(node[k], visited);
      if (res) return res;
    }
    return null;
  }

  function extractTracksGeneric(root) {
    const tracks = [];
    const seenIds = new Set();
    function walk(node, visited = new Set()) {
      if (!node || typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);
      if (node.lockupViewModel) {
        const l = node.lockupViewModel;
        let videoId = (l.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') ? l.contentId : null;
        if (!videoId && l.contentId && /^[a-zA-Z0-9_-]{11}$/.test(l.contentId)) videoId = l.contentId;
        if (!videoId && l.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId) {
          videoId = l.rendererContext.commandContext.onTap.innertubeCommand.watchEndpoint.videoId;
        }
        if (videoId && !seenIds.has(videoId)) {
          seenIds.add(videoId);
          const meta = l.metadata?.lockupMetadataViewModel;
          const title = meta?.title?.content || 'untitled';
          let artist = '';
          const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows;
          if (Array.isArray(rows) && rows[0]?.metadataParts && rows[0].metadataParts[0]?.text?.content) {
            artist = rows[0].metadataParts[0].text.content;
          }
          let duration = 0;
          const overlays = l.contentImage?.thumbnailViewModel?.overlays;
          if (Array.isArray(overlays)) {
            for (const ov of overlays) {
              const badges = ov?.thumbnailOverlayBadgeViewModel?.thumbnailBadges;
              if (Array.isArray(badges)) {
                for (const b of badges) {
                  const txt = b?.thumbnailBadgeViewModel?.text;
                  if (typeof txt === 'string' && /^\d+:\d+(:\d+)?$/.test(txt.trim())) {
                    duration = parseDurationSec(txt.trim());
                    break;
                  }
                }
              }
              if (duration) break;
            }
          }
          const sources = l.contentImage?.thumbnailViewModel?.image?.sources;
          const cover = (Array.isArray(sources) && sources.length > 0) ? sources[sources.length - 1].url : '';
          tracks.push({ videoId, title, artist, duration, cover });
        }
      } else if (node.musicResponsiveListItemRenderer) {
        const r = node.musicResponsiveListItemRenderer;
        let videoId = (r.playlistItemData && r.playlistItemData.videoId) ? r.playlistItemData.videoId : null;
        if (!videoId) {
          const findVid = (obj) => {
            if (!obj || typeof obj !== 'object') return null;
            if (obj.watchEndpoint && typeof obj.watchEndpoint.videoId === 'string') return obj.watchEndpoint.videoId;
            for (const k of Object.keys(obj)) {
              const v = findVid(obj[k]);
              if (v) return v;
            }
            return null;
          };
          videoId = findVid(r);
        }
        if (videoId && !seenIds.has(videoId)) {
          seenIds.add(videoId);
          const title = extractText(r.flexColumns && r.flexColumns[0] && r.flexColumns[0].musicResponsiveListItemFlexColumnRenderer && r.flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text) || 'untitled';
          let artist = '';
          if (r.flexColumns && r.flexColumns[1]) {
            const runs = r.flexColumns[1].musicResponsiveListItemFlexColumnRenderer && r.flexColumns[1].musicResponsiveListItemFlexColumnRenderer.text && r.flexColumns[1].musicResponsiveListItemFlexColumnRenderer.text.runs;
            if (Array.isArray(runs) && runs.length > 0) {
              artist = runs[0].text || '';
            } else {
              artist = extractText(r.flexColumns[1].musicResponsiveListItemFlexColumnRenderer && r.flexColumns[1].musicResponsiveListItemFlexColumnRenderer.text);
            }
          }
          let duration = 0;
          const findDur = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            if (Array.isArray(obj.runs)) {
              for (const ru of obj.runs) {
                if (ru && ru.text && /^\d+:\d+(:\d+)?$/.test(ru.text.trim())) {
                  duration = parseDurationSec(ru.text.trim());
                  return;
                }
              }
            }
            for (const k of Object.keys(obj)) {
              if (!duration) findDur(obj[k]);
            }
          };
          findDur(r);
          const thumbs = r.thumbnail && r.thumbnail.musicThumbnailRenderer && r.thumbnail.musicThumbnailRenderer.thumbnail && r.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails;
          const cover = (Array.isArray(thumbs) && thumbs.length > 0) ? thumbs[thumbs.length - 1].url : '';
          tracks.push({ videoId, title, artist, duration, cover });
        }
      } else if (node.playlistVideoRenderer || node.videoRenderer || node.compactVideoRenderer) {
        const r = node.playlistVideoRenderer || node.videoRenderer || node.compactVideoRenderer;
        const videoId = r.videoId;
        if (videoId && !seenIds.has(videoId)) {
          seenIds.add(videoId);
          const title = extractText(r.title) || 'untitled';
          const artist = extractText(r.shortBylineText) || extractText(r.ownerText) || '';
          const duration = r.lengthSeconds ? parseInt(r.lengthSeconds, 10) : parseDurationSec(extractText(r.lengthText));
          const thumbs = (r.thumbnail && r.thumbnail.thumbnails) || (r.thumbnails && r.thumbnails[0] && r.thumbnails[0].thumbnails);
          const cover = (Array.isArray(thumbs) && thumbs.length > 0) ? thumbs[thumbs.length - 1].url : '';
          tracks.push({ videoId, title, artist, duration, cover });
        }
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item, visited);
      } else {
        for (const k of Object.keys(node)) walk(node[k], visited);
      }
    }
    walk(root);
    return tracks;
  }

  function extractPlaylistsGeneric(root) {
    const playlists = [];
    const seenIds = new Set();
    function walk(node, visited = new Set()) {
      if (!node || typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);
      if (node.lockupViewModel) {
        const l = node.lockupViewModel;
        let id = (l.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST') ? l.contentId : null;
        if (!id && l.contentId && (l.contentId.startsWith('PL') || l.contentId.startsWith('VL') || l.contentId.startsWith('MPREb_') || l.contentId.startsWith('RD'))) {
          id = l.contentId;
        }
        if (id && !seenIds.has(id) && id !== 'WL') {
          seenIds.add(id);
          const meta = l.metadata?.lockupMetadataViewModel;
          const title = meta?.title?.content || 'Playlist';
          const sources = l.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources
            || l.contentImage?.thumbnailViewModel?.image?.sources;
          const cover = (Array.isArray(sources) && sources.length > 0) ? sources[sources.length - 1].url : '';
          playlists.push({ id, name: title, cover });
        }
      } else if (node.musicTwoRowItemRenderer) {
        const r = node.musicTwoRowItemRenderer;
        const title = extractText(r.title);
        let browseId = r.navigationEndpoint && r.navigationEndpoint.browseEndpoint && r.navigationEndpoint.browseEndpoint.browseId;
        if (!browseId) {
          const findBrowse = (obj) => {
            if (!obj || typeof obj !== 'object') return null;
            if (obj.browseEndpoint && typeof obj.browseEndpoint.browseId === 'string') return obj.browseEndpoint.browseId;
            for (const k of Object.keys(obj)) {
              const b = findBrowse(obj[k]);
              if (b) return b;
            }
            return null;
          };
          browseId = findBrowse(r);
        }
        if (browseId && !seenIds.has(browseId) && (browseId.startsWith('VL') || browseId.startsWith('PL') || browseId.startsWith('MPREb_') || browseId.includes('playlist') || browseId.startsWith('RD'))) {
          seenIds.add(browseId);
          const thumbs = r.thumbnailRenderer && r.thumbnailRenderer.musicThumbnailRenderer && r.thumbnailRenderer.musicThumbnailRenderer.thumbnail && r.thumbnailRenderer.musicThumbnailRenderer.thumbnail.thumbnails;
          const cover = (Array.isArray(thumbs) && thumbs.length > 0) ? thumbs[thumbs.length - 1].url : '';
          playlists.push({ id: browseId, name: title || 'Playlist', cover });
        }
      } else if (node.gridPlaylistRenderer || node.playlistRenderer || node.compactPlaylistRenderer) {
        const r = node.gridPlaylistRenderer || node.playlistRenderer || node.compactPlaylistRenderer;
        const id = r.playlistId || (r.navigationEndpoint && r.navigationEndpoint.browseEndpoint && r.navigationEndpoint.browseEndpoint.browseId);
        const title = extractText(r.title);
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          const thumbs = (r.thumbnail && r.thumbnail.thumbnails) || (r.thumbnails && r.thumbnails[0] && r.thumbnails[0].thumbnails);
          const cover = (Array.isArray(thumbs) && thumbs.length > 0) ? thumbs[thumbs.length - 1].url : '';
          playlists.push({ id, name: title || 'Playlist', cover });
        }
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item, visited);
      } else {
        for (const k of Object.keys(node)) walk(node[k], visited);
      }
    }
    walk(root);
    return playlists;
  }

  async function fetchInnertube(browseId, continuationToken = null) {
    const ts = Math.floor(Date.now() / 1000);
    const hash = crypto.createHash('sha1').update(`${ts} ${sapisid} ${origin}`).digest('hex');
    const headers = {
      'Authorization': `SAPISIDHASH ${ts}_${hash}`,
      'Content-Type': 'application/json',
      'Origin': origin,
      'Referer': `${origin}/`,
      'X-Origin': origin,
      'X-Goog-AuthUser': '0'
    };
    const body = {
      context: {
        client: {
          clientName,
          clientVersion,
          hl: 'en'
        }
      }
    };
    let targetUrl = browseUrl;
    if (continuationToken) {
      body.continuation = continuationToken;
      targetUrl = `${browseUrl}&continuation=${encodeURIComponent(continuationToken)}`;
    } else if (browseId) {
      body.browseId = browseId;
    }
    const res = await fetchImpl(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      throw new Error(`Innertube request failed: ${res.status}`);
    }
    return await res.json();
  }

  async function fetchAllTracks(browseId) {
    let initial = await fetchInnertube(browseId);
    let tracks = extractTracksGeneric(initial);
    let token = findContinuationToken(initial);
    let safety = 0;
    while (token && safety < 30) {
      safety++;
      const contData = await fetchInnertube(null, token);
      const newTracks = extractTracksGeneric(contData);
      if (!newTracks.length) break;
      tracks = tracks.concat(newTracks);
      const nextToken = findContinuationToken(contData);
      if (!nextToken || nextToken === token) break;
      token = nextToken;
    }
    return tracks;
  }

  async function fetchAllPlaylists(browseId) {
    let initial = await fetchInnertube(browseId);
    let playlists = extractPlaylistsGeneric(initial);
    let token = findContinuationToken(initial);
    let safety = 0;
    while (token && safety < 20) {
      safety++;
      const contData = await fetchInnertube(null, token);
      const newPlaylists = extractPlaylistsGeneric(contData);
      if (!newPlaylists.length) break;
      playlists = playlists.concat(newPlaylists);
      const nextToken = findContinuationToken(contData);
      if (!nextToken || nextToken === token) break;
      token = nextToken;
    }
    const unique = [];
    const seen = new Set();
    for (const pl of playlists) {
      if (!pl.id || seen.has(pl.id)) continue;
      if (pl.id === 'WL' || pl.id.startsWith('RD')) continue;
      seen.add(pl.id);
      unique.push(pl);
    }
    return unique;
  }

  try {
    let likes = [];
    if (doLikes) {
      const rawLikes = await fetchAllTracks(likedBrowseId);
      likes = rawLikes.map(t => ({
        title: t.title,
        artist: t.artist,
        duration: t.duration,
        id: t.videoId,
        url: `https://www.youtube.com/watch?v=${t.videoId}`,
        platform,
        thumbnail: t.cover,
        cover: t.cover
      }));
    }

    let playlists = [];
    if (doPlaylists) {
      const rawPlaylists = await fetchAllPlaylists(playlistsBrowseId);
      for (const pl of rawPlaylists) {
        if (doLikes && (pl.id === 'LL' || pl.id === 'LM')) continue;
        try {
          const plBrowseId = pl.id.startsWith('VL') ? pl.id : `VL${pl.id}`;
          const plTracks = await fetchAllTracks(plBrowseId);
          if (plTracks && plTracks.length > 0) {
            playlists.push({
              id: pl.id,
              name: pl.name,
              cover: pl.cover,
              tracks: plTracks.map(t => ({
                title: t.title,
                artist: t.artist,
                duration: t.duration,
                id: t.videoId,
                url: `https://www.youtube.com/watch?v=${t.videoId}`,
                platform,
                thumbnail: t.cover,
                cover: t.cover
              }))
            });
          }
        } catch (e) {
          // Skip unfetchable playlist
        }
      }
    }

    return { success: true, likes, playlists };
  } catch (err) {
    return { success: false, error: (err && err.message) ? err.message : 'Failed to fetch library' };
  }
}

module.exports = { importGoogleLibrary };
