/*
 * Slop's Last Cry for PS Vita: the native host.
 *
 * The game logic lives in game.js (run by QuickJS). This file gives it what a browser would:
 * a portrait 544x960 canvas drawn rotated onto the Vita's 960x544 screen, images and text,
 * an audio mixer for the converted Opus tracks (with sample-exact loop points), movies stored
 * as JPEG frames, touch, buttons, the accelerometer, the system keyboard and file access.
 * The same code builds on a desktop (SDL2) for testing.
 */
#include <SDL.h>
#include <SDL_ttf.h>
#include <SDL_image.h>
#include <opus.h>
#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <sys/stat.h>
#include <time.h>

#ifdef __vita__
#include <psp2/kernel/processmgr.h>
#include <psp2/power.h>
#include <psp2/apputil.h>
#include <psp2/system_param.h>
#define APP_DIR "app0:/"
#define DATA_DIR "ux0:data/slc/"
int _newlib_heap_size_user = 192 * 1024 * 1024;
#else
#define APP_DIR "vita/"
#define DATA_DIR "slc-vita/"
#endif

#define CW 544
#define CH 960
#define SW 960
#define SH 544

static SDL_Window *win;
static SDL_Renderer *ren;
static SDL_Texture *canvas;
static JSContext *ctx;
static JSRuntime *rt;
static int rotation = 90;
static int running = 1;
static const char *shot_path = NULL;   /* desktop testing: write a screenshot and quit */
static int shot_frames = 0;

/* ------------------------------------------------------------------ files */
static char *read_file(const char *path, size_t *len) {
    SDL_RWops *f = SDL_RWFromFile(path, "rb");
    if (!f) return NULL;
    Sint64 n = SDL_RWsize(f);
    if (n < 0) { SDL_RWclose(f); return NULL; }
    char *b = malloc((size_t)n + 1);
    if (!b) { SDL_RWclose(f); return NULL; }
    size_t got = SDL_RWread(f, b, 1, (size_t)n);
    SDL_RWclose(f);
    b[got] = 0;
    if (len) *len = got;
    return b;
}
static void mkdirs(const char *path) {
    char tmp[512]; snprintf(tmp, sizeof tmp, "%s", path);
    for (char *p = tmp + 1; *p; p++) if (*p == '/') { *p = 0; mkdir(tmp, 0777); *p = '/'; }
}
static int write_file(const char *path, const char *data, size_t len) {
    mkdirs(path);
    SDL_RWops *f = SDL_RWFromFile(path, "wb");
    if (!f) return 0;
    size_t w = SDL_RWwrite(f, data, 1, len);
    SDL_RWclose(f);
    return w == len;
}

/* ------------------------------------------------------------------ images */
#define MAX_IMG 1024
typedef struct { SDL_Texture *t; int w, h; } Img;
static Img imgs[MAX_IMG];
static int img_new(SDL_Texture *t, int w, int h) {
    for (int i = 1; i < MAX_IMG; i++) if (!imgs[i].t) { imgs[i].t = t; imgs[i].w = w; imgs[i].h = h; return i; }
    SDL_DestroyTexture(t);
    return -1;
}

/* ------------------------------------------------------------------ fonts and text cache */
#define MAX_FONT 64
static TTF_Font *fonts[MAX_FONT];
typedef struct TextEntry { int font; char *s; SDL_Texture *t; int w, h; unsigned stamp; struct TextEntry *next; } TextEntry;
#define TC_BUCKETS 1024
static TextEntry *tcache[TC_BUCKETS];
static int tc_count = 0;
static unsigned frame_no = 0;
static unsigned hash_str(int f, const char *s) { unsigned h = 2166136261u ^ (unsigned)f; while (*s) { h ^= (unsigned char)*s++; h *= 16777619u; } return h; }
static void tc_evict(void) {
    /* drop entries unused for a while once the cache grows large */
    for (int b = 0; b < TC_BUCKETS; b++) {
        TextEntry **pp = &tcache[b];
        while (*pp) {
            TextEntry *e = *pp;
            if (frame_no - e->stamp > 120) { *pp = e->next; SDL_DestroyTexture(e->t); free(e->s); free(e); tc_count--; }
            else pp = &e->next;
        }
    }
}
static TextEntry *text_get(int f, const char *s) {
    if (f <= 0 || f >= MAX_FONT || !fonts[f] || !*s) return NULL;
    unsigned h = hash_str(f, s) % TC_BUCKETS;
    for (TextEntry *e = tcache[h]; e; e = e->next) if (e->font == f && !strcmp(e->s, s)) { e->stamp = frame_no; return e; }
    SDL_Color white = { 255, 255, 255, 255 };
    SDL_Surface *sf = TTF_RenderUTF8_Blended(fonts[f], s, white);
    if (!sf) return NULL;
    SDL_Texture *t = SDL_CreateTextureFromSurface(ren, sf);
    TextEntry *e = calloc(1, sizeof *e);
    e->font = f; e->s = strdup(s); e->t = t; e->w = sf->w; e->h = sf->h; e->stamp = frame_no;
    SDL_FreeSurface(sf);
    e->next = tcache[h]; tcache[h] = e;
    if (++tc_count > 1500) tc_evict();
    return e;
}

/* ------------------------------------------------------------------ audio */
typedef struct {
    unsigned char *data; size_t len;
    int channels, preskip; unsigned total, npk;
    unsigned *off; unsigned short *plen;
    int refs;
} Sound;
#define MAX_SND 512
#define MAX_VOICE 32
static Sound *sounds[MAX_SND];
typedef struct {
    int used, snd, playing, ended;
    OpusDecoder *dec;
    float buf[960 * 2 * 3]; int bufn, bufpos;   /* decoded, not yet mixed */
    unsigned pk;                                  /* next packet */
    long long pos;                                /* output sample index (after preskip) */
    long long loop_s, loop_e; int rep;
    float vol, cur;                               /* target and ramped volume */
} Voice;
static Voice voices[MAX_VOICE];
static SDL_AudioDeviceID adev;
static int audio_paused = 0;

static Sound *snd_load(const char *path) {
    size_t len; unsigned char *d = (unsigned char *)read_file(path, &len);
    if (!d || len < 20 || memcmp(d, "SLCO", 4)) { free(d); return NULL; }
    Sound *s = calloc(1, sizeof *s);
    s->data = d; s->len = len;
    s->channels = d[5]; s->preskip = d[6] | d[7] << 8;
    s->total = d[12] | d[13] << 8 | d[14] << 16 | (unsigned)d[15] << 24;
    s->npk = d[16] | d[17] << 8 | d[18] << 16 | (unsigned)d[19] << 24;
    s->off = malloc(sizeof(unsigned) * (s->npk + 1)); s->plen = malloc(sizeof(unsigned short) * (s->npk + 1));
    size_t p = 20;
    for (unsigned i = 0; i < s->npk && p + 2 <= len; i++) { unsigned l = d[p] | d[p + 1] << 8; s->plen[i] = (unsigned short)l; s->off[i] = (unsigned)(p + 2); p += 2 + l; }
    return s;
}
/* Decodes packets until the voice's decode buffer holds data (or the sound ends). */
static int voice_decode(Voice *v) {
    Sound *s = sounds[v->snd];
    if (!s || v->pk >= s->npk) return 0;
    float tmp[960 * 2 * 3];
    int n = opus_decode_float(v->dec, s->data + s->off[v->pk], s->plen[v->pk], tmp, 960 * 3, 0);
    v->pk++;
    if (n <= 0) return 1;
    if (s->channels == 1) { for (int i = n - 1; i >= 0; i--) { tmp[i * 2] = tmp[i]; tmp[i * 2 + 1] = tmp[i]; } }
    memcpy(v->buf, tmp, sizeof(float) * n * 2);
    v->bufn = n; v->bufpos = 0;
    return 1;
}
/* Jumps to output sample `to` (sample-exact): reset, pre-roll 4 packets, skip. */
static void voice_seek(Voice *v, long long to) {
    Sound *s = sounds[v->snd];
    opus_decoder_ctl(v->dec, OPUS_RESET_STATE);
    long long abs = to + s->preskip;
    long long first = abs / 960 - 4; if (first < 0) first = 0;
    v->pk = (unsigned)first; v->bufn = v->bufpos = 0;
    long long at = first * 960;               /* absolute sample at start of packet `first` */
    while (at < abs && voice_decode(v)) {
        long long skip = abs - at;
        if (skip < v->bufn) { v->bufpos = (int)skip; at = abs; break; }
        at += v->bufn; v->bufn = 0;
    }
    v->pos = to;
}
static void audio_cb(void *ud, Uint8 *stream, int bytes) {
    (void)ud;
    short *out = (short *)stream; int frames = bytes / 4;
    static float mix[4096 * 2];
    if (frames > 4096) frames = 4096;
    memset(mix, 0, sizeof(float) * frames * 2);
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
            if (v->bufpos >= v->bufn) {
                if (v->pos == 0 && v->pk == 0) { voice_seek(v, 0); }
                if (v->bufpos >= v->bufn && !voice_decode(v)) { v->pos = s->total; continue; }
            }
            v->cur += step;
            mix[i * 2] += v->buf[v->bufpos * 2] * v->cur;
            mix[i * 2 + 1] += v->buf[v->bufpos * 2 + 1] * v->cur;
            v->bufpos++; v->pos++;
        }
        v->cur = v->vol;
    }
    for (int i = 0; i < frames * 2; i++) { float x = mix[i]; if (x > 1) x = 1; else if (x < -1) x = -1; out[i] = (short)(x * 32767); }
}

/* ------------------------------------------------------------------ movies (JPEG frames) */
#define MAX_MOV 8
typedef struct { unsigned char *d; size_t len; unsigned n, w, h; float fps; unsigned *off; int img, shown; } Movie;
static Movie *movies[MAX_MOV];

/* ------------------------------------------------------------------ JS helpers */
static double argd(JSContext *c, JSValueConst v, double def) { double d; if (JS_IsUndefined(v) || JS_ToFloat64(c, &d, v)) return def; return d; }
static int argi(JSContext *c, JSValueConst v, int def) { return (int)argd(c, v, def); }
#define FN(name) static JSValue name(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv)
#define A(i) (i < argc ? argv[i] : JS_UNDEFINED)

FN(h_log) { (void)this_val; const char *s = JS_ToCString(c, A(0)); if (s) { SDL_Log("%s", s); JS_FreeCString(c, s); } return JS_UNDEFINED; }
FN(h_time) { (void)this_val; (void)argc; (void)argv; return JS_NewFloat64(c, SDL_GetPerformanceCounter() / (double)SDL_GetPerformanceFrequency()); }
FN(h_now) { (void)this_val; (void)argc; (void)argv; return JS_NewFloat64(c, (double)time(NULL) * 1000.0); }
FN(h_read) {
    (void)this_val; const char *p = JS_ToCString(c, A(0)); if (!p) return JS_NULL;
    size_t len; char *d = read_file(p, &len); JS_FreeCString(c, p);
    if (!d) return JS_NULL;
    JSValue r = JS_NewStringLen(c, d, len); free(d); return r;
}
FN(h_write) {
    (void)this_val; const char *p = JS_ToCString(c, A(0)); size_t len; const char *s = JS_ToCStringLen(c, &len, A(1));
    int ok = p && s && write_file(p, s, len);
    if (p) JS_FreeCString(c, p); if (s) JS_FreeCString(c, s);
    return JS_NewBool(c, ok);
}
FN(h_exists) { (void)this_val; const char *p = JS_ToCString(c, A(0)); struct stat st; int ok = p && stat(p, &st) == 0; if (p) JS_FreeCString(c, p); return JS_NewBool(c, ok); }
FN(h_quit) { (void)this_val; (void)argc; (void)argv; (void)c; running = 0; return JS_UNDEFINED; }
FN(h_rotation) { (void)this_val; rotation = argi(c, A(0), 90) == 270 ? 270 : 90; return JS_UNDEFINED; }

FN(h_loadImage) {
    (void)this_val; const char *p = JS_ToCString(c, A(0)); if (!p) return JS_NewInt32(c, -1);
    int maxw = argi(c, A(1), 0);
    SDL_Surface *s = IMG_Load(p); JS_FreeCString(c, p);
    if (!s) return JS_NewInt32(c, -1);
    if (maxw > 0 && s->w > maxw) {   /* keep big pictures small on the Vita */
        int nw = maxw, nh = (int)((double)s->h * maxw / s->w);
        SDL_Surface *d = SDL_CreateRGBSurfaceWithFormat(0, nw, nh, 32, SDL_PIXELFORMAT_RGBA32);
        SDL_Surface *cs = SDL_ConvertSurfaceFormat(s, SDL_PIXELFORMAT_RGBA32, 0);
        SDL_SetSurfaceBlendMode(cs, SDL_BLENDMODE_NONE);
        SDL_BlitScaled(cs, NULL, d, NULL);
        SDL_FreeSurface(cs); SDL_FreeSurface(s); s = d;
    }
    SDL_Texture *t = SDL_CreateTextureFromSurface(ren, s);
    int w = s->w, h = s->h; SDL_FreeSurface(s);
    if (!t) return JS_NewInt32(c, -1);
    SDL_SetTextureBlendMode(t, SDL_BLENDMODE_BLEND);
    return JS_NewInt32(c, img_new(t, w, h));
}
FN(h_freeImage) { (void)this_val; int i = argi(c, A(0), 0); if (i > 0 && i < MAX_IMG && imgs[i].t) { SDL_DestroyTexture(imgs[i].t); imgs[i].t = NULL; } return JS_UNDEFINED; }
FN(h_imageSize) {
    (void)this_val; int i = argi(c, A(0), 0); JSValue a = JS_NewArray(c);
    int ok = i > 0 && i < MAX_IMG && imgs[i].t;
    JS_SetPropertyUint32(c, a, 0, JS_NewInt32(c, ok ? imgs[i].w : 0)); JS_SetPropertyUint32(c, a, 1, JS_NewInt32(c, ok ? imgs[i].h : 0));
    return a;
}
/* drawImage(id, sx,sy,sw,sh, dx,dy,dw,dh, alpha, angle, cx, cy) — angle in degrees around (cx,cy) in dest space */
FN(h_drawImage) {
    (void)this_val; int i = argi(c, A(0), 0);
    if (i <= 0 || i >= MAX_IMG || !imgs[i].t) return JS_UNDEFINED;
    double sx = argd(c, A(1), 0), sy = argd(c, A(2), 0), sw = argd(c, A(3), imgs[i].w), sh = argd(c, A(4), imgs[i].h);
    double dx = argd(c, A(5), 0), dy = argd(c, A(6), 0), dw = argd(c, A(7), sw), dh = argd(c, A(8), sh);
    double al = argd(c, A(9), 1), ang = argd(c, A(10), 0);
    if (al <= 0) return JS_UNDEFINED;
    SDL_Rect sr = { (int)sx, (int)sy, (int)(sw + .5), (int)(sh + .5) };
    SDL_FRect dr = { (float)dx, (float)dy, (float)dw, (float)dh };
    SDL_SetTextureAlphaMod(imgs[i].t, (Uint8)(al > 1 ? 255 : al * 255));
    SDL_SetTextureColorMod(imgs[i].t, 255, 255, 255);
    if (ang != 0) {
        SDL_FPoint ctr = { (float)argd(c, A(11), dw / 2), (float)argd(c, A(12), dh / 2) };
        SDL_RenderCopyExF(ren, imgs[i].t, &sr, &dr, ang, &ctr, SDL_FLIP_NONE);
    } else SDL_RenderCopyF(ren, imgs[i].t, &sr, &dr);
    return JS_UNDEFINED;
}
FN(h_fillRect) {
    (void)this_val;
    double a = argd(c, A(7), 1); if (a <= 0) return JS_UNDEFINED;
    SDL_SetRenderDrawBlendMode(ren, SDL_BLENDMODE_BLEND);
    SDL_SetRenderDrawColor(ren, (Uint8)argi(c, A(4), 0), (Uint8)argi(c, A(5), 0), (Uint8)argi(c, A(6), 0), (Uint8)(a > 1 ? 255 : a * 255));
    SDL_FRect r = { (float)argd(c, A(0), 0), (float)argd(c, A(1), 0), (float)argd(c, A(2), 0), (float)argd(c, A(3), 0) };
    SDL_RenderFillRectF(ren, &r);
    return JS_UNDEFINED;
}
/* roundRect(x,y,w,h,radius, r,g,b,a) */
FN(h_roundRect) {
    (void)this_val;
    float x = (float)argd(c, A(0), 0), y = (float)argd(c, A(1), 0), w = (float)argd(c, A(2), 0), h = (float)argd(c, A(3), 0), rad = (float)argd(c, A(4), 0);
    double a = argd(c, A(8), 1); if (a <= 0 || w <= 0 || h <= 0) return JS_UNDEFINED;
    if (rad > w / 2) rad = w / 2; if (rad > h / 2) rad = h / 2;
    SDL_Color col = { (Uint8)argi(c, A(5), 0), (Uint8)argi(c, A(6), 0), (Uint8)argi(c, A(7), 0), (Uint8)(a > 1 ? 255 : a * 255) };
    enum { SEG = 6 };
    SDL_Vertex vtx[4 * (SEG + 1) + 1]; int idx[3 * 4 * (SEG + 1)];
    float cx[4] = { x + w - rad, x + rad, x + rad, x + w - rad }, cy[4] = { y + rad, y + rad, y + h - rad, y + h - rad };
    int n = 0;
    vtx[n].position.x = x + w / 2; vtx[n].position.y = y + h / 2; vtx[n].color = col; n++;
    for (int q = 0; q < 4; q++) for (int k = 0; k <= SEG; k++) {
        double ang = (q * 90 + k * 90.0 / SEG) * M_PI / 180;
        vtx[n].position.x = cx[q] + (float)cos(ang) * rad; vtx[n].position.y = cy[q] - (float)sin(ang) * rad; vtx[n].color = col; n++;
    }
    int ni = 0, perim = n - 1;
    for (int k = 0; k < perim; k++) { idx[ni++] = 0; idx[ni++] = 1 + k; idx[ni++] = 1 + (k + 1) % perim; }
    SDL_RenderGeometry(ren, NULL, vtx, n, idx, ni);
    return JS_UNDEFINED;
}
FN(h_clip) {
    (void)this_val;
    if (argc < 4) { SDL_RenderSetClipRect(ren, NULL); return JS_UNDEFINED; }
    SDL_Rect r = { argi(c, A(0), 0), argi(c, A(1), 0), argi(c, A(2), 0), argi(c, A(3), 0) };
    if (r.w <= 0 || r.h <= 0) { r.w = 1; r.h = 1; r.x = -10; r.y = -10; }
    SDL_RenderSetClipRect(ren, &r);
    return JS_UNDEFINED;
}
FN(h_loadFont) {
    (void)this_val; const char *p = JS_ToCString(c, A(0)); int px = argi(c, A(1), 20);
    if (!p) return JS_NewInt32(c, -1);
    TTF_Font *f = TTF_OpenFont(p, px); JS_FreeCString(c, p);
    if (!f) return JS_NewInt32(c, -1);
    for (int i = 1; i < MAX_FONT; i++) if (!fonts[i]) { fonts[i] = f; return JS_NewInt32(c, i); }
    TTF_CloseFont(f); return JS_NewInt32(c, -1);
}
FN(h_freeFont) {
    (void)this_val; int f = argi(c, A(0), 0);
    if (f > 0 && f < MAX_FONT && fonts[f]) {
        for (int b = 0; b < TC_BUCKETS; b++) { TextEntry **pp = &tcache[b]; while (*pp) { TextEntry *e = *pp; if (e->font == f) { *pp = e->next; SDL_DestroyTexture(e->t); free(e->s); free(e); tc_count--; } else pp = &e->next; } }
        TTF_CloseFont(fonts[f]); fonts[f] = NULL;
    }
    return JS_UNDEFINED;
}
FN(h_textWidth) {
    (void)this_val; int f = argi(c, A(0), 0); const char *s = JS_ToCString(c, A(1)); int w = 0, h = 0;
    if (s && f > 0 && f < MAX_FONT && fonts[f] && *s) TTF_SizeUTF8(fonts[f], s, &w, &h);
    if (s) JS_FreeCString(c, s);
    return JS_NewInt32(c, w);
}
FN(h_fontMetrics) {
    (void)this_val; int f = argi(c, A(0), 0); JSValue a = JS_NewArray(c);
    int ok = f > 0 && f < MAX_FONT && fonts[f];
    JS_SetPropertyUint32(c, a, 0, JS_NewInt32(c, ok ? TTF_FontHeight(fonts[f]) : 0));
    JS_SetPropertyUint32(c, a, 1, JS_NewInt32(c, ok ? TTF_FontAscent(fonts[f]) : 0));
    return a;
}
/* drawText(font, str, x, y, r,g,b,a, shadow) — y is the top of the line box */
FN(h_drawText) {
    (void)this_val; int f = argi(c, A(0), 0); const char *s = JS_ToCString(c, A(1));
    if (!s) return JS_UNDEFINED;
    double a = argd(c, A(7), 1);
    TextEntry *e = a > 0 ? text_get(f, s) : NULL;
    JS_FreeCString(c, s);
    if (!e) return JS_UNDEFINED;
    float x = (float)argd(c, A(2), 0), y = (float)argd(c, A(3), 0);
    double sh = argd(c, A(8), 0);
    if (sh > 0) {
        SDL_SetTextureColorMod(e->t, 0, 0, 0);
        SDL_SetTextureAlphaMod(e->t, (Uint8)(a * sh * 255 > 255 ? 255 : a * sh * 255));
        SDL_FRect d2 = { x + 1.5f, y + 1.5f, (float)e->w, (float)e->h }; SDL_RenderCopyF(ren, e->t, NULL, &d2);
    }
    SDL_SetTextureColorMod(e->t, (Uint8)argi(c, A(4), 255), (Uint8)argi(c, A(5), 255), (Uint8)argi(c, A(6), 255));
    SDL_SetTextureAlphaMod(e->t, (Uint8)(a > 1 ? 255 : a * 255));
    SDL_FRect d = { x, y, (float)e->w, (float)e->h };
    SDL_RenderCopyF(ren, e->t, NULL, &d);
    return JS_UNDEFINED;
}
/* audio */
FN(h_sndLoad) {
    (void)this_val; const char *p = JS_ToCString(c, A(0)); if (!p) return JS_NewInt32(c, -1);
    Sound *s = snd_load(p); JS_FreeCString(c, p);
    if (!s) return JS_NewInt32(c, -1);
    SDL_LockAudioDevice(adev);
    int id = -1;
    for (int i = 1; i < MAX_SND; i++) if (!sounds[i]) { sounds[i] = s; id = i; break; }
    SDL_UnlockAudioDevice(adev);
    if (id < 0) { free(s->data); free(s->off); free(s->plen); free(s); }
    return JS_NewInt32(c, id);
}
FN(h_sndInfo) {
    (void)this_val; int i = argi(c, A(0), 0); JSValue a = JS_NewArray(c);
    int ok = i > 0 && i < MAX_SND && sounds[i];
    JS_SetPropertyUint32(c, a, 0, JS_NewFloat64(c, ok ? sounds[i]->total : 0));
    return a;
}
FN(h_sndFree) {
    (void)this_val; int i = argi(c, A(0), 0);
    if (i <= 0 || i >= MAX_SND || !sounds[i]) return JS_UNDEFINED;
    SDL_LockAudioDevice(adev);
    for (int v = 0; v < MAX_VOICE; v++) if (voices[v].used && voices[v].snd == i) voices[v].ended = 1, voices[v].playing = 0;
    Sound *s = sounds[i]; sounds[i] = NULL;
    SDL_UnlockAudioDevice(adev);
    free(s->data); free(s->off); free(s->plen); free(s);
    return JS_UNDEFINED;
}
/* play(snd, vol, loopStart, loopEnd, rep) -> voice id */
FN(h_play) {
    (void)this_val; int s = argi(c, A(0), 0);
    if (s <= 0 || s >= MAX_SND || !sounds[s]) return JS_NewInt32(c, -1);
    SDL_LockAudioDevice(adev);
    int id = -1;
    for (int i = 0; i < MAX_VOICE; i++) if (!voices[i].used || voices[i].ended) { id = i; break; }
    if (id >= 0) {
        Voice *v = &voices[id];
        int err; if (!v->dec) v->dec = opus_decoder_create(48000, 2, &err);
        v->used = 1; v->snd = s; v->playing = 1; v->ended = 0;
        v->vol = (float)argd(c, A(1), 1); v->cur = v->vol;
        v->loop_s = (long long)argd(c, A(2), 0); v->loop_e = (long long)argd(c, A(3), 0); v->rep = argi(c, A(4), 0);
        voice_seek(v, 0);
    }
    SDL_UnlockAudioDevice(adev);
    return JS_NewInt32(c, id);
}
FN(h_voiceVol) { (void)this_val; int i = argi(c, A(0), -1); if (i >= 0 && i < MAX_VOICE) voices[i].vol = (float)argd(c, A(1), 1); return JS_UNDEFINED; }
FN(h_voiceRep) { (void)this_val; int i = argi(c, A(0), -1); if (i >= 0 && i < MAX_VOICE) voices[i].rep = argi(c, A(1), 0); return JS_UNDEFINED; }
FN(h_voiceStop) { (void)this_val; int i = argi(c, A(0), -1); if (i >= 0 && i < MAX_VOICE) { SDL_LockAudioDevice(adev); voices[i].ended = 1; voices[i].playing = 0; SDL_UnlockAudioDevice(adev); } return JS_UNDEFINED; }
FN(h_voiceEnded) { (void)this_val; int i = argi(c, A(0), -1); return JS_NewBool(c, i < 0 || i >= MAX_VOICE || voices[i].ended || !voices[i].used); }
FN(h_voicePos) { (void)this_val; int i = argi(c, A(0), -1); return JS_NewFloat64(c, i >= 0 && i < MAX_VOICE ? (double)voices[i].pos : 0); }
FN(h_audioPause) { (void)this_val; audio_paused = JS_ToBool(c, A(0)); return JS_UNDEFINED; }
/* movies */
FN(h_movieOpen) {
    (void)this_val; const char *p = JS_ToCString(c, A(0)); if (!p) return JS_NewInt32(c, -1);
    size_t len; unsigned char *d = (unsigned char *)read_file(p, &len); JS_FreeCString(c, p);
    if (!d || len < 20 || memcmp(d, "SLCM", 4)) { free(d); return JS_NewInt32(c, -1); }
    Movie *m = calloc(1, sizeof *m); m->d = d; m->len = len;
    unsigned fpsm = d[4] | d[5] << 8 | d[6] << 16 | (unsigned)d[7] << 24;
    m->fps = fpsm / 1000.0f; m->n = d[8] | d[9] << 8 | d[10] << 16 | (unsigned)d[11] << 24;
    m->w = d[12] | d[13] << 8; m->h = d[14] | d[15] << 8;
    m->off = malloc(sizeof(unsigned) * (m->n + 1));
    for (unsigned i = 0; i <= m->n; i++) { size_t q = 16 + i * 4; m->off[i] = d[q] | d[q + 1] << 8 | d[q + 2] << 16 | (unsigned)d[q + 3] << 24; }
    m->shown = -1;
    for (int i = 0; i < MAX_MOV; i++) if (!movies[i]) { movies[i] = m; return JS_NewInt32(c, i); }
    free(m->off); free(m->d); free(m); return JS_NewInt32(c, -1);
}
FN(h_movieInfo) {
    (void)this_val; int i = argi(c, A(0), -1); JSValue a = JS_NewArray(c);
    Movie *m = i >= 0 && i < MAX_MOV ? movies[i] : NULL;
    JS_SetPropertyUint32(c, a, 0, JS_NewFloat64(c, m ? m->fps : 0)); JS_SetPropertyUint32(c, a, 1, JS_NewInt32(c, m ? (int)m->n : 0));
    JS_SetPropertyUint32(c, a, 2, JS_NewInt32(c, m ? (int)m->w : 0)); JS_SetPropertyUint32(c, a, 3, JS_NewInt32(c, m ? (int)m->h : 0));
    return a;
}
/* movieFrame(id, n) -> image id showing frame n */
FN(h_movieFrame) {
    (void)this_val; int i = argi(c, A(0), -1), n = argi(c, A(1), 0);
    Movie *m = i >= 0 && i < MAX_MOV ? movies[i] : NULL;
    if (!m || !m->n) return JS_NewInt32(c, -1);
    if (n < 0) n = 0; if ((unsigned)n >= m->n) n = m->n - 1;
    if (n != m->shown) {
        size_t base = 16 + (m->n + 1) * 4;
        SDL_RWops *rw = SDL_RWFromConstMem(m->d + base + m->off[n], m->off[n + 1] - m->off[n]);
        SDL_Surface *s = IMG_Load_RW(rw, 1);
        if (s) {
            if (m->img <= 0) { SDL_Texture *t = SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STREAMING, s->w, s->h); m->img = img_new(t, s->w, s->h); }
            if (m->img > 0) {
                SDL_Surface *cs = SDL_ConvertSurfaceFormat(s, SDL_PIXELFORMAT_RGBA32, 0);
                if (cs) { SDL_UpdateTexture(imgs[m->img].t, NULL, cs->pixels, cs->pitch); SDL_FreeSurface(cs); }
            }
            SDL_FreeSurface(s);
        }
        m->shown = n;
    }
    return JS_NewInt32(c, m->img);
}
FN(h_movieClose) {
    (void)this_val; int i = argi(c, A(0), -1);
    if (i >= 0 && i < MAX_MOV && movies[i]) { Movie *m = movies[i]; if (m->img > 0 && imgs[m->img].t) { SDL_DestroyTexture(imgs[m->img].t); imgs[m->img].t = NULL; } free(m->off); free(m->d); free(m); movies[i] = NULL; }
    return JS_UNDEFINED;
}
/* input extras */
static SDL_Sensor *accel;
FN(h_accel) {
    (void)this_val; (void)argc; (void)argv; JSValue a = JS_NewArray(c); float d[3] = { 0, 0, 0 };
    int ok = accel && SDL_SensorGetData(accel, d, 3) == 0;
    for (int k = 0; k < 3; k++) JS_SetPropertyUint32(c, a, k, JS_NewFloat64(c, d[k]));
    JS_SetPropertyUint32(c, a, 3, JS_NewBool(c, ok));
    return a;
}
FN(h_ime) {
    (void)this_val; (void)argv; (void)c;
    if (argc > 0 && JS_ToBool(c, A(0))) SDL_StartTextInput(); else SDL_StopTextInput();
    return JS_UNDEFINED;
}
FN(h_imeActive) { (void)this_val; (void)argc; (void)argv; return JS_NewBool(c, SDL_IsScreenKeyboardShown(win)); }
FN(h_shot) { (void)this_val; const char *p = JS_ToCString(c, A(0)); if (p) { shot_path = strdup(p); JS_FreeCString(c, p); } shot_frames = 2; return JS_UNDEFINED; }

static const JSCFunctionListEntry host_funcs[] = {
    JS_CFUNC_DEF("log", 1, h_log), JS_CFUNC_DEF("time", 0, h_time), JS_CFUNC_DEF("now", 0, h_now),
    JS_CFUNC_DEF("read", 1, h_read), JS_CFUNC_DEF("write", 2, h_write), JS_CFUNC_DEF("exists", 1, h_exists),
    JS_CFUNC_DEF("quit", 0, h_quit), JS_CFUNC_DEF("setRotation", 1, h_rotation),
    JS_CFUNC_DEF("loadImage", 2, h_loadImage), JS_CFUNC_DEF("freeImage", 1, h_freeImage), JS_CFUNC_DEF("imageSize", 1, h_imageSize),
    JS_CFUNC_DEF("drawImage", 13, h_drawImage), JS_CFUNC_DEF("fillRect", 8, h_fillRect), JS_CFUNC_DEF("roundRect", 9, h_roundRect),
    JS_CFUNC_DEF("clip", 4, h_clip), JS_CFUNC_DEF("loadFont", 2, h_loadFont), JS_CFUNC_DEF("freeFont", 1, h_freeFont),
    JS_CFUNC_DEF("textWidth", 2, h_textWidth), JS_CFUNC_DEF("fontMetrics", 1, h_fontMetrics), JS_CFUNC_DEF("drawText", 9, h_drawText),
    JS_CFUNC_DEF("sndLoad", 1, h_sndLoad), JS_CFUNC_DEF("sndInfo", 1, h_sndInfo), JS_CFUNC_DEF("sndFree", 1, h_sndFree),
    JS_CFUNC_DEF("play", 5, h_play), JS_CFUNC_DEF("voiceVol", 2, h_voiceVol), JS_CFUNC_DEF("voiceRep", 2, h_voiceRep),
    JS_CFUNC_DEF("voiceStop", 1, h_voiceStop), JS_CFUNC_DEF("voiceEnded", 1, h_voiceEnded), JS_CFUNC_DEF("voicePos", 1, h_voicePos),
    JS_CFUNC_DEF("audioPause", 1, h_audioPause),
    JS_CFUNC_DEF("movieOpen", 1, h_movieOpen), JS_CFUNC_DEF("movieInfo", 1, h_movieInfo), JS_CFUNC_DEF("movieFrame", 2, h_movieFrame), JS_CFUNC_DEF("movieClose", 1, h_movieClose),
    JS_CFUNC_DEF("accel", 0, h_accel), JS_CFUNC_DEF("ime", 1, h_ime), JS_CFUNC_DEF("imeActive", 0, h_imeActive), JS_CFUNC_DEF("screenshot", 1, h_shot),
};

/* ------------------------------------------------------------------ calling into JS */
static void dump_error(void) {
    JSValue e = JS_GetException(ctx);
    const char *s = JS_ToCString(ctx, e);
    JSValue st = JS_GetPropertyStr(ctx, e, "stack");
    const char *ss = JS_ToCString(ctx, st);
    SDL_Log("JS error: %s\n%s", s ? s : "?", ss ? ss : "");
    if (s) JS_FreeCString(ctx, s); if (ss) JS_FreeCString(ctx, ss);
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
static void send_str(const char *fn, const char *a) { JSValue v[1] = { JS_NewString(ctx, a) }; call_js(fn, 1, v); }
static void send_touch(int kind, int id, float x, float y, int rear) {
    JSValue v[5] = { JS_NewInt32(ctx, kind), JS_NewInt32(ctx, id), JS_NewFloat64(ctx, x), JS_NewFloat64(ctx, y), JS_NewBool(ctx, rear) };
    call_js("onTouch", 5, v);
}
static void send_button(const char *name, int down) { JSValue v[2] = { JS_NewString(ctx, name), JS_NewBool(ctx, down) }; call_js("onButton", 2, v); }

/* screen point (0..1 of the physical screen) -> canvas point */
static void to_canvas(float nx, float ny, float *cx, float *cy) {
    float sx = nx * SW, sy = ny * SH;
    if (rotation == 90) { *cx = sy * (float)CW / SH; *cy = (SW - sx) * (float)CH / SW; }
    else { *cx = (SH - sy) * (float)CW / SH; *cy = sx * (float)CH / SW; }
}

static const char *button_name(int b) {
    switch (b) {
        case SDL_CONTROLLER_BUTTON_A: return "cross"; case SDL_CONTROLLER_BUTTON_B: return "circle";
        case SDL_CONTROLLER_BUTTON_X: return "square"; case SDL_CONTROLLER_BUTTON_Y: return "triangle";
        case SDL_CONTROLLER_BUTTON_LEFTSHOULDER: return "l"; case SDL_CONTROLLER_BUTTON_RIGHTSHOULDER: return "r";
        case SDL_CONTROLLER_BUTTON_START: return "start"; case SDL_CONTROLLER_BUTTON_BACK: return "select";
        case SDL_CONTROLLER_BUTTON_DPAD_UP: return "up"; case SDL_CONTROLLER_BUTTON_DPAD_DOWN: return "down";
        case SDL_CONTROLLER_BUTTON_DPAD_LEFT: return "left"; case SDL_CONTROLLER_BUTTON_DPAD_RIGHT: return "right";
        default: return NULL;
    }
}
static const char *key_name(SDL_Keycode k) {
    switch (k) {
        case SDLK_RETURN: case SDLK_SPACE: return "cross"; case SDLK_ESCAPE: case SDLK_BACKSPACE: return "circle";
        case SDLK_s: return "square"; case SDLK_t: case SDLK_TAB: return "triangle"; case SDLK_q: return "l"; case SDLK_e: return "r";
        case SDLK_m: return "start"; case SDLK_UP: return "up"; case SDLK_DOWN: return "down"; case SDLK_LEFT: return "left"; case SDLK_RIGHT: return "right";
        default: return NULL;
    }
}

int main(int argc, char **argv) {
    const char *scripts[8] = { "game.js" }; int nscripts = 1, custom = 0;
    for (int i = 1; i < argc; i++) if (!strcmp(argv[i], "--script") && i + 1 < argc && nscripts < 8) { if (!custom) { nscripts = 0; custom = 1; } scripts[nscripts++] = argv[++i]; }
#ifdef __vita__
    scePowerSetArmClockFrequency(444); scePowerSetBusClockFrequency(222); scePowerSetGpuClockFrequency(222); scePowerSetGpuXbarClockFrequency(166);
#endif
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO | SDL_INIT_GAMECONTROLLER | SDL_INIT_SENSOR) < 0) {
        SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO | SDL_INIT_GAMECONTROLLER);
    }
    TTF_Init(); IMG_Init(IMG_INIT_JPG | IMG_INIT_PNG);
    win = SDL_CreateWindow("Slop's Last Cry", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, SW, SH, 0);
    ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC | SDL_RENDERER_TARGETTEXTURE);
    if (!ren) ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_TARGETTEXTURE);
    SDL_SetHint(SDL_HINT_RENDER_SCALE_QUALITY, "1");
    canvas = SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGBA8888, SDL_TEXTUREACCESS_TARGET, CW, CH);
    for (int i = 0; i < SDL_NumJoysticks(); i++) if (SDL_IsGameController(i)) SDL_GameControllerOpen(i);
    for (int i = 0; i < SDL_NumSensors(); i++) if (SDL_SensorGetDeviceType(i) == SDL_SENSOR_ACCEL) { accel = SDL_SensorOpen(i); break; }

    SDL_AudioSpec want = { 0 }, have;
    want.freq = 48000; want.format = AUDIO_S16SYS; want.channels = 2; want.samples = 1024; want.callback = audio_cb;
    adev = SDL_OpenAudioDevice(NULL, 0, &want, &have, 0);
    if (adev) SDL_PauseAudioDevice(adev, 0);

    rt = JS_NewRuntime();
    JS_SetMemoryLimit(rt, 96 * 1024 * 1024);
    JS_SetMaxStackSize(rt, 1024 * 1024);
    ctx = JS_NewContext(rt);
    JSValue g = JS_GetGlobalObject(ctx), h = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, h, host_funcs, sizeof host_funcs / sizeof host_funcs[0]);
    JS_SetPropertyStr(ctx, h, "appDir", JS_NewString(ctx, APP_DIR));
    JS_SetPropertyStr(ctx, h, "dataDir", JS_NewString(ctx, DATA_DIR));
#ifdef __vita__
    JS_SetPropertyStr(ctx, h, "vita", JS_TRUE);
    SceAppUtilInitParam aui; SceAppUtilBootParam aub;
    memset(&aui, 0, sizeof aui); memset(&aub, 0, sizeof aub);
    sceAppUtilInit(&aui, &aub);
    int enter = 1; sceAppUtilSystemParamGetInt(SCE_SYSTEM_PARAM_ID_ENTER_BUTTON, &enter);
    JS_SetPropertyStr(ctx, h, "enterCircle", JS_NewBool(ctx, enter == 0));   /* Japanese consoles confirm with circle */
#else
    JS_SetPropertyStr(ctx, h, "vita", JS_FALSE);
    JS_SetPropertyStr(ctx, h, "enterCircle", JS_FALSE);
#endif
    JS_SetPropertyStr(ctx, g, "host", h);
    JS_FreeValue(ctx, g);

    for (int k = 0; k < nscripts; k++) {
        char path[512]; snprintf(path, sizeof path, "%s%s", APP_DIR, scripts[k]);
        size_t len; char *src = read_file(path, &len);
        if (!src) { SDL_Log("cannot read %s", path); return 1; }
        JSValue r = JS_Eval(ctx, src, len, scripts[k], JS_EVAL_TYPE_GLOBAL);
        free(src);
        if (JS_IsException(r)) dump_error();
        JS_FreeValue(ctx, r);
    }
    call_js("main", 0, NULL);

    double last = SDL_GetPerformanceCounter() / (double)SDL_GetPerformanceFrequency();
    Sint16 axes[4] = { 0 };
    while (running) {
        SDL_Event e;
        while (SDL_PollEvent(&e)) {
            switch (e.type) {
            case SDL_QUIT: running = 0; break;
            case SDL_FINGERDOWN: case SDL_FINGERMOTION: case SDL_FINGERUP: {
                if (e.tfinger.touchId == 2) break;   // the rear touchpad is ignored: it is too easy to brush while holding the console
                float cx, cy;
                to_canvas(e.tfinger.x, e.tfinger.y, &cx, &cy);
                send_touch(e.type == SDL_FINGERDOWN ? 0 : e.type == SDL_FINGERMOTION ? 1 : 2, (int)(e.tfinger.fingerId & 0xff), cx, cy, 0);
                break; }
#ifndef __vita__
            case SDL_MOUSEBUTTONDOWN: case SDL_MOUSEMOTION: case SDL_MOUSEBUTTONUP: {
                if (e.type == SDL_MOUSEMOTION && !(e.motion.state & SDL_BUTTON_LMASK)) break;
                int mx = e.type == SDL_MOUSEMOTION ? e.motion.x : e.button.x, my = e.type == SDL_MOUSEMOTION ? e.motion.y : e.button.y;
                float cx, cy; to_canvas(mx / (float)SW, my / (float)SH, &cx, &cy);
                send_touch(e.type == SDL_MOUSEBUTTONDOWN ? 0 : e.type == SDL_MOUSEMOTION ? 1 : 2, 0, cx, cy, 0);
                break; }
            case SDL_MOUSEWHEEL: { JSValue v[1] = { JS_NewInt32(ctx, -e.wheel.y) }; call_js("onWheel", 1, v); break; }
#endif
            case SDL_CONTROLLERBUTTONDOWN: case SDL_CONTROLLERBUTTONUP: {
                const char *n = button_name(e.cbutton.button);
                if (n) send_button(n, e.type == SDL_CONTROLLERBUTTONDOWN);
                break; }
            case SDL_CONTROLLERAXISMOTION:
                if (e.caxis.axis < 4) axes[e.caxis.axis] = e.caxis.value;
                break;
            case SDL_KEYDOWN: case SDL_KEYUP: {
                if (e.key.repeat) break;
                const char *n = key_name(e.key.keysym.sym);
                if (SDL_IsTextInputActive()) {
                    if (e.type == SDL_KEYDOWN && e.key.keysym.sym == SDLK_RETURN) send_str("onIME", "\n");
                    else if (e.type == SDL_KEYDOWN && e.key.keysym.sym == SDLK_BACKSPACE) send_str("onIME", "\b");
                    break;
                }
                if (n) send_button(n, e.type == SDL_KEYDOWN);
                break; }
            case SDL_TEXTINPUT: send_str("onIME", e.text.text); break;
            case SDL_APP_WILLENTERBACKGROUND: audio_paused = 1; break;
            case SDL_APP_DIDENTERFOREGROUND: audio_paused = 0; break;
            }
        }
        double now = SDL_GetPerformanceCounter() / (double)SDL_GetPerformanceFrequency();
        double dt = now - last; last = now;
        {
            JSValue v[5] = { JS_NewFloat64(ctx, dt), JS_NewFloat64(ctx, axes[0] / 32767.0), JS_NewFloat64(ctx, axes[1] / 32767.0),
                             JS_NewFloat64(ctx, axes[2] / 32767.0), JS_NewFloat64(ctx, axes[3] / 32767.0) };
            SDL_SetRenderTarget(ren, canvas);
            SDL_RenderSetClipRect(ren, NULL);
            SDL_SetRenderDrawColor(ren, 0, 0, 0, 255);
            SDL_RenderClear(ren);
            call_js("frame", 5, v);
            SDL_RenderSetClipRect(ren, NULL);
        }
        frame_no++;
        if (shot_path && shot_frames > 0 && --shot_frames == 0) {
            SDL_Surface *s = SDL_CreateRGBSurfaceWithFormat(0, CW, CH, 32, SDL_PIXELFORMAT_RGBA32);
            SDL_RenderReadPixels(ren, NULL, SDL_PIXELFORMAT_RGBA32, s->pixels, s->pitch);
            IMG_SavePNG(s, shot_path);
            SDL_FreeSurface(s); free((void *)shot_path); shot_path = NULL;
        }
        SDL_SetRenderTarget(ren, NULL);
        SDL_SetRenderDrawColor(ren, 0, 0, 0, 255);
        SDL_RenderClear(ren);
        SDL_FRect d = { (SW - CW) / 2.0f, (SH - CH) / 2.0f, CW, CH };
        SDL_RenderCopyExF(ren, canvas, NULL, &d, rotation, NULL, SDL_FLIP_NONE);
        SDL_RenderPresent(ren);
#ifdef __vita__
        sceKernelPowerTick(SCE_KERNEL_POWER_TICK_DISABLE_AUTO_SUSPEND);
#else
        SDL_Delay(14);
#endif
    }
    if (adev) SDL_CloseAudioDevice(adev);
    JS_FreeContext(ctx); JS_FreeRuntime(rt);
    SDL_Quit();
#ifdef __vita__
    sceKernelExitProcess(0);
#endif
    return 0;
}
