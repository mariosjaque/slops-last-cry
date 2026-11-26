/*
 * Slop's Last Cry for New 3DS: the shared core.
 *
 * The game logic lives in game.js (the same file the Vita version runs). This file gives it what a
 * browser would: two portrait canvases (the console is held like a book), pictures, text drawn with
 * the bundled fonts, an audio mixer for IMA ADPCM tracks streamed from the SD card (with
 * sample-exact loop points), movies stored as JPEG frames, touch, buttons, the accelerometer, the
 * system keyboard and file access. Drawing goes through the small gfx_* layer of the platform.
 */
#include "core.h"
#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <sys/stat.h>

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_JPEG
#define STBI_ONLY_PNG
#define STBI_NO_LINEAR
#define STBI_NO_HDR
#include "stb_image.h"
#define STB_TRUETYPE_IMPLEMENTATION
#include "stb_truetype.h"

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

int core_running = 1;
static JSContext *ctx;
static JSRuntime *rt;
static int rotation = 90;       /* 90: top screen on the left, 270: on the right */
static int cur_scr = 0;
static unsigned frame_no = 0;
static int audio_paused = 0;

/* ------------------------------------------------------------------ screens */
static const int PW[2] = { 400, 320 };          /* physical widths (landscape) */
#define VWID 360.0f                              /* canvas width in game units */
#define K (SCR_H / VWID)                         /* game units -> pixels */
/* game canvas point -> physical pixel of the current screen */
static void v2p(float x, float y, float *px, float *py) {
    if (rotation == 90) { *px = PW[cur_scr] - K * y; *py = K * x; }
    else { *px = K * y; *py = SCR_H - K * x; }
}
static float rot_angle(void) { return rotation == 90 ? (float)(M_PI / 2) : (float)(-M_PI / 2); }
int core_rotation(void) { return rotation; }

/* ------------------------------------------------------------------ files */
static char *read_file(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    if (n < 0) { fclose(f); return NULL; }
    char *b = malloc((size_t)n + 1);
    if (!b) { fclose(f); return NULL; }
    size_t got = fread(b, 1, (size_t)n, f);
    fclose(f);
    b[got] = 0;
    if (len) *len = got;
    return b;
}
static void mkdirs(const char *path) {
    char tmp[512]; snprintf(tmp, sizeof tmp, "%s", path);
    for (char *p = tmp + 1; *p; p++) if (*p == '/' && p[-1] != ':') { *p = 0; mkdir(tmp, 0777); *p = '/'; }
}
static int write_file(const char *path, const char *data, size_t len) {
    mkdirs(path);
    char tmp[520]; snprintf(tmp, sizeof tmp, "%s.tmp", path);
    FILE *f = fopen(tmp, "wb");
    if (!f) return 0;
    size_t w = fwrite(data, 1, len, f);
    fclose(f);
    if (w != len) { remove(tmp); return 0; }
    remove(path);                       /* rename does not replace on every file system */
    return rename(tmp, path) == 0;
}

/* ------------------------------------------------------------------ pictures */
#define MAX_IMG 512
typedef struct { GTex *t; int w, h; float lw, lh; } Img;   /* texture size, and the size the game sees */
static Img imgs[MAX_IMG];
static int img_new(GTex *t, int w, int h, float lw, float lh) {
    for (int i = 1; i < MAX_IMG; i++) if (!imgs[i].t) { imgs[i].t = t; imgs[i].w = w; imgs[i].h = h; imgs[i].lw = lw > 0 ? lw : w; imgs[i].lh = lh > 0 ? lh : h; return i; }
    gfx_tex_free(t);
    return -1;
}
/* box-filter downscale of RGBA pixels */
static unsigned char *shrink_rgba(const unsigned char *src, int w, int h, int nw, int nh) {
    unsigned char *d = malloc((size_t)nw * nh * 4);
    if (!d) return NULL;
    for (int y = 0; y < nh; y++) {
        int y0 = y * h / nh, y1 = (y + 1) * h / nh; if (y1 <= y0) y1 = y0 + 1;
        for (int x = 0; x < nw; x++) {
            int x0 = x * w / nw, x1 = (x + 1) * w / nw; if (x1 <= x0) x1 = x0 + 1;
            unsigned acc[4] = { 0, 0, 0, 0 }, n = 0;
            for (int yy = y0; yy < y1; yy++) for (int xx = x0; xx < x1; xx++) { const unsigned char *p = src + ((size_t)yy * w + xx) * 4; acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2]; acc[3] += p[3]; n++; }
            unsigned char *q = d + ((size_t)y * nw + x) * 4;
            for (int k = 0; k < 4; k++) q[k] = (unsigned char)(acc[k] / n);
        }
    }
    return d;
}
static int make_image(unsigned char *px, int w, int h, float lw, float lh) {
    int mx = gfx_max_tex();
    if (w > mx || h > mx) {
        float s = fminf((float)mx / w, (float)mx / h);
        int nw = (int)(w * s), nh = (int)(h * s); if (nw < 1) nw = 1; if (nh < 1) nh = 1;
        unsigned char *d = shrink_rgba(px, w, h, nw, nh);
        if (!d) return -1;
        if (lw <= 0) { lw = w; lh = h; }
        stbi_image_free(px); px = d; w = nw; h = nh;
    }
    int opaque = 1;
    for (size_t i = 3; i < (size_t)w * h * 4; i += 4) if (px[i] != 255) { opaque = 0; break; }
    GTex *t = gfx_tex_new(w, h, opaque ? GT_OPAQUE : GT_RGBA);
    if (!t) { free(px); return -1; }
    gfx_tex_upload(t, px);
    free(px);
    return img_new(t, w, h, lw, lh);
}

/* ------------------------------------------------------------------ fonts and text */
#define MAX_FONT 64
typedef struct { char *path; unsigned char *data; } FontFile;
static FontFile ffiles[16];
typedef struct { int used; stbtt_fontinfo info; float scale; int asc, desc; } Font;
static Font fonts[MAX_FONT];
static unsigned char *font_data(const char *path) {
    for (int i = 0; i < 16; i++) if (ffiles[i].path && !strcmp(ffiles[i].path, path)) return ffiles[i].data;
    unsigned char *d = (unsigned char *)read_file(path, NULL);
    if (!d) return NULL;
    for (int i = 0; i < 16; i++) if (!ffiles[i].path) { ffiles[i].path = strdup(path); ffiles[i].data = d; return d; }
    return d;
}
static int utf8_next(const char **ps) {
    const unsigned char *s = (const unsigned char *)*ps; int c = *s;
    if (!c) return 0;
    if (c < 0x80) { *ps += 1; return c; }
    if ((c & 0xE0) == 0xC0 && s[1]) { *ps += 2; return ((c & 0x1F) << 6) | (s[1] & 0x3F); }
    if ((c & 0xF0) == 0xE0 && s[1] && s[2]) { *ps += 3; return ((c & 0x0F) << 12) | ((s[1] & 0x3F) << 6) | (s[2] & 0x3F); }
    if ((c & 0xF8) == 0xF0 && s[1] && s[2] && s[3]) { *ps += 4; return ((c & 0x07) << 18) | ((s[1] & 0x3F) << 12) | ((s[2] & 0x3F) << 6) | (s[3] & 0x3F); }
    *ps += 1; return '?';
}
/* the font has no glyph for some typographic characters: use a close one */
static int glyph_for(Font *f, int cp) {
    if (stbtt_FindGlyphIndex(&f->info, cp)) return cp;
    switch (cp) { case 0x2018: case 0x2019: return '\''; case 0x201C: case 0x201D: return '"'; case 0x2014: case 0x2013: return '-'; case 0x2026: return '.'; case 0xA0: return ' '; }
    return cp;
}
static float text_px_width(Font *f, const char *s) {
    float w = 0; int prev = 0;
    while (*s) {
        int cp = glyph_for(f, utf8_next(&s)); int adv, lsb;
        stbtt_GetCodepointHMetrics(&f->info, cp, &adv, &lsb);
        if (prev) w += f->scale * stbtt_GetCodepointKernAdvance(&f->info, prev, cp);
        w += f->scale * adv; prev = cp;
    }
    return w;
}
typedef struct TextEntry { int font; char *s; GTex *t; int w, h; unsigned stamp; struct TextEntry *next; } TextEntry;
#define TC_BUCKETS 1024
static TextEntry *tcache[TC_BUCKETS];
static int tc_count = 0;
static unsigned hash_str(int f, const char *s) { unsigned h = 2166136261u ^ (unsigned)f; while (*s) { h ^= (unsigned char)*s++; h *= 16777619u; } return h; }
static void tc_evict(unsigned age) {
    for (int b = 0; b < TC_BUCKETS; b++) {
        TextEntry **pp = &tcache[b];
        while (*pp) {
            TextEntry *e = *pp;
            if (frame_no - e->stamp > age) { *pp = e->next; if (e->t) gfx_tex_free(e->t); free(e->s); free(e); tc_count--; }
            else pp = &e->next;
        }
    }
}
/* renders a string (white mask, 1 pixel margin) */
static TextEntry *text_get(int fi, const char *s) {
    if (fi <= 0 || fi >= MAX_FONT || !fonts[fi].used || !*s) return NULL;
    unsigned h = hash_str(fi, s) % TC_BUCKETS;
    for (TextEntry *e = tcache[h]; e; e = e->next) if (e->font == fi && !strcmp(e->s, s)) { e->stamp = frame_no; return e; }
    Font *f = &fonts[fi];
    int bw = (int)ceilf(text_px_width(f, s)) + 4, bh = f->asc - f->desc + 2;
    int mx = gfx_max_tex(); if (bw > mx) bw = mx;
    unsigned char *bmp = calloc((size_t)bw * bh, 1);
    if (!bmp) return NULL;
    float pen = 1; int prev = 0; const char *p = s; int base = 1 + f->asc;
    unsigned char *gl = NULL; size_t glcap = 0;
    while (*p) {
        int cp = glyph_for(f, utf8_next(&p)); int adv, lsb;
        stbtt_GetCodepointHMetrics(&f->info, cp, &adv, &lsb);
        if (prev) pen += f->scale * stbtt_GetCodepointKernAdvance(&f->info, prev, cp);
        int ix = (int)floorf(pen); float sh = pen - ix;
        int x0, y0, x1, y1;
        stbtt_GetCodepointBitmapBoxSubpixel(&f->info, cp, f->scale, f->scale, sh, 0, &x0, &y0, &x1, &y1);
        int gw = x1 - x0, gh = y1 - y0;
        if (gw > 0 && gh > 0) {
            if ((size_t)gw * gh > glcap) { glcap = (size_t)gw * gh; free(gl); gl = malloc(glcap); }
            if (gl) {
                stbtt_MakeCodepointBitmapSubpixel(&f->info, gl, gw, gh, gw, f->scale, f->scale, sh, 0, cp);
                for (int yy = 0; yy < gh; yy++) {
                    int ty = base + y0 + yy; if (ty < 0 || ty >= bh) continue;
                    for (int xx = 0; xx < gw; xx++) {
                        int tx = ix + x0 + xx; if (tx < 0 || tx >= bw) continue;
                        unsigned char v = gl[yy * gw + xx], *d = &bmp[ty * bw + tx];
                        if (v > *d) *d = v;
                    }
                }
            }
        }
        pen += f->scale * adv; prev = cp;
    }
    free(gl);
    TextEntry *e = calloc(1, sizeof *e);
    e->font = fi; e->s = strdup(s); e->w = bw; e->h = bh; e->stamp = frame_no;
    e->t = gfx_tex_new(bw, bh, GT_A8);
    if (e->t) gfx_tex_upload(e->t, bmp);
    free(bmp);
    e->next = tcache[h]; tcache[h] = e;
    if (++tc_count > 700) tc_evict(90);
    return e;
}

/* ------------------------------------------------------------------ sound: IMA ADPCM (.slca) */
/* Header: "SLCA", u8 version, u8 channels, u16 0, u32 rate, u32 frames, u32 block frames, u32 blocks.
 * Each block holds, per channel: s16 predictor, u8 step index, u8 0, then (block frames / 2) bytes
 * of 4-bit codes (low nibble first). The state is the encoder's at the block start, so any block
 * decodes on its own. */
static const short ima_step[89] = { 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767 };
static const signed char ima_idx[16] = { -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8 };
#define MAX_BF 2048
typedef struct {
    FILE *f; unsigned char *mem;          /* small sounds stay in memory, long ones stream */
    int channels; unsigned rate, total, bf, nblk, bsize;
} Sound;
#define MAX_SND 256
#define MAX_VOICE 32
static Sound *sounds[MAX_SND];
typedef struct {
    int used, snd, playing, ended;
    short buf[MAX_BF * 2]; int bufn, bufpos;  /* decoded block (stereo), read position */
    unsigned blk;                              /* next block to decode */
    long long pos, loop_s, loop_e; int rep;
    float vol, cur;
    unsigned char raw[2 * (4 + MAX_BF / 2)];
} Voice;
static Voice voices[MAX_VOICE];

static Sound *snd_load(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    unsigned char h[24];
    if (fread(h, 1, 24, f) != 24 || memcmp(h, "SLCA", 4)) { fclose(f); return NULL; }
    Sound *s = calloc(1, sizeof *s);
    s->channels = h[5] == 1 ? 1 : 2;
    s->rate = h[8] | h[9] << 8 | h[10] << 16 | (unsigned)h[11] << 24;
    s->total = h[12] | h[13] << 8 | h[14] << 16 | (unsigned)h[15] << 24;
    s->bf = h[16] | h[17] << 8 | h[18] << 16 | (unsigned)h[19] << 24;
    s->nblk = h[20] | h[21] << 8 | h[22] << 16 | (unsigned)h[23] << 24;
    if (s->bf == 0 || s->bf > MAX_BF || (s->bf & 1)) { fclose(f); free(s); return NULL; }
    s->bsize = s->channels * (4 + s->bf / 2);
    size_t data = (size_t)s->bsize * s->nblk;
    if (data <= 192 * 1024) {
        s->mem = malloc(data ? data : 1);
        if (s->mem && fread(s->mem, 1, data, f) == data) { fclose(f); return s; }
        free(s->mem); s->mem = NULL;
    }
    s->f = f;
    return s;
}
static void snd_free(Sound *s) { if (s->f) fclose(s->f); free(s->mem); free(s); }
static int voice_decode(Voice *v) {
    Sound *s = sounds[v->snd];
    if (!s || v->blk >= s->nblk) return 0;
    const unsigned char *b;
    if (s->mem) b = s->mem + (size_t)v->blk * s->bsize;
    else {
        if (fseek(s->f, 24 + (long)v->blk * s->bsize, SEEK_SET) || fread(v->raw, 1, s->bsize, s->f) != s->bsize) { v->blk = s->nblk; return 0; }
        b = v->raw;
    }
    v->blk++;
    int n = (int)s->bf;
    for (int c = 0; c < s->channels; c++) {
        const unsigned char *q = b + c * (4 + s->bf / 2);
        int pred = (short)(q[0] | q[1] << 8), idx = q[2]; if (idx > 88) idx = 88;
        q += 4;
        short *o = v->buf + c;
        for (int i = 0; i < n; i++) {
            int code = (i & 1) ? (q[i >> 1] >> 4) : (q[i >> 1] & 15);
            int step = ima_step[idx], diff = step >> 3;
            if (code & 1) diff += step >> 2;
            if (code & 2) diff += step >> 1;
            if (code & 4) diff += step;
            pred += (code & 8) ? -diff : diff;
            if (pred > 32767) pred = 32767; else if (pred < -32768) pred = -32768;
            idx += ima_idx[code]; if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
            o[i * 2] = (short)pred;
        }
    }
    if (s->channels == 1) for (int i = 0; i < n; i++) v->buf[i * 2 + 1] = v->buf[i * 2];
    v->bufn = n; v->bufpos = 0;
    return 1;
}
static void voice_seek(Voice *v, long long to) {
    Sound *s = sounds[v->snd];
    if (to < 0) to = 0;
    v->blk = (unsigned)(to / s->bf); v->bufn = v->bufpos = 0;
    if (voice_decode(v)) v->bufpos = (int)(to % s->bf);
    v->pos = to;
}
void core_mix(short *out, int frames) {
    static float mix[4096 * 2];
    if (frames > 4096) frames = 4096;
    memset(mix, 0, sizeof(float) * frames * 2);
    plat_audio_lock();
    if (!audio_paused) for (int vi = 0; vi < MAX_VOICE; vi++) {
        Voice *v = &voices[vi];
        if (!v->used || !v->playing || v->ended) continue;
        Sound *s = sounds[v->snd];
        if (!s) { v->ended = 1; continue; }
        /* the loop end only applies while there are repeats left (as in the web engine) */
        long long end = (v->rep != 0 && v->loop_e > 0) ? v->loop_e : s->total;
        float step = (v->vol - v->cur) / frames;
        for (int i = 0; i < frames; i++) {
            if (v->pos >= end || v->pos >= s->total) {
                if (v->rep != 0) { if (v->rep > 0) v->rep--; voice_seek(v, v->loop_s > 0 ? v->loop_s : 0); end = (v->rep != 0 && v->loop_e > 0) ? v->loop_e : s->total; }
                else { v->ended = 1; break; }
            }
            if (v->bufpos >= v->bufn && !voice_decode(v)) { v->pos = s->total; continue; }
            v->cur += step;
            mix[i * 2] += v->buf[v->bufpos * 2] * v->cur;
            mix[i * 2 + 1] += v->buf[v->bufpos * 2 + 1] * v->cur;
            v->bufpos++; v->pos++;
        }
        v->cur = v->vol;
    }
    plat_audio_unlock();
    for (int i = 0; i < frames * 2; i++) { float x = mix[i]; if (x > 32767) x = 32767; else if (x < -32768) x = -32768; out[i] = (short)x; }
}
void core_set_paused(int p) { audio_paused = p; }

/* ------------------------------------------------------------------ movies (JPEG frames) */
#define MAX_MOV 8
typedef struct { unsigned char *d; size_t len; unsigned n, w, h; float fps; unsigned *off; int img, shown; } Movie;
static Movie *movies[MAX_MOV];

/* ------------------------------------------------------------------ JS helpers */
static double argd(JSContext *c, JSValueConst v, double def) { double d; if (JS_IsUndefined(v) || JS_ToFloat64(c, &d, v)) return def; return d; }
static int argi(JSContext *c, JSValueConst v, int def) { return (int)argd(c, v, def); }
static unsigned char col8(double v) { return (unsigned char)(v < 0 ? 0 : v > 255 ? 255 : v); }
static unsigned char alpha8(double a) { return (unsigned char)(a <= 0 ? 0 : a >= 1 ? 255 : a * 255 + 0.5); }
#define FN(name) static JSValue name(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv)
#define A(i) (i < argc ? argv[i] : JS_UNDEFINED)
#define UNUSED (void)this_val; (void)argc; (void)argv

FN(h_log) { UNUSED; const char *s = JS_ToCString(c, A(0)); if (s) { plat_log(s); JS_FreeCString(c, s); } return JS_UNDEFINED; }
FN(h_time) { UNUSED; return JS_NewFloat64(c, plat_time()); }
FN(h_now) { UNUSED; return JS_NewFloat64(c, (double)time(NULL) * 1000.0); }
FN(h_read) {
    UNUSED; const char *p = JS_ToCString(c, A(0)); if (!p) return JS_NULL;
    size_t len; char *d = read_file(p, &len); JS_FreeCString(c, p);
    if (!d) return JS_NULL;
    JSValue r = JS_NewStringLen(c, d, len); free(d); return r;
}
FN(h_write) {
    UNUSED; const char *p = JS_ToCString(c, A(0)); size_t len; const char *s = JS_ToCStringLen(c, &len, A(1));
    int ok = p && s && write_file(p, s, len);
    if (p) JS_FreeCString(c, p);
    if (s) JS_FreeCString(c, s);
    return JS_NewBool(c, ok);
}
FN(h_exists) { UNUSED; const char *p = JS_ToCString(c, A(0)); struct stat st; int ok = p && stat(p, &st) == 0; if (p) JS_FreeCString(c, p); return JS_NewBool(c, ok); }
FN(h_quit) { UNUSED; (void)c; core_running = 0; plat_quit(); return JS_UNDEFINED; }
FN(h_rotation) { UNUSED; rotation = argi(c, A(0), 90) == 270 ? 270 : 90; return JS_UNDEFINED; }
FN(h_target) { UNUSED; cur_scr = argi(c, A(0), 0) ? 1 : 0; gfx_target(cur_scr); return JS_UNDEFINED; }

/* loadImage(path, maxw, logicalW, logicalH): logical size = the picture's size before the PC
 * setup scaled it down; the game lays pages out with it. */
FN(h_loadImage) {
    UNUSED; const char *p = JS_ToCString(c, A(0)); if (!p) return JS_NewInt32(c, -1);
    int w, h, n;
    unsigned char *px = stbi_load(p, &w, &h, &n, 4); JS_FreeCString(c, p);
    if (!px) return JS_NewInt32(c, -1);
    return JS_NewInt32(c, make_image(px, w, h, (float)argd(c, A(2), 0), (float)argd(c, A(3), 0)));
}
FN(h_freeImage) { UNUSED; int i = argi(c, A(0), 0); if (i > 0 && i < MAX_IMG && imgs[i].t) { gfx_tex_free(imgs[i].t); imgs[i].t = NULL; } return JS_UNDEFINED; }
FN(h_imageSize) {
    UNUSED; int i = argi(c, A(0), 0); JSValue a = JS_NewArray(c);
    int ok = i > 0 && i < MAX_IMG && imgs[i].t;
    JS_SetPropertyUint32(c, a, 0, JS_NewFloat64(c, ok ? imgs[i].lw : 0)); JS_SetPropertyUint32(c, a, 1, JS_NewFloat64(c, ok ? imgs[i].lh : 0));
    return a;
}
/* drawImage(id, sx,sy,sw,sh, dx,dy,dw,dh, alpha, angle, cx, cy): angle in degrees around (cx,cy), relative to the destination */
FN(h_drawImage) {
    UNUSED; int i = argi(c, A(0), 0);
    if (i <= 0 || i >= MAX_IMG || !imgs[i].t) return JS_UNDEFINED;
    Img *im = &imgs[i];
    double sx = argd(c, A(1), 0), sy = argd(c, A(2), 0), sw = argd(c, A(3), im->lw), sh = argd(c, A(4), im->lh);
    double dx = argd(c, A(5), 0), dy = argd(c, A(6), 0), dw = argd(c, A(7), sw), dh = argd(c, A(8), sh);
    double al = argd(c, A(9), 1), ang = argd(c, A(10), 0);
    if (al <= 0 || dw == 0 || dh == 0) return JS_UNDEFINED;
    double cx = argd(c, A(11), dw / 2), cy = argd(c, A(12), dh / 2);
    float kx = im->w / im->lw, ky = im->h / im->lh;   /* game coordinates -> texture pixels */
    float px, py; v2p((float)(dx + cx), (float)(dy + cy), &px, &py);
    gfx_image(im->t, (float)sx * kx, (float)sy * ky, (float)sw * kx, (float)sh * ky, px, py, (float)cx * K, (float)cy * K,
              (float)dw * K, (float)dh * K, rot_angle() + (float)(ang * M_PI / 180), 255, 255, 255, alpha8(al), 0);
    return JS_UNDEFINED;
}
static void quad(float x, float y, float w, float h, unsigned char r, unsigned char g, unsigned char b, unsigned char a) {
    float p[8];
    v2p(x, y, &p[0], &p[1]); v2p(x + w, y, &p[2], &p[3]); v2p(x + w, y + h, &p[4], &p[5]); v2p(x, y + h, &p[6], &p[7]);
    float t1[6] = { p[0], p[1], p[2], p[3], p[4], p[5] }, t2[6] = { p[0], p[1], p[4], p[5], p[6], p[7] };
    gfx_tri(t1, r, g, b, a); gfx_tri(t2, r, g, b, a);
}
FN(h_fillRect) {
    UNUSED; double a = argd(c, A(7), 1); if (a <= 0) return JS_UNDEFINED;
    float w = (float)argd(c, A(2), 0), h = (float)argd(c, A(3), 0); if (w <= 0 || h <= 0) return JS_UNDEFINED;
    quad((float)argd(c, A(0), 0), (float)argd(c, A(1), 0), w, h, col8(argd(c, A(4), 0)), col8(argd(c, A(5), 0)), col8(argd(c, A(6), 0)), alpha8(a));
    return JS_UNDEFINED;
}
/* roundRect(x,y,w,h,radius, r,g,b,a) */
FN(h_roundRect) {
    UNUSED;
    float x = (float)argd(c, A(0), 0), y = (float)argd(c, A(1), 0), w = (float)argd(c, A(2), 0), h = (float)argd(c, A(3), 0), rad = (float)argd(c, A(4), 0);
    double a = argd(c, A(8), 1); if (a <= 0 || w <= 0 || h <= 0) return JS_UNDEFINED;
    if (rad > w / 2) rad = w / 2;
    if (rad > h / 2) rad = h / 2;
    unsigned char r = col8(argd(c, A(5), 0)), g = col8(argd(c, A(6), 0)), b = col8(argd(c, A(7), 0)), al = alpha8(a);
    if (rad * K < 1.0f) { quad(x, y, w, h, r, g, b, al); return JS_UNDEFINED; }
    enum { SEG = 5 };
    float pts[4 * (SEG + 1)][2];
    float cx[4] = { x + w - rad, x + rad, x + rad, x + w - rad }, cy[4] = { y + rad, y + rad, y + h - rad, y + h - rad };
    int n = 0;
    for (int q = 0; q < 4; q++) for (int k = 0; k <= SEG; k++) {
        double ang = (q * 90 + k * 90.0 / SEG) * M_PI / 180;
        v2p(cx[q] + (float)cos(ang) * rad, cy[q] - (float)sin(ang) * rad, &pts[n][0], &pts[n][1]); n++;
    }
    float ctr[2]; v2p(x + w / 2, y + h / 2, &ctr[0], &ctr[1]);
    for (int k = 0; k < n; k++) {
        float t[6] = { ctr[0], ctr[1], pts[k][0], pts[k][1], pts[(k + 1) % n][0], pts[(k + 1) % n][1] };
        gfx_tri(t, r, g, b, al);
    }
    return JS_UNDEFINED;
}
FN(h_clip) {
    UNUSED;
    if (argc < 4) { gfx_clip(0, 0, 0, 0, 0); return JS_UNDEFINED; }
    float x = (float)argd(c, A(0), 0), y = (float)argd(c, A(1), 0), w = (float)argd(c, A(2), 0), h = (float)argd(c, A(3), 0);
    if (w <= 0 || h <= 0) { gfx_clip(1, 0, 0, 0, 0); return JS_UNDEFINED; }
    float ax, ay, bx, by; v2p(x, y, &ax, &ay); v2p(x + w, y + h, &bx, &by);
    int x0 = (int)floorf(fminf(ax, bx) + 0.5f), y0 = (int)floorf(fminf(ay, by) + 0.5f), x1 = (int)floorf(fmaxf(ax, bx) + 0.5f), y1 = (int)floorf(fmaxf(ay, by) + 0.5f);
    gfx_clip(1, x0, y0, x1 - x0, y1 - y0);
    return JS_UNDEFINED;
}
/* loadFont(path, px): px is the em size in game units; glyphs are rendered at the real pixel size */
FN(h_loadFont) {
    UNUSED; const char *p = JS_ToCString(c, A(0)); double px = argd(c, A(1), 20);
    if (!p) return JS_NewInt32(c, -1);
    unsigned char *d = font_data(p); JS_FreeCString(c, p);
    if (!d) return JS_NewInt32(c, -1);
    for (int i = 1; i < MAX_FONT; i++) if (!fonts[i].used) {
        Font *f = &fonts[i];
        if (!stbtt_InitFont(&f->info, d, stbtt_GetFontOffsetForIndex(d, 0))) return JS_NewInt32(c, -1);
        f->scale = stbtt_ScaleForMappingEmToPixels(&f->info, (float)(px * K));
        int asc, desc, gap; stbtt_GetFontVMetrics(&f->info, &asc, &desc, &gap);
        f->asc = (int)ceilf(asc * f->scale); f->desc = (int)floorf(desc * f->scale);
        f->used = 1;
        return JS_NewInt32(c, i);
    }
    return JS_NewInt32(c, -1);
}
FN(h_freeFont) {
    UNUSED; int fi = argi(c, A(0), 0);
    if (fi > 0 && fi < MAX_FONT && fonts[fi].used) {
        for (int b = 0; b < TC_BUCKETS; b++) { TextEntry **pp = &tcache[b]; while (*pp) { TextEntry *e = *pp; if (e->font == fi) { *pp = e->next; if (e->t) gfx_tex_free(e->t); free(e->s); free(e); tc_count--; } else pp = &e->next; } }
        fonts[fi].used = 0;
    }
    return JS_UNDEFINED;
}
FN(h_textWidth) {
    UNUSED; int fi = argi(c, A(0), 0); const char *s = JS_ToCString(c, A(1)); double w = 0;
    if (s && fi > 0 && fi < MAX_FONT && fonts[fi].used && *s) w = text_px_width(&fonts[fi], s) / K;
    if (s) JS_FreeCString(c, s);
    return JS_NewFloat64(c, w);
}
FN(h_fontMetrics) {
    UNUSED; int fi = argi(c, A(0), 0); JSValue a = JS_NewArray(c);
    int ok = fi > 0 && fi < MAX_FONT && fonts[fi].used;
    JS_SetPropertyUint32(c, a, 0, JS_NewFloat64(c, ok ? (fonts[fi].asc - fonts[fi].desc) / K : 0));
    JS_SetPropertyUint32(c, a, 1, JS_NewFloat64(c, ok ? fonts[fi].asc / K : 0));
    return a;
}
/* drawText(font, str, x, y, r,g,b,a, shadow): y is the top of the line box */
FN(h_drawText) {
    UNUSED; int fi = argi(c, A(0), 0); const char *s = JS_ToCString(c, A(1));
    if (!s) return JS_UNDEFINED;
    double a = argd(c, A(7), 1);
    TextEntry *e = a > 0 ? text_get(fi, s) : NULL;
    JS_FreeCString(c, s);
    if (!e || !e->t) return JS_UNDEFINED;
    float px, py; v2p((float)argd(c, A(2), 0), (float)argd(c, A(3), 0), &px, &py);
    px = floorf(px + 0.5f); py = floorf(py + 0.5f);   /* whole pixels keep the glyphs sharp */
    float ang = rot_angle();
    double sh = argd(c, A(8), 0);
    if (sh > 0) {
        /* one pixel down and right of the text as the player sees it */
        float ox = rotation == 90 ? -1.0f : 1.0f, oy = rotation == 90 ? 1.0f : -1.0f;
        gfx_image(e->t, 0, 0, (float)e->w, (float)e->h, px + ox, py + oy, 1, 1, (float)e->w, (float)e->h, ang, 0, 0, 0, alpha8(a * sh), 1);
    }
    gfx_image(e->t, 0, 0, (float)e->w, (float)e->h, px, py, 1, 1, (float)e->w, (float)e->h, ang,
              col8(argd(c, A(4), 255)), col8(argd(c, A(5), 255)), col8(argd(c, A(6), 255)), alpha8(a), 1);
    return JS_UNDEFINED;
}
/* audio */
FN(h_sndLoad) {
    UNUSED; const char *p = JS_ToCString(c, A(0)); if (!p) return JS_NewInt32(c, -1);
    Sound *s = snd_load(p); JS_FreeCString(c, p);
    if (!s) return JS_NewInt32(c, -1);
    plat_audio_lock();
    int id = -1;
    for (int i = 1; i < MAX_SND; i++) if (!sounds[i]) { sounds[i] = s; id = i; break; }
    plat_audio_unlock();
    if (id < 0) snd_free(s);
    return JS_NewInt32(c, id);
}
FN(h_sndInfo) {
    UNUSED; int i = argi(c, A(0), 0); JSValue a = JS_NewArray(c);
    int ok = i > 0 && i < MAX_SND && sounds[i];
    JS_SetPropertyUint32(c, a, 0, JS_NewFloat64(c, ok ? sounds[i]->total : 0));
    return a;
}
FN(h_sndFree) {
    UNUSED; int i = argi(c, A(0), 0);
    if (i <= 0 || i >= MAX_SND || !sounds[i]) return JS_UNDEFINED;
    plat_audio_lock();
    for (int v = 0; v < MAX_VOICE; v++) if (voices[v].used && voices[v].snd == i) voices[v].ended = 1, voices[v].playing = 0;
    Sound *s = sounds[i]; sounds[i] = NULL;
    plat_audio_unlock();
    snd_free(s);
    return JS_UNDEFINED;
}
/* play(snd, vol, loopStart, loopEnd, rep) -> voice id */
FN(h_play) {
    UNUSED; int s = argi(c, A(0), 0);
    if (s <= 0 || s >= MAX_SND || !sounds[s]) return JS_NewInt32(c, -1);
    plat_audio_lock();
    int id = -1;
    for (int i = 0; i < MAX_VOICE; i++) if (!voices[i].used || voices[i].ended) { id = i; break; }
    if (id >= 0) {
        Voice *v = &voices[id];
        v->used = 1; v->snd = s; v->playing = 1; v->ended = 0;
        v->vol = (float)argd(c, A(1), 1); v->cur = v->vol;
        v->loop_s = (long long)argd(c, A(2), 0); v->loop_e = (long long)argd(c, A(3), 0); v->rep = argi(c, A(4), 0);
        voice_seek(v, 0);
    }
    plat_audio_unlock();
    return JS_NewInt32(c, id);
}
FN(h_voiceVol) { UNUSED; int i = argi(c, A(0), -1); if (i >= 0 && i < MAX_VOICE) voices[i].vol = (float)argd(c, A(1), 1); return JS_UNDEFINED; }
FN(h_voiceRep) { UNUSED; int i = argi(c, A(0), -1); if (i >= 0 && i < MAX_VOICE) voices[i].rep = argi(c, A(1), 0); return JS_UNDEFINED; }
FN(h_voiceStop) { UNUSED; int i = argi(c, A(0), -1); if (i >= 0 && i < MAX_VOICE) { plat_audio_lock(); voices[i].ended = 1; voices[i].playing = 0; plat_audio_unlock(); } return JS_UNDEFINED; }
FN(h_voiceEnded) { UNUSED; int i = argi(c, A(0), -1); return JS_NewBool(c, i < 0 || i >= MAX_VOICE || voices[i].ended || !voices[i].used); }
FN(h_voicePos) { UNUSED; int i = argi(c, A(0), -1); return JS_NewFloat64(c, i >= 0 && i < MAX_VOICE ? (double)voices[i].pos : 0); }
FN(h_audioPause) { UNUSED; audio_paused = JS_ToBool(c, A(0)); return JS_UNDEFINED; }
/* movies */
FN(h_movieOpen) {
    UNUSED; const char *p = JS_ToCString(c, A(0)); if (!p) return JS_NewInt32(c, -1);
    size_t len; unsigned char *d = (unsigned char *)read_file(p, &len); JS_FreeCString(c, p);
    if (!d || len < 20 || memcmp(d, "SLCM", 4)) { free(d); return JS_NewInt32(c, -1); }
    Movie *m = calloc(1, sizeof *m); m->d = d; m->len = len;
    unsigned fpsm = d[4] | d[5] << 8 | d[6] << 16 | (unsigned)d[7] << 24;
    m->fps = fpsm / 1000.0f; m->n = d[8] | d[9] << 8 | d[10] << 16 | (unsigned)d[11] << 24;
    m->w = d[12] | d[13] << 8; m->h = d[14] | d[15] << 8;
    if (16 + (size_t)(m->n + 1) * 4 > len) { free(d); free(m); return JS_NewInt32(c, -1); }
    m->off = malloc(sizeof(unsigned) * (m->n + 1));
    for (unsigned i = 0; i <= m->n; i++) { size_t q = 16 + i * 4; m->off[i] = d[q] | d[q + 1] << 8 | d[q + 2] << 16 | (unsigned)d[q + 3] << 24; }
    m->shown = -1;
    for (int i = 0; i < MAX_MOV; i++) if (!movies[i]) { movies[i] = m; return JS_NewInt32(c, i); }
    free(m->off); free(m->d); free(m); return JS_NewInt32(c, -1);
}
FN(h_movieInfo) {
    UNUSED; int i = argi(c, A(0), -1); JSValue a = JS_NewArray(c);
    Movie *m = i >= 0 && i < MAX_MOV ? movies[i] : NULL;
    JS_SetPropertyUint32(c, a, 0, JS_NewFloat64(c, m ? m->fps : 0)); JS_SetPropertyUint32(c, a, 1, JS_NewInt32(c, m ? (int)m->n : 0));
    JS_SetPropertyUint32(c, a, 2, JS_NewInt32(c, m ? (int)m->w : 0)); JS_SetPropertyUint32(c, a, 3, JS_NewInt32(c, m ? (int)m->h : 0));
    return a;
}
/* movieFrame(id, n) -> image id showing frame n */
FN(h_movieFrame) {
    UNUSED; int i = argi(c, A(0), -1), n = argi(c, A(1), 0);
    Movie *m = i >= 0 && i < MAX_MOV ? movies[i] : NULL;
    if (!m || !m->n) return JS_NewInt32(c, -1);
    if (n < 0) n = 0;
    if ((unsigned)n >= m->n) n = m->n - 1;
    if (n != m->shown) {
        size_t base = 16 + (size_t)(m->n + 1) * 4;
        if (base + m->off[n + 1] <= m->len && m->off[n + 1] > m->off[n]) {
            int w, h, ch;
            unsigned char *px = stbi_load_from_memory(m->d + base + m->off[n], (int)(m->off[n + 1] - m->off[n]), &w, &h, &ch, 4);
            if (px) {
                if (m->img <= 0) { GTex *t = gfx_tex_new(w, h, GT_OPAQUE); if (t) m->img = img_new(t, w, h, 0, 0); }
                if (m->img > 0 && imgs[m->img].w == w && imgs[m->img].h == h) gfx_tex_upload(imgs[m->img].t, px);
                stbi_image_free(px);
            }
        }
        m->shown = n;
    }
    return JS_NewInt32(c, m->img);
}
FN(h_movieClose) {
    UNUSED; int i = argi(c, A(0), -1);
    if (i >= 0 && i < MAX_MOV && movies[i]) { Movie *m = movies[i]; if (m->img > 0 && imgs[m->img].t) { gfx_tex_free(imgs[m->img].t); imgs[m->img].t = NULL; } free(m->off); free(m->d); free(m); movies[i] = NULL; }
    return JS_UNDEFINED;
}
/* input extras */
FN(h_accel) {
    UNUSED; JSValue a = JS_NewArray(c); float d[3] = { 0, 0, 0 };
    int ok = plat_accel(d);
    for (int k = 0; k < 3; k++) JS_SetPropertyUint32(c, a, k, JS_NewFloat64(c, d[k]));
    JS_SetPropertyUint32(c, a, 3, JS_NewBool(c, ok));
    return a;
}
FN(h_ime) {
    UNUSED; int on = argc > 0 && JS_ToBool(c, A(0));
    const char *init = on ? JS_ToCString(c, A(1)) : NULL;
    plat_ime(on, init ? init : "");
    if (init) JS_FreeCString(c, init);
    return JS_UNDEFINED;
}
FN(h_imeActive) { UNUSED; return JS_FALSE; }
FN(h_shot) { UNUSED; const char *p = JS_ToCString(c, A(0)); if (p) { plat_screenshot(p); JS_FreeCString(c, p); } return JS_UNDEFINED; }

static const JSCFunctionListEntry host_funcs[] = {
    JS_CFUNC_DEF("log", 1, h_log), JS_CFUNC_DEF("time", 0, h_time), JS_CFUNC_DEF("now", 0, h_now),
    JS_CFUNC_DEF("read", 1, h_read), JS_CFUNC_DEF("write", 2, h_write), JS_CFUNC_DEF("exists", 1, h_exists),
    JS_CFUNC_DEF("quit", 0, h_quit), JS_CFUNC_DEF("setRotation", 1, h_rotation), JS_CFUNC_DEF("target", 1, h_target),
    JS_CFUNC_DEF("loadImage", 4, h_loadImage), JS_CFUNC_DEF("freeImage", 1, h_freeImage), JS_CFUNC_DEF("imageSize", 1, h_imageSize),
    JS_CFUNC_DEF("drawImage", 13, h_drawImage), JS_CFUNC_DEF("fillRect", 8, h_fillRect), JS_CFUNC_DEF("roundRect", 9, h_roundRect),
    JS_CFUNC_DEF("clip", 4, h_clip), JS_CFUNC_DEF("loadFont", 2, h_loadFont), JS_CFUNC_DEF("freeFont", 1, h_freeFont),
    JS_CFUNC_DEF("textWidth", 2, h_textWidth), JS_CFUNC_DEF("fontMetrics", 1, h_fontMetrics), JS_CFUNC_DEF("drawText", 9, h_drawText),
    JS_CFUNC_DEF("sndLoad", 1, h_sndLoad), JS_CFUNC_DEF("sndInfo", 1, h_sndInfo), JS_CFUNC_DEF("sndFree", 1, h_sndFree),
    JS_CFUNC_DEF("play", 5, h_play), JS_CFUNC_DEF("voiceVol", 2, h_voiceVol), JS_CFUNC_DEF("voiceRep", 2, h_voiceRep),
    JS_CFUNC_DEF("voiceStop", 1, h_voiceStop), JS_CFUNC_DEF("voiceEnded", 1, h_voiceEnded), JS_CFUNC_DEF("voicePos", 1, h_voicePos),
    JS_CFUNC_DEF("audioPause", 1, h_audioPause),
    JS_CFUNC_DEF("movieOpen", 1, h_movieOpen), JS_CFUNC_DEF("movieInfo", 1, h_movieInfo), JS_CFUNC_DEF("movieFrame", 2, h_movieFrame), JS_CFUNC_DEF("movieClose", 1, h_movieClose),
    JS_CFUNC_DEF("accel", 0, h_accel), JS_CFUNC_DEF("ime", 2, h_ime), JS_CFUNC_DEF("imeActive", 0, h_imeActive), JS_CFUNC_DEF("screenshot", 1, h_shot),
};

/* ------------------------------------------------------------------ calling into JS */
static void dump_error(void) {
    JSValue e = JS_GetException(ctx);
    const char *s = JS_ToCString(ctx, e);
    JSValue st = JS_GetPropertyStr(ctx, e, "stack");
    const char *ss = JS_ToCString(ctx, st);
    char buf[1024]; snprintf(buf, sizeof buf, "JS error: %s\n%s", s ? s : "?", ss ? ss : "");
    plat_log(buf);
    if (s) JS_FreeCString(ctx, s);
    if (ss) JS_FreeCString(ctx, ss);
    JS_FreeValue(ctx, st); JS_FreeValue(ctx, e);
}
static void call_js(const char *fn, int argc, JSValue *argv) {
    JSValue g = JS_GetGlobalObject(ctx), f = JS_GetPropertyStr(ctx, g, fn);
    if (JS_IsFunction(ctx, f)) {
        JSValue r = JS_Call(ctx, f, g, argc, argv);
        if (JS_IsException(r)) dump_error();
        JS_FreeValue(ctx, r);
    }
    for (int i = 0; i < argc; i++) JS_FreeValue(ctx, argv[i]);
    JS_FreeValue(ctx, f); JS_FreeValue(ctx, g);
    JSContext *c2; while (JS_ExecutePendingJob(rt, &c2) > 0) { }
}
void core_ime_text(const char *s) { JSValue v[1] = { JS_NewString(ctx, s) }; call_js("onIME", 1, v); }
void core_button(const char *name, int down) { JSValue v[2] = { JS_NewString(ctx, name), JS_NewBool(ctx, down) }; call_js("onButton", 2, v); }
/* bottom screen pixel -> touch screen canvas point */
void core_touch(int kind, int id, float x, float y) {
    float cx, cy;
    if (rotation == 90) { cx = y / K; cy = (PW[1] - x) / K; }
    else { cx = (SCR_H - y) / K; cy = x / K; }
    JSValue v[5] = { JS_NewInt32(ctx, kind), JS_NewInt32(ctx, id), JS_NewFloat64(ctx, cx), JS_NewFloat64(ctx, cy), JS_FALSE };
    call_js("onTouch", 5, v);
}
void core_frame(double dt, float lx, float ly, float rx, float ry) {
    JSValue v[5] = { JS_NewFloat64(ctx, dt), JS_NewFloat64(ctx, lx), JS_NewFloat64(ctx, ly), JS_NewFloat64(ctx, rx), JS_NewFloat64(ctx, ry) };
    call_js("frame", 5, v);
    frame_no++;
    if (frame_no % 30 == 0 && tc_count > 300) tc_evict(240);
}

int core_init(const char **scripts, int n, int is_console) {
    rt = JS_NewRuntime();
    JS_SetMemoryLimit(rt, 80 * 1024 * 1024);
    JS_SetMaxStackSize(rt, 512 * 1024);
    ctx = JS_NewContext(rt);
    JSValue g = JS_GetGlobalObject(ctx), h = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, h, host_funcs, sizeof host_funcs / sizeof host_funcs[0]);
    JS_SetPropertyStr(ctx, h, "appDir", JS_NewString(ctx, APP_DIR));
    JS_SetPropertyStr(ctx, h, "dataDir", JS_NewString(ctx, DATA_DIR));
    JS_SetPropertyStr(ctx, h, "dual", JS_TRUE);
    JS_SetPropertyStr(ctx, h, "n3ds", JS_NewBool(ctx, is_console));
    JS_SetPropertyStr(ctx, h, "vita", JS_FALSE);
    JS_SetPropertyStr(ctx, h, "enterCircle", JS_FALSE);
    JS_SetPropertyStr(ctx, h, "sndExt", JS_NewString(ctx, ".slca"));
    JS_SetPropertyStr(ctx, h, "audioRate", JS_NewInt32(ctx, AUDIO_RATE));
    JS_SetPropertyStr(ctx, h, "imgCache", JS_NewInt32(ctx, 16));
    JS_SetPropertyStr(ctx, g, "host", h);
    JS_FreeValue(ctx, g);
    for (int k = 0; k < n; k++) {
        char path[512]; snprintf(path, sizeof path, "%s%s", APP_DIR, scripts[k]);
        size_t len; char *src = read_file(path, &len);
        if (!src) { char b[600]; snprintf(b, sizeof b, "cannot read %s", path); plat_log(b); return 0; }
        JSValue r = JS_Eval(ctx, src, len, scripts[k], JS_EVAL_TYPE_GLOBAL);
        free(src);
        if (JS_IsException(r)) dump_error();
        JS_FreeValue(ctx, r);
    }
    call_js("main", 0, NULL);
    return 1;
}
void core_shutdown(void) {
    plat_audio_lock();
    for (int i = 0; i < MAX_VOICE; i++) voices[i].ended = 1;
    plat_audio_unlock();
    JS_FreeContext(ctx); JS_FreeRuntime(rt);
}
