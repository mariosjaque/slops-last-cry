/*
 * Apple Lossless (ALAC) decoder for the Slop's Last Cry setup.
 * Adapted from alac.js by Audiocogs (https://github.com/audiocogs/alac.js), itself a port of
 * Apple's ALAC decoder. Licensed under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0). Changes: removed the Aurora.js framework,
 * added a small bit reader and an MP4 reader so it can decode .m4a files on its own.
 */
(function () {
  var ALAC = {};
  // MSB-first bit reader providing the subset of Aurora's Bitstream used by the decoder.
  function Bitstream(bytes, bit) { this.b = bytes; this.bit = bit || 0; this.length = bytes.length; }
  Object.defineProperty(Bitstream.prototype, 'bitPosition', { get: function () { return this.bit & 7; } });
  Object.defineProperty(Bitstream.prototype, 'pos', { get: function () { return this.bit >> 3; } });
  Bitstream.prototype.peek = function (n) {
    if (n === 0) return 0;
    var v = 0, p = this.bit;
    for (var i = 0; i < n; i++, p++) { var byte = this.b[p >> 3] || 0; v = v * 2 + ((byte >> (7 - (p & 7))) & 1); }
    return v >= 2147483648 ? v - 4294967296 : v;
  };
  Bitstream.prototype.read = function (n) { var v = this.peek(n); this.bit += n; return n === 32 ? v : (v < 0 ? v + 4294967296 : v); };
  Bitstream.prototype.advance = function (n) { this.bit += n; };
  Bitstream.prototype.align = function () { this.bit = (this.bit + 7) & ~7; };
  Bitstream.prototype.copy = function () { return new Bitstream(this.b, this.bit); };
(function() {
  var Aglib;

  Aglib = (function() {
    var BITOFF, KB0, MAX_DATATYPE_BITS_16, MAX_PREFIX_16, MAX_PREFIX_32, MAX_RUN_DEFAULT, MB0, MDENSHIFT, MMULSHIFT, MOFF, N_MAX_MEAN_CLAMP, N_MEAN_CLAMP_VAL, PB0, QB, QBSHIFT, dyn_get_16, dyn_get_32, lead;

    function Aglib() {}

    PB0 = 40;

    MB0 = 10;

    KB0 = 14;

    MAX_RUN_DEFAULT = 255;

    MAX_PREFIX_16 = 9;

    MAX_PREFIX_32 = 9;

    QBSHIFT = 9;

    QB = 1 << QBSHIFT;

    MMULSHIFT = 2;

    MDENSHIFT = QBSHIFT - MMULSHIFT - 1;

    MOFF = 1 << (MDENSHIFT - 2);

    N_MAX_MEAN_CLAMP = 0xFFFF;

    N_MEAN_CLAMP_VAL = 0xFFFF;

    MMULSHIFT = 2;

    BITOFF = 24;

    MAX_DATATYPE_BITS_16 = 16;

    lead = function(input) {
      var curbyte, output;
      output = 0;
      curbyte = 0;
      while (true) {
        curbyte = input >>> 24;
        if (curbyte) {
          break;
        }
        output += 8;
        curbyte = input >>> 16;
        if (curbyte & 0xff) {
          break;
        }
        output += 8;
        curbyte = input >>> 8;
        if (curbyte & 0xff) {
          break;
        }
        output += 8;
        curbyte = input;
        if (curbyte & 0xff) {
          break;
        }
        output += 8;
        return output;
      }
      if (curbyte & 0xf0) {
        curbyte >>>= 4;
      } else {
        output += 4;
      }
      if (curbyte & 0x8) {
        return output;
      }
      if (curbyte & 0x4) {
        return output + 1;
      }
      if (curbyte & 0x2) {
        return output + 2;
      }
      if (curbyte & 0x1) {
        return output + 3;
      }
      return output + 4;
    };

    dyn_get_16 = function(data, m, k) {
      var bitsInPrefix, offs, result, stream, v;
      offs = data.bitPosition;
      stream = data.peek(32 - offs) << offs;
      bitsInPrefix = lead(~stream);
      if (bitsInPrefix >= MAX_PREFIX_16) {
        data.advance(MAX_PREFIX_16 + MAX_DATATYPE_BITS_16);
        stream <<= MAX_PREFIX_16;
        result = stream >>> (32 - MAX_DATATYPE_BITS_16);
      } else {
        data.advance(bitsInPrefix + k);
        stream <<= bitsInPrefix + 1;
        v = stream >>> (32 - k);
        result = bitsInPrefix * m + v - 1;
        if (v < 2) {
          result -= v - 1;
        } else {
          data.advance(1);
        }
      }
      return result;
    };

    dyn_get_32 = function(data, m, k, maxbits) {
      var offs, result, stream, v;
      offs = data.bitPosition;
      stream = data.peek(32 - offs) << offs;
      result = lead(~stream);
      if (result >= MAX_PREFIX_32) {
        data.advance(MAX_PREFIX_32);
        return data.read(maxbits);
      } else {
        data.advance(result + 1);
        if (k !== 1) {
          stream <<= result + 1;
          result *= m;
          v = stream >>> (32 - k);
          data.advance(k - 1);
          if (v > 1) {
            result += v - 1;
            data.advance(1);
          }
        }
      }
      return result;
    };

    Aglib.ag_params = function(m, p, k, f, s, maxrun) {
      return {
        mb: m,
        mb0: m,
        pb: p,
        kb: k,
        wb: (1 << k) - 1,
        qb: QB - p,
        fw: f,
        sw: s,
        maxrun: maxrun
      };
    };

    Aglib.dyn_decomp = function(params, data, pc, samples, maxSize) {
      var c, j, k, kb, m, mb, multiplier, mz, n, ndecode, pb, wb, zmode, _i;
      pb = params.pb, kb = params.kb, wb = params.wb, mb = params.mb0;
      zmode = 0;
      c = 0;
      while (c < samples) {
        m = mb >>> QBSHIFT;
        k = Math.min(31 - lead(m + 3), kb);
        m = (1 << k) - 1;
        n = dyn_get_32(data, m, k, maxSize);
        ndecode = n + zmode;
        multiplier = -(ndecode & 1) | 1;
        pc[c++] = ((ndecode + 1) >>> 1) * multiplier;
        mb = pb * (n + zmode) + mb - ((pb * mb) >> QBSHIFT);
        if (n > N_MAX_MEAN_CLAMP) {
          mb = N_MEAN_CLAMP_VAL;
        }
        zmode = 0;
        if (((mb << MMULSHIFT) < QB) && (c < samples)) {
          zmode = 1;
          k = lead(mb) - BITOFF + ((mb + MOFF) >> MDENSHIFT);
          mz = ((1 << k) - 1) & wb;
          n = dyn_get_16(data, mz, k);
          if (!(c + n <= samples)) {
            return false;
          }
          for (j = _i = 0; _i < n; j = _i += 1) {
            pc[c++] = 0;
          }
          if (n >= 65535) {
            zmode = 0;
          }
          mb = 0;
        }
      }
      return true;
    };

    return Aglib;

  })();
  ALAC.Aglib = Aglib;

}).call(this);
(function() {
  var Dplib;

  Dplib = (function() {
    var copy;

    function Dplib() {}

    copy = function(dst, dstOffset, src, srcOffset, n) {
      var destination, source;
      destination = new Uint8Array(dst, dstOffset, n);
      source = new Uint8Array(src, srcOffset, n);
      destination.set(source);
      return dst;
    };

    Dplib.unpc_block = function(pc1, out, num, coefs, active, chanbits, denshift) {
      var a0, a1, a2, a3, a4, a5, a6, a7, b0, b1, b2, b3, b4, b5, b6, b7, chanshift, dd, del, del0, denhalf, i, j, lim, offset, prev, sg, sgn, sum1, top, _i, _j, _k, _l, _m, _n, _o, _p, _ref, _ref1;
      chanshift = 32 - chanbits;
      denhalf = 1 << (denshift - 1);
      out[0] = pc1[0];
      if (active === 0) {
        return copy(out, 0, pc1, 0, num * 4);
      }
      if (active === 31) {
        prev = out[0];
        for (i = _i = 1; _i < num; i = _i += 1) {
          del = pc1[i] + prev;
          prev = (del << chanshift) >> chanshift;
          out[i] = prev;
        }
        return;
      }
      for (i = _j = 1; _j <= active; i = _j += 1) {
        del = pc1[i] + out[i - 1];
        out[i] = (del << chanshift) >> chanshift;
      }
      lim = active + 1;
      if (active === 4) {
        a0 = coefs[0], a1 = coefs[1], a2 = coefs[2], a3 = coefs[3];
        for (j = _k = lim; _k < num; j = _k += 1) {
          top = out[j - lim];
          offset = j - 1;
          b0 = top - out[offset];
          b1 = top - out[offset - 1];
          b2 = top - out[offset - 2];
          b3 = top - out[offset - 3];
          sum1 = (denhalf - a0 * b0 - a1 * b1 - a2 * b2 - a3 * b3) >> denshift;
          del = del0 = pc1[j];
          sg = (-del >>> 31) | (del >> 31);
          del += top + sum1;
          out[j] = (del << chanshift) >> chanshift;
          if (sg > 0) {
            sgn = (-b3 >>> 31) | (b3 >> 31);
            a3 -= sgn;
            del0 -= 1 * ((sgn * b3) >> denshift);
            if (del0 <= 0) {
              continue;
            }
            sgn = (-b2 >>> 31) | (b2 >> 31);
            a2 -= sgn;
            del0 -= 2 * ((sgn * b2) >> denshift);
            if (del0 <= 0) {
              continue;
            }
            sgn = (-b1 >>> 31) | (b1 >> 31);
            a1 -= sgn;
            del0 -= 3 * ((sgn * b1) >> denshift);
            if (del0 <= 0) {
              continue;
            }
            a0 -= (-b0 >>> 31) | (b0 >> 31);
          } else if (sg < 0) {
            sgn = -((-b3 >>> 31) | (b3 >> 31));
            a3 -= sgn;
            del0 -= 1 * ((sgn * b3) >> denshift);
            if (del0 >= 0) {
              continue;
            }
            sgn = -((-b2 >>> 31) | (b2 >> 31));
            a2 -= sgn;
            del0 -= 2 * ((sgn * b2) >> denshift);
            if (del0 >= 0) {
              continue;
            }
            sgn = -((-b1 >>> 31) | (b1 >> 31));
            a1 -= sgn;
            del0 -= 3 * ((sgn * b1) >> denshift);
            if (del0 >= 0) {
              continue;
            }
            a0 += (-b0 >>> 31) | (b0 >> 31);
          }
        }
        coefs[0] = a0;
        coefs[1] = a1;
        coefs[2] = a2;
        coefs[3] = a3;
      } else if (active === 8) {
        a0 = coefs[0], a1 = coefs[1], a2 = coefs[2], a3 = coefs[3], a4 = coefs[4], a5 = coefs[5], a6 = coefs[6], a7 = coefs[7];
        for (j = _l = lim; _l < num; j = _l += 1) {
          top = out[j - lim];
          offset = j - 1;
          b0 = top - out[offset];
          b1 = top - out[offset - 1];
          b2 = top - out[offset - 2];
          b3 = top - out[offset - 3];
          b4 = top - out[offset - 4];
          b5 = top - out[offset - 5];
          b6 = top - out[offset - 6];
          b7 = top - out[offset - 7];
          sum1 = (denhalf - a0 * b0 - a1 * b1 - a2 * b2 - a3 * b3 - a4 * b4 - a5 * b5 - a6 * b6 - a7 * b7) >> denshift;
          del = del0 = pc1[j];
          sg = (-del >>> 31) | (del >> 31);
          del += top + sum1;
          out[j] = (del << chanshift) >> chanshift;
          if (sg > 0) {
            sgn = (-b7 >>> 31) | (b7 >> 31);
            a7 -= sgn;
            del0 -= 1 * ((sgn * b7) >> denshift);
            if (del0 <= 0) {
              continue;
            }
            sgn = (-b6 >>> 31) | (b6 >> 31);
            a6 -= sgn;
            del0 -= 2 * ((sgn * b6) >> denshift);
            if (del0 <= 0) {
              continue;
            }
            sgn = (-b5 >>> 31) | (b5 >> 31);
            a5 -= sgn;
            del0 -= 3 * ((sgn * b5) >> denshift);
            if (del0 <= 0) {
              continue;
            }
            sgn = (-b4 >>> 31) | (b4 >> 31);
            a4 -= sgn;
            del0 -= 4 * ((sgn * b4) >> denshift);
            if (del0 <= 0) {
              continue;
            }
            sgn = (-b3 >>> 31) | (b3 >> 31);
            a3 -= sgn;
            del0 -= 5 * ((sgn * b3) >> denshift);
            if (del0 <= 0) {
              continue;
            }
            sgn = (-b2 >>> 31) | (b2 >> 31);
            a2 -= sgn;
            del0 -= 6 * ((sgn * b2) >> denshift);
            if (del0 <= 0) {
              continue;
            }
            sgn = (-b1 >>> 31) | (b1 >> 31);
            a1 -= sgn;
            del0 -= 7 * ((sgn * b1) >> denshift);
            if (del0 <= 0) {
              continue;
            }
            a0 -= (-b0 >>> 31) | (b0 >> 31);
          } else if (sg < 0) {
            sgn = -((-b7 >>> 31) | (b7 >> 31));
            a7 -= sgn;
            del0 -= 1 * ((sgn * b7) >> denshift);
            if (del0 >= 0) {
              continue;
            }
            sgn = -((-b6 >>> 31) | (b6 >> 31));
            a6 -= sgn;
            del0 -= 2 * ((sgn * b6) >> denshift);
            if (del0 >= 0) {
              continue;
            }
            sgn = -((-b5 >>> 31) | (b5 >> 31));
            a5 -= sgn;
            del0 -= 3 * ((sgn * b5) >> denshift);
            if (del0 >= 0) {
              continue;
            }
            sgn = -((-b4 >>> 31) | (b4 >> 31));
            a4 -= sgn;
            del0 -= 4 * ((sgn * b4) >> denshift);
            if (del0 >= 0) {
              continue;
            }
            sgn = -((-b3 >>> 31) | (b3 >> 31));
            a3 -= sgn;
            del0 -= 5 * ((sgn * b3) >> denshift);
            if (del0 >= 0) {
              continue;
            }
            sgn = -((-b2 >>> 31) | (b2 >> 31));
            a2 -= sgn;
            del0 -= 6 * ((sgn * b2) >> denshift);
            if (del0 >= 0) {
              continue;
            }
            sgn = -((-b1 >>> 31) | (b1 >> 31));
            a1 -= sgn;
            del0 -= 7 * ((sgn * b1) >> denshift);
            if (del0 >= 0) {
              continue;
            }
            a0 += (-b0 >>> 31) | (b0 >> 31);
          }
        }
        coefs[0] = a0;
        coefs[1] = a1;
        coefs[2] = a2;
        coefs[3] = a3;
        coefs[4] = a4;
        coefs[5] = a5;
        coefs[6] = a6;
        coefs[7] = a7;
      } else {
        for (i = _m = lim; _m < num; i = _m += 1) {
          sum1 = 0;
          top = out[i - lim];
          offset = i - 1;
          for (j = _n = 0; _n < active; j = _n += 1) {
            sum1 += coefs[j] * (out[offset - j] - top);
          }
          del = del0 = pc1[i];
          sg = (-del >>> 31) | (del >> 31);
          del += top + ((sum1 + denhalf) >> denshift);
          out[i] = (del << chanshift) >> chanshift;
          if (sg > 0) {
            for (j = _o = _ref = active - 1; _o >= 0; j = _o += -1) {
              dd = top - out[offset - j];
              sgn = (-dd >>> 31) | (dd >> 31);
              coefs[j] -= sgn;
              del0 -= (active - j) * ((sgn * dd) >> denshift);
              if (del0 <= 0) {
                break;
              }
            }
          } else if (sg < 0) {
            for (j = _p = _ref1 = active - 1; _p >= 0; j = _p += -1) {
              dd = top - out[offset - j];
              sgn = (-dd >>> 31) | (dd >> 31);
              coefs[j] += sgn;
              del0 -= (active - j) * ((-sgn * dd) >> denshift);
              if (del0 >= 0) {
                break;
              }
            }
          }
        }
      }
    };

    return Dplib;

  })();
  ALAC.Dplib = Dplib;

}).call(this);
(function() {
  var Matrixlib;

  Matrixlib = (function() {
    function Matrixlib() {}

    Matrixlib.unmix16 = function(u, v, out, stride, samples, mixbits, mixres) {
      var i, l, _i, _j;
      if (mixres === 0) {
        for (i = _i = 0; _i < samples; i = _i += 1) {
          out[i * stride + 0] = u[i];
          out[i * stride + 1] = v[i];
        }
      } else {
        for (i = _j = 0; _j < samples; i = _j += 1) {
          l = u[i] + v[i] - ((mixres * v[i]) >> mixbits);
          out[i * stride + 0] = l;
          out[i * stride + 1] = l - v[i];
        }
      }
    };

    return Matrixlib;

  })();
  ALAC.Matrixlib = Matrixlib;

}).call(this);

  var ID_SCE = 0, ID_CPE = 1, ID_CCE = 2, ID_LFE = 3, ID_DSE = 4, ID_PCE = 5, ID_FIL = 6, ID_END = 7;
  function ALACDecoder(cookie) {
    var dv = new DataView(cookie.buffer, cookie.byteOffset, cookie.byteLength), o = 0;
    var tag = function (at) { return String.fromCharCode(cookie[at], cookie[at + 1], cookie[at + 2], cookie[at + 3]); };
    if (tag(4) === 'frma') o += 12;
    if (tag(o + 4) === 'alac') o += 12;
    this.config = {
      frameLength: dv.getUint32(o), compatibleVersion: cookie[o + 4], bitDepth: cookie[o + 5], pb: cookie[o + 6], mb: cookie[o + 7],
      kb: cookie[o + 8], numChannels: cookie[o + 9], maxRun: dv.getUint16(o + 10), maxFrameBytes: dv.getUint32(o + 12),
      avgBitRate: dv.getUint32(o + 16), sampleRate: dv.getUint32(o + 20)
    };
    this.mixBuffers = [new Int32Array(this.config.frameLength), new Int32Array(this.config.frameLength)];
    var predictorBuffer = new ArrayBuffer(this.config.frameLength * 4);
    this.predictor = new Int32Array(predictorBuffer);
    this.shiftBuffer = new Int16Array(predictorBuffer);
  }
    ALACDecoder.prototype.decode = function(data) {
      var buf, bytesShifted, ch, chanBits, channelIndex, channels, coefs, count, dataByteAlignFlag, denShift, elementInstanceTag, end, escapeFlag, i, j, kb, maxRun, mb, mixBits, mixRes, mode, num, numChannels, out16, output, params, partialFrame, pb, pbFactor, samples, shift, shiftbits, status, table, tag, unused, val, _i, _j, _k, _l, _m, _n, _o, _ref, _ref1, _ref2;
      data = new Bitstream(data);
      samples = this.config.frameLength;
      numChannels = this.config.numChannels;
      channelIndex = 0;
      output = new ArrayBuffer(samples * numChannels * this.config.bitDepth / 8);
      end = false;
      while (!end) {
        tag = data.read(3);
        switch (tag) {
          case ID_SCE:
          case ID_LFE:
          case ID_CPE:
            channels = tag === ID_CPE ? 2 : 1;
            if (channelIndex + channels > numChannels) {
              throw new Error('Too many channels!');
            }
            elementInstanceTag = data.read(4);
            unused = data.read(12);
            if (unused !== 0) {
              throw new Error('Unused part of header does not contain 0, it should');
            }
            partialFrame = data.read(1);
            bytesShifted = data.read(2);
            escapeFlag = data.read(1);
            if (bytesShifted === 3) {
              throw new Error("Bytes are shifted by 3, they shouldn't be");
            }
            if (partialFrame) {
              samples = data.read(32);
            }
            if (escapeFlag === 0) {
              shift = bytesShifted * 8;
              chanBits = this.config.bitDepth - shift + channels - 1;
              mixBits = data.read(8);
              mixRes = data.read(8);
              mode = [];
              denShift = [];
              pbFactor = [];
              num = [];
              coefs = [];
              for (ch = _i = 0; _i < channels; ch = _i += 1) {
                mode[ch] = data.read(4);
                denShift[ch] = data.read(4);
                pbFactor[ch] = data.read(3);
                num[ch] = data.read(5);
                table = coefs[ch] = new Int16Array(32);
                for (i = _j = 0, _ref = num[ch]; _j < _ref; i = _j += 1) {
                  table[i] = data.read(16);
                }
              }
              if (bytesShifted) {
                shiftbits = data.copy();
                data.advance(shift * channels * samples);
              }
              _ref1 = this.config, mb = _ref1.mb, pb = _ref1.pb, kb = _ref1.kb, maxRun = _ref1.maxRun;
              for (ch = _k = 0; _k < channels; ch = _k += 1) {
                params = ALAC.Aglib.ag_params(mb, (pb * pbFactor[ch]) / 4, kb, samples, samples, maxRun);
                status = ALAC.Aglib.dyn_decomp(params, data, this.predictor, samples, chanBits);
                if (!status) {
                  throw new Error('Error in ALAC.Aglib.dyn_decomp');
                }
                if (mode[ch] === 0) {
                  ALAC.Dplib.unpc_block(this.predictor, this.mixBuffers[ch], samples, coefs[ch], num[ch], chanBits, denShift[ch]);
                } else {
                  ALAC.Dplib.unpc_block(this.predictor, this.predictor, samples, null, 31, chanBits, 0);
                  ALAC.Dplib.unpc_block(this.predictor, this.mixBuffers[ch], samples, coefs[ch], num[ch], chanBits, denShift[ch]);
                }
              }
            } else {
              chanBits = this.config.bitDepth;
              shift = 32 - chanBits;
              for (i = _l = 0; _l < samples; i = _l += 1) {
                for (ch = _m = 0; _m < channels; ch = _m += 1) {
                  val = (data.read(chanBits) << shift) >> shift;
                  this.mixBuffers[ch][i] = val;
                }
              }
              mixBits = mixRes = 0;
              bytesShifted = 0;
            }
            if (bytesShifted) {
              shift = bytesShifted * 8;
              for (i = _n = 0, _ref2 = samples * channels; _n < _ref2; i = _n += 1) {
                this.shiftBuffer[i] = shiftbits.read(shift);
              }
            }
            switch (this.config.bitDepth) {
              case 16:
                out16 = new Int16Array(output, channelIndex);
                if (channels === 2) {
                  ALAC.Matrixlib.unmix16(this.mixBuffers[0], this.mixBuffers[1], out16, numChannels, samples, mixBits, mixRes);
                } else {
                  j = 0;
                  buf = this.mixBuffers[0];
                  for (i = _o = 0; _o < samples; i = _o += 1) {
                    out16[j] = buf[i];
                    j += numChannels;
                  }
                }
                break;
              default:
                throw new Error('Only supports 16-bit samples right now');
            }
            channelIndex += channels;
            break;
          case ID_CCE:
          case ID_PCE:
            throw new Error("Unsupported element: " + tag);
            break;
          case ID_DSE:
            elementInstanceTag = data.read(4);
            dataByteAlignFlag = data.read(1);
            count = data.read(8);
            if (count === 255) {
              count += data.read(8);
            }
            if (dataByteAlignFlag) {
              data.align();
            }
            data.advance(count * 8);
            if (!(data.pos < data.length)) {
              throw new Error('buffer overrun');
            }
            break;
          case ID_FIL:
            count = data.read(4);
            if (count === 15) {
              count += data.read(8) - 1;
            }
            data.advance(count * 8);
            if (!(data.pos < data.length)) {
              throw new Error('buffer overrun');
            }
            break;
          case ID_END:
            data.align();
            end = true;
            break;
          default:
            throw new Error("Unknown element: " + tag);
        }
        if (channelIndex > numChannels) {
          throw new Error('Channel index too large.');
        }
      }
      return new Int16Array(output);
    };


  // Decodes a whole .m4a (ALAC in MP4) file into Float32 channel arrays.
  function box(b, start, end, path) {
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (var p = start; p + 8 <= end;) {
      var size = dv.getUint32(p), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]), hdr = 8;
      if (size === 1) { size = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12); hdr = 16; }
      if (size === 0) size = end - p;
      if (type === path[0]) return path.length === 1 ? { s: p + hdr, e: p + size } : box(b, p + hdr + (path[0] === 'stsd' ? 8 : 0), p + size, path.slice(1));
      p += size;
    }
    return null;
  }
  ALAC.decodeM4A = function (bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var stbl = box(bytes, 0, bytes.length, ['moov', 'trak', 'mdia', 'minf', 'stbl']);
    if (!stbl) throw new Error('no sample table');
    var stsd = box(bytes, stbl.s, stbl.e, ['stsd']);
    var entry = stsd.s + 8;                                   // first sample entry
    var esz = dv.getUint32(entry);
    var cookieBox = box(bytes, entry + 36, entry + esz, ['alac']);
    if (!cookieBox) throw new Error('not ALAC');
    var dec = new ALACDecoder(bytes.subarray(cookieBox.s + 4, cookieBox.e));
    var stsz = box(bytes, stbl.s, stbl.e, ['stsz']), stco = box(bytes, stbl.s, stbl.e, ['stco']), stsc = box(bytes, stbl.s, stbl.e, ['stsc']);
    var fixed = dv.getUint32(stsz.s + 4), count = dv.getUint32(stsz.s + 8);
    var sizes = []; for (var i = 0; i < count; i++) sizes.push(fixed || dv.getUint32(stsz.s + 12 + i * 4));
    var nch = dv.getUint32(stco.s + 4), offs = []; for (i = 0; i < nch; i++) offs.push(dv.getUint32(stco.s + 8 + i * 4));
    var nsc = dv.getUint32(stsc.s + 4), runs = []; for (i = 0; i < nsc; i++) runs.push([dv.getUint32(stsc.s + 8 + i * 12), dv.getUint32(stsc.s + 12 + i * 12)]);
    var positions = [], s = 0;
    for (var c = 0; c < nch; c++) {
      var per = runs[0][1]; for (var r = 0; r < runs.length; r++) if (runs[r][0] - 1 <= c) per = runs[r][1];
      var p = offs[c]; for (var k = 0; k < per && s < count; k++, s++) { positions.push([p, sizes[s]]); p += sizes[s]; }
    }
    var ch = dec.config.numChannels, fl = dec.config.frameLength;
    var out = []; for (i = 0; i < ch; i++) out.push(new Float32Array(count * fl));
    var n = 0;
    for (i = 0; i < positions.length; i++) {
      var pcm = dec.decode(bytes.subarray(positions[i][0], positions[i][0] + positions[i][1]));
      var frames = pcm.length / ch;
      for (var f = 0; f < frames; f++) for (var cc = 0; cc < ch; cc++) out[cc][n + f] = pcm[f * ch + cc] / 32768;
      n += frames;
    }
    return { sampleRate: dec.config.sampleRate, channels: out.map(function (a) { return a.subarray(0, n); }) };
  };
  ALAC.ALACDecoder = ALACDecoder;
  (typeof window !== 'undefined' ? window : globalThis).ALAC = ALAC;
})();
