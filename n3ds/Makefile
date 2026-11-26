# Slop's Last Cry for New 3DS: builds slops-last-cry.3dsx with devkitARM (libctru, citro2d, citro3d).
#   make            (needs DEVKITPRO, plus checkouts of quickjs-ng in ./quickjs and stb in ./stb)
DEVKITPRO ?= /opt/devkitpro
DEVKITARM ?= $(DEVKITPRO)/devkitARM
QJS ?= quickjs
STB ?= stb
TARGET := slops-last-cry
BUILD := build

CC := $(DEVKITARM)/bin/arm-none-eabi-gcc
TOOLS := $(DEVKITPRO)/tools/bin
ARCH := -march=armv6k -mtune=mpcore -mfloat-abi=hard -mtp=soft
CFLAGS := -O2 -g -mword-relocations -ffunction-sections -fdata-sections $(ARCH) -D__3DS__ \
          -I$(DEVKITPRO)/libctru/include -Isrc -I$(STB) -I$(QJS)
LDFLAGS := -specs=3dsx.specs -g $(ARCH) -Wl,--gc-sections -L$(DEVKITPRO)/libctru/lib
LIBS := -lcitro2d -lcitro3d -lctru -lm

APP_OBJS := $(BUILD)/core.o $(BUILD)/plat_3ds.o
QJS_OBJS := $(BUILD)/qjs_dtoa.o $(BUILD)/qjs_libregexp.o $(BUILD)/qjs_libunicode.o $(BUILD)/qjs_quickjs.o

all: $(TARGET).3dsx

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/%.o: src/%.c src/core.h | $(BUILD)
	$(CC) $(CFLAGS) -Wall -Wno-unused-function -c $< -o $@

$(BUILD)/qjs_%.o: $(QJS)/%.c | $(BUILD)
	$(CC) $(CFLAGS) -D_GNU_SOURCE -w -c $< -o $@

$(BUILD)/$(TARGET).elf: $(APP_OBJS) $(QJS_OBJS)
	$(CC) $(LDFLAGS) $^ $(LIBS) -o $@

# the game engine and the fonts go in the RomFS
$(BUILD)/romfs: ../vita/js/game.js $(wildcard ../vita/fonts/*)
	rm -rf $@ && mkdir -p $@/fonts
	cp ../vita/js/game.js $@/game.js
	cp ../vita/fonts/*.ttf ../vita/fonts/*.txt $@/fonts/

$(BUILD)/$(TARGET).smdh: icon.png | $(BUILD)
	$(TOOLS)/smdhtool --create "Slop's Last Cry" "Unofficial port that plays your own copy of Banshee's Last Cry" "Slop's Last Cry" icon.png $@

$(TARGET).3dsx: $(BUILD)/$(TARGET).elf $(BUILD)/$(TARGET).smdh $(BUILD)/romfs
	$(TOOLS)/3dsxtool $(BUILD)/$(TARGET).elf $@ --smdh=$(BUILD)/$(TARGET).smdh --romfs=$(BUILD)/romfs

clean:
	rm -rf $(BUILD) $(TARGET).3dsx

.PHONY: all clean
