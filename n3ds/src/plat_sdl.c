/*
 * Slop's Last Cry for New 3DS: desktop platform layer (SDL2), for testing the 3DS build on a PC.
 * The two screens are drawn at their real resolutions and shown side by side the way the console
 * is held (like a book). The mouse is the stylus on the touch screen; the keyboard has the buttons:
 * Enter/Space A, Esc/Backspace B, T/Tab X, S Y, Q L, E R, M Start, arrows the D-pad.
 */
#include "core.h"
#include <SDL.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

const char *APP_DIR = "romfs/";
const char *DATA_DIR = "slc-3ds/";

#define VIEW 2   /* window pixels per screen pixel */
static SDL_Window *win;
static SDL_Renderer *ren;
static SDL_Texture *scr[2];
static SDL_AudioDeviceID adev;
static const char *shot_path = NULL;
static int shot_frames = 0, cur = 0, ime_on = 0;

struct GTex { SDL_Texture *t; int w, h, fmt; };
int gfx_max_tex(void) { return 1024; }
GTex *gfx_tex_new(int w, int h, int fmt) {
    GTex *t = calloc(1, sizeof *t);
    t->w = w; t->h = h; t->fmt = fmt;
    t->t = SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STREAMING, w, h);
    if (!t->t) { free(t); return NULL; }
    SDL_SetTextureBlendMode(t->t, SDL_BLENDMODE_BLEND);
    return t;
}
void gfx_tex_upload(GTex *t, const unsigned char *px) {
    if (t->fmt == GT_A8) {
        unsigned char *b = malloc((size_t)t->w * t->h * 4);
        for (int i = 0; i < t->w * t->h; i++) { b[i * 4] = b[i * 4 + 1] = b[i * 4 + 2] = 255; b[i * 4 + 3] = px[i]; }
        SDL_UpdateTexture(t->t, NULL, b, t->w * 4); free(b);
    } else if (t->fmt == GT_OPAQUE) {
        unsigned char *b = malloc((size_t)t->w * t->h * 4);
        memcpy(b, px, (size_t)t->w * t->h * 4);
        for (int i = 0; i < t->w * t->h; i++) b[i * 4 + 3] = 255;
        SDL_UpdateTexture(t->t, NULL, b, t->w * 4); free(b);
    } else SDL_UpdateTexture(t->t, NULL, px, t->w * 4);
}
void gfx_tex_free(GTex *t) { if (t) { SDL_DestroyTexture(t->t); free(t); } }
void gfx_target(int s) { cur = s; SDL_SetRenderTarget(ren, scr[s]); SDL_RenderSetClipRect(ren, NULL); }
void gfx_image(GTex *t, float sx, float sy, float sw, float sh, float px, float py, float cx, float cy,
               float w, float h, float angle, unsigned char r, unsigned char g, unsigned char b, unsigned char a, int solid) {
    SDL_Rect src = { (int)(sx + 0.5f), (int)(sy + 0.5f), (int)(sw + 0.5f), (int)(sh + 0.5f) };
    SDL_FRect dst = { px - cx, py - cy, w, h };
    SDL_FPoint ctr = { cx, cy };
    if (solid) SDL_SetTextureColorMod(t->t, r, g, b); else SDL_SetTextureColorMod(t->t, 255, 255, 255);
    SDL_SetTextureAlphaMod(t->t, a);
    SDL_RenderCopyExF(ren, t->t, &src, &dst, angle * 180.0 / 3.14159265358979, &ctr, SDL_FLIP_NONE);
}
void gfx_tri(const float *xy, unsigned char r, unsigned char g, unsigned char b, unsigned char a) {
    SDL_Vertex v[3];
    for (int i = 0; i < 3; i++) { v[i].position.x = xy[i * 2]; v[i].position.y = xy[i * 2 + 1]; v[i].color.r = r; v[i].color.g = g; v[i].color.b = b; v[i].color.a = a; v[i].tex_coord.x = v[i].tex_coord.y = 0; }
    SDL_RenderGeometry(ren, NULL, v, 3, NULL, 0);
}
void gfx_clip(int on, int x, int y, int w, int h) {
    if (!on) { SDL_RenderSetClipRect(ren, NULL); return; }
    SDL_Rect r = { x, y, w, h };
    if (w <= 0 || h <= 0) { r.x = -10; r.y = -10; r.w = 1; r.h = 1; }
    SDL_RenderSetClipRect(ren, &r);
}

double plat_time(void) { return SDL_GetPerformanceCounter() / (double)SDL_GetPerformanceFrequency(); }
void plat_log(const char *s) { SDL_Log("%s", s); }
void plat_audio_lock(void) { if (adev) SDL_LockAudioDevice(adev); }
void plat_audio_unlock(void) { if (adev) SDL_UnlockAudioDevice(adev); }
void plat_ime(int on, const char *initial) { (void)initial; ime_on = on; if (on) SDL_StartTextInput(); else SDL_StopTextInput(); }
int plat_accel(float out[3]) { (void)out; return 0; }
void plat_quit(void) { }
void plat_screenshot(const char *path) { shot_path = strdup(path); shot_frames = 2; }
static void audio_cb(void *ud, Uint8 *stream, int bytes) { (void)ud; core_mix((short *)stream, bytes / 4); }

/* where each screen sits in the window: the console turned so the top screen is on the left (90)
 * or on the right (270) */
static void layout(int s, SDL_FRect *d, double *ang) {
    int left = core_rotation() == 90 ? s == 0 : s == 1;
    int pw = s ? 320 : 400;
    float x = left ? 0 : (SCR_H + 16) * VIEW, cx = x + SCR_H * VIEW / 2.0f, cy = 400 * VIEW / 2.0f;
    d->w = pw * VIEW; d->h = SCR_H * VIEW; d->x = cx - d->w / 2; d->y = cy - d->h / 2;
    *ang = core_rotation() == 90 ? -90 : 90;
}
static void to_touch(int wx, int wy, float *x, float *y) {
    SDL_FRect d; double ang; layout(1, &d, &ang);
    float cx = d.x + d.w / 2, cy = d.y + d.h / 2, rx = wx - cx, ry = wy - cy, ux, uy;
    if (ang < 0) { ux = -ry; uy = rx; } else { ux = ry; uy = -rx; }   /* undo the view rotation */
    *x = (ux + d.w / 2) / VIEW; *y = (uy + d.h / 2) / VIEW;
}
static const char *key_name(SDL_Keycode k) {
    switch (k) {
        case SDLK_RETURN: case SDLK_SPACE: return "cross"; case SDLK_ESCAPE: case SDLK_BACKSPACE: return "circle";
        case SDLK_s: return "square"; case SDLK_t: case SDLK_TAB: return "triangle"; case SDLK_q: return "l"; case SDLK_e: return "r";
        case SDLK_m: return "start"; case SDLK_n: return "select";
        case SDLK_UP: return "up"; case SDLK_DOWN: return "down"; case SDLK_LEFT: return "left"; case SDLK_RIGHT: return "right";
        default: return NULL;
    }
}

int main(int argc, char **argv) {
    const char *scripts[8] = { "game.js" }; int nscripts = 1, custom = 0;
    for (int i = 1; i < argc; i++) if (!strcmp(argv[i], "--script") && i + 1 < argc && nscripts < 8) { if (!custom) { nscripts = 0; custom = 1; } scripts[nscripts++] = argv[++i]; }
    SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO);
    int ww = (SCR_H * 2 + 16) * VIEW, wh = 400 * VIEW;
    win = SDL_CreateWindow("Slop's Last Cry (3DS)", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, ww, wh, 0);
    ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_TARGETTEXTURE | SDL_RENDERER_PRESENTVSYNC);
    if (!ren) ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_TARGETTEXTURE);
    SDL_SetHint(SDL_HINT_RENDER_SCALE_QUALITY, "1");
    scr[0] = SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGBA8888, SDL_TEXTUREACCESS_TARGET, 400, SCR_H);
    scr[1] = SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGBA8888, SDL_TEXTUREACCESS_TARGET, 320, SCR_H);
    SDL_AudioSpec want = { 0 }, have;
    want.freq = AUDIO_RATE; want.format = AUDIO_S16SYS; want.channels = 2; want.samples = 1024; want.callback = audio_cb;
    adev = SDL_OpenAudioDevice(NULL, 0, &want, &have, 0);
    if (adev) SDL_PauseAudioDevice(adev, 0);
    if (!core_init(scripts, nscripts, 0)) return 1;

    double last = plat_time();
    int down = 0;
    while (core_running) {
        SDL_Event e;
        while (SDL_PollEvent(&e)) {
            switch (e.type) {
            case SDL_QUIT: core_running = 0; break;
            case SDL_MOUSEBUTTONDOWN: case SDL_MOUSEMOTION: case SDL_MOUSEBUTTONUP: {
                if (e.type == SDL_MOUSEMOTION && !down) break;
                int mx = e.type == SDL_MOUSEMOTION ? e.motion.x : e.button.x, my = e.type == SDL_MOUSEMOTION ? e.motion.y : e.button.y;
                float x, y; to_touch(mx, my, &x, &y);
                if (e.type == SDL_MOUSEBUTTONDOWN) { if (x < 0 || y < 0 || x >= 320 || y >= SCR_H) break; down = 1; core_touch(0, 0, x, y); }
                else if (e.type == SDL_MOUSEMOTION) core_touch(1, 0, x, y);
                else if (down) { down = 0; core_touch(2, 0, x, y); }
                break; }
            case SDL_KEYDOWN: case SDL_KEYUP: {
                if (e.key.repeat) break;
                if (ime_on) {
                    if (e.type == SDL_KEYDOWN && e.key.keysym.sym == SDLK_RETURN) core_ime_text("\n");
                    else if (e.type == SDL_KEYDOWN && e.key.keysym.sym == SDLK_BACKSPACE) core_ime_text("\b");
                    break;
                }
                const char *n = key_name(e.key.keysym.sym);
                if (n) core_button(n, e.type == SDL_KEYDOWN);
                break; }
            case SDL_TEXTINPUT: core_ime_text(e.text.text); break;
            }
        }
        double now = plat_time(), dt = now - last; last = now;
        for (int s = 0; s < 2; s++) { SDL_SetRenderTarget(ren, scr[s]); SDL_SetRenderDrawColor(ren, 0, 0, 0, 255); SDL_RenderClear(ren); }
        gfx_target(0);
        core_frame(dt, 0, 0, 0, 0);
        SDL_SetRenderTarget(ren, NULL);
        SDL_SetRenderDrawColor(ren, 40, 40, 44, 255);
        SDL_RenderClear(ren);
        for (int s = 0; s < 2; s++) { SDL_FRect d; double ang; layout(s, &d, &ang); SDL_RenderCopyExF(ren, scr[s], NULL, &d, ang, NULL, SDL_FLIP_NONE); }
        if (shot_path && shot_frames > 0 && --shot_frames == 0) {
            SDL_Surface *s = SDL_CreateRGBSurfaceWithFormat(0, ww, wh, 32, SDL_PIXELFORMAT_RGBA32);
            SDL_RenderReadPixels(ren, NULL, SDL_PIXELFORMAT_RGBA32, s->pixels, s->pitch);
            SDL_SaveBMP(s, shot_path);
            SDL_FreeSurface(s); free((void *)shot_path); shot_path = NULL;
        }
        SDL_RenderPresent(ren);
        SDL_Delay(14);
    }
    core_shutdown();
    if (adev) SDL_CloseAudioDevice(adev);
    SDL_Quit();
    return 0;
}
