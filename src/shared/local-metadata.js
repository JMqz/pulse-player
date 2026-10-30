// Local audio file metadata (ID3v2 / FLAC Vorbis comments + ffprobe/ffmpeg fallback) and embedded cover
// extraction. Shared by the Electron main process and the Pulse (Tauri) Node host.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const { execFile } = require('child_process');

async function extractLocalTrackMetadata(filePath, coversDir) {
  if (!filePath || typeof filePath !== 'string') return null;
  fs.mkdirSync(coversDir, { recursive: true });

  const fileHash = crypto.createHash('md5').update(filePath).digest('hex');
  const coverOut = path.join(coversDir, fileHash + '.jpg');

  let title = '';
  let artist = '';
  let album = '';
  let trackNum = 0;
  let duration = 0;

  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(10);
    const bytesRead = fs.readSync(fd, header, 0, 10, 0);

    if (bytesRead >= 10 && header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) {
      const id3Version = header[3];
      const id3Flags = header[5];
      const tagSize = (header[6] << 21) | (header[7] << 14) | (header[8] << 7) | header[9];
      const readLimit = Math.min(tagSize, 12 * 1024 * 1024);
      const tagBuf = Buffer.alloc(readLimit);
      fs.readSync(fd, tagBuf, 0, tagBuf.length, 10);

      let offset = 0;
      if (id3Flags & 0x40) {
        if (id3Version === 4 && offset + 4 <= tagBuf.length) {
          const extSize = (tagBuf[offset] << 21) | (tagBuf[offset + 1] << 14) | (tagBuf[offset + 2] << 7) | tagBuf[offset + 3];
          offset += extSize;
        } else if (id3Version === 3 && offset + 4 <= tagBuf.length) {
          const extSize = tagBuf.readUInt32BE(offset);
          offset += 4 + extSize;
        }
      }

      function decodeId3Text(buf) {
        if (!buf || buf.length <= 1) return '';
        const enc = buf[0];
        const data = buf.subarray(1);
        if (enc === 0) return data.toString('latin1').replace(/\0+$/, '');
        if (enc === 1) {
          if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
            return data.swap16().toString('utf16le').replace(/\0+$/, '');
          }
          return data.toString('utf16le').replace(/\0+$/, '');
        }
        if (enc === 2) {
          return data.swap16().toString('utf16le').replace(/\0+$/, '');
        }
        if (enc === 3) return data.toString('utf8').replace(/\0+$/, '');
        return data.toString('utf8').replace(/\0+$/, '');
      }

      while (offset + 10 <= tagBuf.length) {
        if (tagBuf[offset] === 0) break;
        const frameId = tagBuf.toString('latin1', offset, offset + 4);
        if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
        let frameSize = 0;
        if (id3Version === 4) {
          frameSize = (tagBuf[offset + 4] << 21) | (tagBuf[offset + 5] << 14) | (tagBuf[offset + 6] << 7) | tagBuf[offset + 7];
        } else {
          frameSize = tagBuf.readUInt32BE(offset + 4);
        }
        offset += 10;
        if (frameSize <= 0 || offset + frameSize > tagBuf.length) break;

        const frameData = tagBuf.subarray(offset, offset + frameSize);
        if (frameId === 'TIT2' && !title) {
          title = decodeId3Text(frameData).trim();
        } else if (frameId === 'TPE1' && !artist) {
          artist = decodeId3Text(frameData).trim();
        } else if (frameId === 'TPE2' && !artist) {
          artist = decodeId3Text(frameData).trim();
        } else if (frameId === 'TALB' && !album) {
          album = decodeId3Text(frameData).trim();
        } else if (frameId === 'TRCK' && !trackNum) {
          const val = decodeId3Text(frameData).trim();
          const n = parseInt(val.split('/')[0], 10);
          if (!isNaN(n)) trackNum = n;
        } else if (frameId === 'TLEN' && !duration) {
          const ms = parseInt(decodeId3Text(frameData).trim(), 10);
          if (!isNaN(ms) && ms > 0) duration = ms / 1000;
        } else if (frameId === 'APIC' && !fs.existsSync(coverOut)) {
          try {
            const enc = frameData[0];
            let p = 1;
            while (p < frameData.length && frameData[p] !== 0) p++;
            p++;
            p++;
            if (enc === 1 || enc === 2) {
              while (p + 1 < frameData.length && !(frameData[p] === 0 && frameData[p + 1] === 0)) p += 2;
              p += 2;
            } else {
              while (p < frameData.length && frameData[p] !== 0) p++;
              p++;
            }
            if (p < frameData.length) {
              const imgBuf = frameData.subarray(p);
              if (imgBuf.length > 32) {
                fs.writeFileSync(coverOut, imgBuf);
              }
            }
          } catch (e) {}
        }
        offset += frameSize;
      }
    } else if (bytesRead >= 4 && header.subarray(0, 4).toString('latin1') === 'fLaC') {
      let pos = 4;
      let isLast = false;
      while (!isLast) {
        const blkHeader = Buffer.alloc(4);
        if (fs.readSync(fd, blkHeader, 0, 4, pos) < 4) break;
        pos += 4;
        isLast = (blkHeader[0] & 0x80) !== 0;
        const blockType = blkHeader[0] & 0x7F;
        const blockLength = (blkHeader[1] << 16) | (blkHeader[2] << 8) | blkHeader[3];

        if (blockType === 0 && blockLength >= 18) {
          const sBuf = Buffer.alloc(Math.min(blockLength, 34));
          fs.readSync(fd, sBuf, 0, sBuf.length, pos);
          const sampleRate = (sBuf[10] << 12) | (sBuf[11] << 4) | (sBuf[12] >> 4);
          const totalSamples = ((sBuf[13] & 0x0f) * 0x100000000) +
            (sBuf[14] << 24 >>> 0) + (sBuf[15] << 16) + (sBuf[16] << 8) + sBuf[17];
          if (sampleRate > 0 && totalSamples > 0 && !duration) {
            duration = totalSamples / sampleRate;
          }
        } else if (blockType === 4) {
          const vBuf = Buffer.alloc(Math.min(blockLength, 1024 * 1024));
          fs.readSync(fd, vBuf, 0, vBuf.length, pos);
          let vPos = 0;
          if (vPos + 4 <= vBuf.length) {
            const vendorLen = vBuf.readUInt32LE(vPos);
            vPos += 4 + vendorLen;
            if (vPos + 4 <= vBuf.length) {
              const count = vBuf.readUInt32LE(vPos);
              vPos += 4;
              for (let i = 0; i < count && vPos + 4 <= vBuf.length; i++) {
                const commentLen = vBuf.readUInt32LE(vPos);
                vPos += 4;
                if (vPos + commentLen > vBuf.length) break;
                const comment = vBuf.toString('utf8', vPos, vPos + commentLen);
                vPos += commentLen;
                const eq = comment.indexOf('=');
                if (eq > 0) {
                  const key = comment.slice(0, eq).toUpperCase();
                  const val = comment.slice(eq + 1).trim();
                  if (key === 'TITLE' && !title) title = val;
                  else if (key === 'ARTIST' && !artist) artist = val;
                  else if (key === 'ALBUM' && !album) album = val;
                  else if (key === 'TRACKNUMBER' && !trackNum) {
                    const n = parseInt(val.split('/')[0], 10);
                    if (!isNaN(n)) trackNum = n;
                  }
                }
              }
            }
          }
        } else if (blockType === 6 && !fs.existsSync(coverOut)) {
          try {
            const pBuf = Buffer.alloc(Math.min(blockLength, 12 * 1024 * 1024));
            fs.readSync(fd, pBuf, 0, pBuf.length, pos);
            let pPos = 4;
            const mimeLen = pBuf.readUInt32BE(pPos);
            pPos += 4 + mimeLen;
            const descLen = pBuf.readUInt32BE(pPos);
            pPos += 4 + descLen + 16;
            const picLen = pBuf.readUInt32BE(pPos);
            pPos += 4;
            if (picLen > 0 && pPos + picLen <= pBuf.length) {
              fs.writeFileSync(coverOut, pBuf.subarray(pPos, pPos + picLen));
            }
          } catch (e) {}
        }
        pos += blockLength;
      }
    }
  } catch (e) {
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (e) {}
    }
  }

  const platform = require('./platform');
  const ffprobeBin = platform.resolveBinary('ffprobe');
  const ffmpegBin = platform.resolveBinary('ffmpeg');

  if ((!title || !artist || !duration) && ffprobeBin) {
    await new Promise(resolve => {
      execFile(ffprobeBin, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath
      ], { timeout: 5000 }, (err, stdout) => {
        if (!err && stdout) {
          try {
            const info = JSON.parse(stdout);
            const tags = (info.format && info.format.tags) || {};
            const getTag = (name) => {
              const k = Object.keys(tags).find(x => x.toLowerCase() === name.toLowerCase());
              return k ? String(tags[k]).trim() : '';
            };
            if (!title) title = getTag('title');
            if (!artist) artist = getTag('artist') || getTag('album_artist') || getTag('composer');
            if (!album) album = getTag('album');
            if (!trackNum) {
              const trk = getTag('track');
              const n = parseInt(trk.split('/')[0], 10);
              if (!isNaN(n)) trackNum = n;
            }
            if (!duration && info.format && info.format.duration) {
              const d = parseFloat(info.format.duration);
              if (!isNaN(d) && d > 0) duration = d;
            }
          } catch (e) {}
        }
        resolve();
      });
    });
  } else if ((!title || !artist || !duration) && ffmpegBin) {
    // Pulse ships ffmpeg only: `ffmpeg -i` prints the container tags and duration to stderr.
    await new Promise(resolve => {
      execFile(ffmpegBin, ['-hide_banner', '-i', filePath], { timeout: 5000 }, (_err, _stdout, stderr) => {
        const text = String(stderr || '');
        const meta = text.split(/\r?\n/).slice(0, 80);
        const getTag = (name) => {
          const re = new RegExp(`^\\s+${name}\\s*:\\s*(.+)$`, 'i');
          for (const line of meta) {
            const m = line.match(re);
            if (m) return m[1].trim();
          }
          return '';
        };
        if (!title) title = getTag('title');
        if (!artist) artist = getTag('artist') || getTag('album_artist') || getTag('composer');
        if (!album) album = getTag('album');
        if (!trackNum) {
          const n = parseInt(getTag('track').split('/')[0], 10);
          if (!isNaN(n)) trackNum = n;
        }
        if (!duration) {
          const m = text.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
          if (m) {
            const d = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
            if (d > 0) duration = d;
          }
        }
        resolve();
      });
    });
  }

  if (!fs.existsSync(coverOut) && ffmpegBin) {
    await new Promise(resolve => {
      execFile(ffmpegBin, [
        '-y',
        '-i', filePath,
        '-an',
        '-vcodec', 'mjpeg',
        '-frames:v', '1',
        coverOut
      ], { timeout: 5000 }, () => resolve());
    });
  }

  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  if (!title) {
    if (base.includes(' - ')) {
      const parts = base.split(' - ');
      if (!artist) artist = parts[0].trim();
      title = parts.slice(1).join(' - ').trim();
    } else {
      title = base.trim();
    }
  }
  if (!artist) {
    artist = 'Unknown Artist';
  }

  return {
    id: 'local_' + fileHash,
    title,
    artist: artist || 'Unknown Artist',
    album: album || '',
    trackNumber: trackNum || 0,
    duration: Math.round(duration || 0),
    path: filePath,
    url: url.pathToFileURL(filePath).toString(),
    thumbnail: fs.existsSync(coverOut) ? url.pathToFileURL(coverOut).toString() : '',
    cover: fs.existsSync(coverOut) ? url.pathToFileURL(coverOut).toString() : '',
    platform: 'local'
  };
}

module.exports = { extractLocalTrackMetadata };
