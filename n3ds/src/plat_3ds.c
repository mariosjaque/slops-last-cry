/*
 * Slop's Last Cry for New 3DS: the console platform layer (libctru, citro2d, ndsp).
 * Draws with the GPU, mixes sound on its own thread into the DSP, reads the buttons, the touch
 * screen and the accelerometer, and shows the system keyboard for names.
 */
#include "core.h"
#include <3ds.h>
#include <citro2d.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <sys/stat.h>

const char *APP_DIR = "romfs:/";
const char *DATA_DIR = "sdmc:/3ds/slc/";
u32 __stacksize__ = 1024 * 1024;   /* QuickJS needs a deeper stack than the default */

static C3D_RenderTarget *tgt[2];
static int cur = 0;
static FILE *log_file = NULL;

/* ------------------------------------------------------------------ textures */
struct GTex { C3D_Tex tex; int w, h, tw, th, fmt; struct GTex *next_free; };
static GTex *free_list = NULL;   /* freed during a frame: deleted once the GPU is done with it */
static int pow2(int v) { int p = 8; while (p < v) p <<= 1; return p; }
int gfx_max_tex(void) { return 1024; }
GTex *gfx_tex_new(int w, int h, int fmt) {
    if (w <= 0 || h <= 0 || w > 1024 || h > 1024) return NULL;
    GTex *t = calloc(1, sizeof *t);
    if (!t) return NULL;
    t->w = w; t->h = h; t->fmt = fmt; t->tw = pow2(w); t->th = pow2(h);
    GPU_TEXCOLOR c = fmt == GT_A8 ? GPU_A8 : fmt == GT_OPAQUE ? GPU_RGB565 : GPU_RGBA8;
    if (!C3D_TexInit(&t->tex, t->tw, t->th, c)) { free(t); return NULL; }
    C3D_TexSetFilter(&t->tex, GPU_LINEAR, GPU_LINEAR);
    C3D_TexSetWrap(&t->tex, GPU_CLAMP_TO_EDGE, GPU_CLAMP_TO_EDGE);
    memset(t->tex.data, 0, t->tex.size);
    return t;
}
/* position of texel (x,y) in the GPU's 8x8 tiled (Morton) layout */
static inline u32 tiled(u32 x, u32 y, u32 tw) {
    return ((((y >> 3) * (tw >> 3) + (x >> 3)) << 6) + ((x & 1) | ((y & 1) << 1) | ((x & 2) << 1) | ((y & 2) << 2) | ((x & 4) << 2) | ((y & 4) << 3)));
}
void gfx_tex_upload(GTex *t, const unsigned char *px) {
    if (t->fmt == GT_A8) {
        u8 *d = (u8 *)t->tex.data;
        for (int y = 0; y < t->h; y++) for (int x = 0; x < t->w; x++) d[tiled(x, y, t->tw)] = px[y * t->w + x];
    } else if (t->fmt == GT_OPAQUE) {
        u16 *d = (u16 *)t->tex.data;
        for (int y = 0; y < t->h; y++) for (int x = 0; x < t->w; x++) {
            const unsigned char *p = px + ((size_t)y * t->w + x) * 4;
            d[tiled(x, y, t->tw)] = (u16)(((p[0] >> 3) << 11) | ((p[1] >> 2) << 5) | (p[2] >> 3));
        }
    } else {
        u32 *d = (u32 *)t->tex.data;
        for (int y = 0; y < t->h; y++) for (int x = 0; x < t->w; x++) {
            const unsigned char *p = px + ((size_t)y * t->w + x) * 4;
            d[tiled(x, y, t->tw)] = ((u32)p[0] << 24) | ((u32)p[1] << 16) | ((u32)p[2] << 8) | p[3];
        }
    }
    C3D_TexFlush(&t->tex);
}
void gfx_tex_free(GTex *t) { if (t) { t->next_free = free_list; free_list = t; } }
static void free_pending(void) {
    while (free_list) { GTex *t = free_list; free_list = t->next_free; C3D_TexDelete(&t->tex); free(t); }
}

/* ------------------------------------------------------------------ drawing */
void gfx_target(int s) {
    cur = s ? 1 : 0;
    C2D_SceneBegin(tgt[cur]);
    C3D_SetScissor(GPU_SCISSOR_DISABLE, 0, 0, 0, 0);
}
void gfx_image(GTex *t, float sx, float sy, float sw, float sh, float px, float py, float cx, float cy,
               float w, float h, float angle, unsigned char r, unsigned char g, unsigned char b, unsigned char a, int solid) {
    if (!t || a == 0) return;
    Tex3DS_SubTexture sub = { (u16)sw, (u16)sh, sx / t->tw, 1.0f - sy / t->th, (sx + sw) / t->tw, 1.0f - (sy + sh) / t->th };
    C2D_Image im = { &t->tex, &sub };
    C2D_ImageTint tint;
    if (solid) C2D_PlainImageTint(&tint, C2D_Color32(r, g, b, a), 1.0f);
    else C2D_AlphaImageTint(&tint, a / 255.0f);
    C2D_DrawParams p = { { px, py, w, h }, { cx, cy }, 0.5f, angle };
    C2D_DrawImage(im, &p, &tint);
}
void gfx_tri(const float *xy, unsigned char r, unsigned char g, unsigned char b, unsigned char a) {
    u32 c = C2D_Color32(r, g, b, a);
    C2D_DrawTriangle(xy[0], xy[1], c, xy[2], xy[3], c, xy[4], xy[5], c, 0.5f);
}
void gfx_clip(int on, int x, int y, int w, int h) {
    C2D_Flush();
    if (!on) { C3D_SetScissor(GPU_SCISSOR_DISABLE, 0, 0, 0, 0); return; }
    int pw = cur ? 320 : 400;
    if (w <= 0 || h <= 0) { x = 0; y = 0; w = 0; h = 0; }
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > pw) w = pw - x;
    if (y + h > SCR_H) h = SCR_H - y;
    if (w < 0) w = 0;
    if (h < 0) h = 0;
    /* the framebuffers are stored rotated: screen x runs along the buffer's height */
    C3D_SetScissor(GPU_SCISSOR_NORMAL, SCR_H - (y + h), pw - (x + w), SCR_H - y, pw - x);
}

/* ------------------------------------------------------------------ misc */
double plat_time(void) { return svcGetSystemTick() / (double)SYSCLOCK_ARM11; }
void plat_log(const char *s) {
    if (log_file) { fputs(s, log_file); fputc('\n', log_file); fflush(log_file); }
}
static LightLock alock;
void plat_audio_lock(void) { LightLock_Lock(&alock); }
void plat_audio_unlock(void) { LightLock_Unlock(&alock); }
static int ime_pending = 0;
static char ime_initial[64];
void plat_ime(int on, const char *initial) {
    if (!on) return;
    snprintf(ime_initial, sizeof ime_initial, "%s", initial ? initial : "");
    ime_pending = 1;   /* the keyboard applet runs between frames */
}
static float acc_scale = 0;
int plat_accel(float out[3]) {
    accelVector a; hidAccelRead(&a);
    float m = sqrtf((float)a.x * a.x + (float)a.y * a.y + (float)a.z * a.z);
    if (m < 1) return 0;
    /* calibrate: the slow average of the magnitude is 1 g */
    acc_scale = acc_scale <= 0 ? m : acc_scale * 0.995f + m * 0.005f;
    float k = 9.81f / acc_scale;
    out[0] = a.x * k; out[1] = a.y * k; out[2] = a.z * k;
    return 1;
}
void plat_quit(void) { }
void plat_screenshot(const char *path) { (void)path; }

/* ------------------------------------------------------------------ sound: a mixing thread feeding the DSP */
#define NBUF 4
#define AFRAMES 1024
static ndspWaveBuf wbuf[NBUF];
static short *abuf = NULL;
static LightEvent aevent;
static volatile int athread_run = 0;
static Thread athread = NULL;
static void ndsp_cb(void *d) { (void)d; LightEvent_Signal(&aevent); }
static void audio_thread(void *arg) {
    (void)arg;
    while (athread_run) {
        for (int i = 0; i < NBUF; i++) {
            if (wbuf[i].status != NDSP_WBUF_DONE && wbuf[i].status != NDSP_WBUF_FREE) continue;
            core_mix(wbuf[i].data_pcm16, AFRAMES);
            DSP_FlushDataCache(wbuf[i].data_pcm16, AFRAMES * 4);
            ndspChnWaveBufAdd(0, &wbuf[i]);
        }
        LightEvent_Wait(&aevent);
    }
}
static int audio_init(void) {
    LightLock_Init(&alock);
    if (R_FAILED(ndspInit())) { plat_log("ndsp: no DSP firmware (sdmc:/3ds/dspfirm.cdc); playing without sound"); return 0; }
    ndspSetOutputMode(NDSP_OUTPUT_STEREO);
    ndspChnReset(0);
    ndspChnSetInterp(0, NDSP_INTERP_LINEAR);
    ndspChnSetRate(0, AUDIO_RATE);
    ndspChnSetFormat(0, NDSP_FORMAT_STEREO_PCM16);
    float mix[12]; memset(mix, 0, sizeof mix); mix[0] = mix[1] = 1.0f;
    ndspChnSetMix(0, mix);
    abuf = linearAlloc(NBUF * AFRAMES * 4);
    if (!abuf) { ndspExit(); return 0; }
    memset(abuf, 0, NBUF * AFRAMES * 4);
    memset(wbuf, 0, sizeof wbuf);
    for (int i = 0; i < NBUF; i++) { wbuf[i].data_vaddr = abuf + i * AFRAMES * 2; wbuf[i].nsamples = AFRAMES; wbuf[i].status = NDSP_WBUF_FREE; }
    LightEvent_Init(&aevent, RESET_ONESHOT);
    ndspSetCallback(ndsp_cb, NULL);
    s32 prio = 0x30; svcGetThreadPriority(&prio, CUR_THREAD_HANDLE);
    athread_run = 1;
    athread = threadCreate(audio_thread, NULL, 32 * 1024, prio - 1 < 0x18 ? 0x18 : prio - 1, -2, false);
    if (!athread) { athread_run = 0; ndspExit(); return 0; }
    return 1;
}
static void audio_exit(void) {
    if (athread) { athread_run = 0; LightEvent_Signal(&aevent); threadJoin(athread, U64_MAX); threadFree(athread); athread = NULL; }
    if (abuf) { ndspChnWaveBufClear(0); ndspExit(); linearFree(abuf); abuf = NULL; }
}
static aptHookCookie hook;
static void apt_cb(APT_HookType t, void *p) {
    (void)p;
    if (t == APTHOOK_ONSUSPEND || t == APTHOOK_ONSLEEP) core_set_paused(1);
    else if (t == APTHOOK_ONRESTORE || t == APTHOOK_ONWAKEUP) core_set_paused(0);
}

/* ------------------------------------------------------------------ main loop */
static const struct { u32 key; const char *name; } KEYS[] = {
    { KEY_A, "cross" }, { KEY_B, "circle" }, { KEY_X, "triangle" }, { KEY_Y, "square" },
    { KEY_L, "l" }, { KEY_ZL, "l" }, { KEY_R, "r" }, { KEY_ZR, "r" }, { KEY_START, "start" }, { KEY_SELECT, "select" },
    { KEY_DUP, "up" }, { KEY_DDOWN, "down" }, { KEY_DLEFT, "left" }, { KEY_DRIGHT, "right" },
};
static float axis(int v) { float f = v / 150.0f; return f > 1 ? 1 : f < -1 ? -1 : f; }

int main(void) {
    osSetSpeedupEnable(true);
    gfxInitDefault();
    C3D_Init(C3D_DEFAULT_CMDBUF_SIZE * 2);
    C2D_Init(8192);
    C2D_Prepare();
    tgt[0] = C2D_CreateScreenTarget(GFX_TOP, GFX_LEFT);
    tgt[1] = C2D_CreateScreenTarget(GFX_BOTTOM, GFX_LEFT);
    romfsInit();
    mkdir("sdmc:/3ds", 0777); mkdir("sdmc:/3ds/slc", 0777);
    log_file = fopen("sdmc:/3ds/slc/log.txt", "w");
    HIDUSER_EnableAccelerometer();
    aptHook(&hook, apt_cb, NULL);
    audio_init();

    const char *scripts[1] = { "game.js" };
    int ok = core_init(scripts, 1, 1);
    double last = plat_time();
    int touching = 0; touchPosition lastTouch = { 0, 0 };
    while (ok && core_running && aptMainLoop()) {
        hidScanInput();
        u32 down = hidKeysDown(), up = hidKeysUp(), held = hidKeysHeld();
        for (size_t i = 0; i < sizeof KEYS / sizeof KEYS[0]; i++) {
            if (down & KEYS[i].key) core_button(KEYS[i].name, 1);
            if (up & KEYS[i].key) core_button(KEYS[i].name, 0);
        }
        if (held & KEY_TOUCH) {
            touchPosition tp; hidTouchRead(&tp);
            if (!touching) { touching = 1; core_touch(0, 0, tp.px, tp.py); }
            else if (tp.px != lastTouch.px || tp.py != lastTouch.py) core_touch(1, 0, tp.px, tp.py);
            lastTouch = tp;
        } else if (touching) { touching = 0; core_touch(2, 0, lastTouch.px, lastTouch.py); }
        if (ime_pending) {
            ime_pending = 0;
            SwkbdState kb; char out[64] = { 0 };
            swkbdInit(&kb, SWKBD_TYPE_WESTERN, 2, 16);
            swkbdSetInitialText(&kb, ime_initial);
            swkbdSetValidation(&kb, SWKBD_NOTBLANK_NOTEMPTY, 0, 0);
            SwkbdButton b = swkbdInputText(&kb, out, sizeof out);
            if (b == SWKBD_BUTTON_CONFIRM && out[0]) core_ime_text(out);
            core_ime_text("\n");
            last = plat_time();
        }
        circlePosition cp, cs; hidCircleRead(&cp); hidCstickRead(&cs);
        double now = plat_time(), dt = now - last; last = now;
        if (dt > 0.1) dt = 0.1;
        C3D_FrameBegin(C3D_FRAME_SYNCDRAW);
        free_pending();
        C2D_TargetClear(tgt[0], C2D_Color32(0, 0, 0, 255));
        C2D_TargetClear(tgt[1], C2D_Color32(0, 0, 0, 255));
        gfx_target(0);
        core_frame(dt, axis(cp.dx), -axis(cp.dy), axis(cs.dx), -axis(cs.dy));
        C3D_FrameEnd(0);
    }
    audio_exit();
    core_shutdown();
    C3D_FrameBegin(C3D_FRAME_SYNCDRAW); free_pending(); C3D_FrameEnd(0);
    aptUnhook(&hook);
    if (log_file) fclose(log_file);
    romfsExit();
    C2D_Fini(); C3D_Fini(); gfxExit();
    return 0;
}
