/*
 * Slop's Last Cry for New 3DS: the interface between the shared core (core.c: JavaScript, text,
 * pictures, sound, movies) and a platform (plat_3ds.c on the console, plat_sdl.c on a desktop for
 * testing).
 *
 * Coordinates given to the platform are physical screen pixels of the screen being drawn, in the
 * screen's own landscape orientation (top 400x240, bottom 320x240). The core turns the game's
 * portrait canvases into those, since the console is held like a book.
 */
#ifndef SLC_CORE_H
#define SLC_CORE_H

#define SCR_H 240
#define AUDIO_RATE 32000

/* ---- provided by the platform ---- */
typedef struct GTex GTex;
enum { GT_RGBA = 0, GT_A8 = 1, GT_OPAQUE = 2 };
GTex *gfx_tex_new(int w, int h, int fmt);            /* NULL if out of memory */
void gfx_tex_upload(GTex *t, const unsigned char *px); /* w*h pixels: RGBA (4 bytes) or A8 (1 byte) */
void gfx_tex_free(GTex *t);                           /* may be deferred until the frame ends */
int gfx_max_tex(void);
void gfx_target(int screen);                          /* 0 top, 1 bottom: following draws go there */
/* Draws the (sx,sy,sw,sh) part of a texture as a w x h rectangle whose local point (cx,cy) is at
 * (px,py), rotated by `angle` radians (clockwise) around that point. solid: the texture is a mask
 * coloured with rgb; otherwise only the alpha is applied. */
void gfx_image(GTex *t, float sx, float sy, float sw, float sh, float px, float py, float cx, float cy,
               float w, float h, float angle, unsigned char r, unsigned char g, unsigned char b, unsigned char a, int solid);
void gfx_tri(const float *xy, unsigned char r, unsigned char g, unsigned char b, unsigned char a);
void gfx_clip(int on, int x, int y, int w, int h);

double plat_time(void);
void plat_log(const char *s);
void plat_audio_lock(void);
void plat_audio_unlock(void);
void plat_ime(int on, const char *initial);
int plat_accel(float out[3]);                         /* m/s^2; returns 0 when there is none */
void plat_quit(void);
void plat_screenshot(const char *path);

extern const char *APP_DIR, *DATA_DIR;

/* ---- provided by the core ---- */
int core_init(const char **scripts, int n, int is_console);
void core_frame(double dt, float lx, float ly, float rx, float ry);
void core_touch(int kind, int id, float x, float y);  /* kind 0 down, 1 move, 2 up; bottom screen pixels */
void core_button(const char *name, int down);
void core_ime_text(const char *s);                    /* one keyboard result, or "\n" / "\b" */
void core_mix(short *out, int frames);                /* stereo, AUDIO_RATE */
void core_set_paused(int p);
int core_rotation(void);
void core_shutdown(void);
extern int core_running;

#endif
