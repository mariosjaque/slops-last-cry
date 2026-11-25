cmake_minimum_required(VERSION 3.16)

# Slop's Last Cry for PS Vita. Builds a .vpk with the VitaSDK toolchain, or a desktop binary
# (same code, SDL2) for testing: cmake -DSLC_DESKTOP=ON -DCMAKE_PREFIX_PATH=<deps>.
if(NOT SLC_DESKTOP)
  if(NOT DEFINED CMAKE_TOOLCHAIN_FILE)
    if(DEFINED ENV{VITASDK})
      set(CMAKE_TOOLCHAIN_FILE "$ENV{VITASDK}/share/vita.toolchain.cmake" CACHE PATH "toolchain file")
    else()
      message(FATAL_ERROR "Please define VITASDK to point to your SDK path!")
    endif()
  endif()
endif()

project(slops_last_cry C)
set(CMAKE_C_STANDARD 11)

if(NOT SLC_DESKTOP)
  include("$ENV{VITASDK}/share/vita.cmake" REQUIRED)
  set(VITA_APP_NAME "Slop's Last Cry")
  set(VITA_TITLEID "SLCR00001")
  set(VITA_VERSION "01.00")
  set(VITA_MKSFOEX_FLAGS "${VITA_MKSFOEX_FLAGS} -d ATTRIBUTE2=12")   # extended memory for the game's pictures and music

  add_executable(slc src/host.c)
  target_compile_options(slc PRIVATE -O2 -Wall -Wno-misleading-indentation)
  target_include_directories(slc PRIVATE $ENV{VITASDK}/arm-vita-eabi/include/SDL2 $ENV{VITASDK}/arm-vita-eabi/include/opus)
  # libraries from vdpm; optional ones are only linked when present in this SDK
  set(SLC_LIBS SDL2_ttf SDL2_image SDL2 freetype harfbuzz png jpeg webpdemux webp sharpyuv bz2 z opus quickjs)
  set(SLC_LINK "")
  foreach(l ${SLC_LIBS})
    find_library(LIB_${l} ${l})
    if(LIB_${l})
      list(APPEND SLC_LINK ${LIB_${l}})
    elseif(l MATCHES "^(SDL2|SDL2_ttf|SDL2_image|opus|quickjs|freetype|z)$")
      message(FATAL_ERROR "missing library ${l}")
    endif()
  endforeach()
  target_link_libraries(slc ${SLC_LINK}
    SceAppMgr_stub SceAppUtil_stub SceAudio_stub SceAudioIn_stub SceCommonDialog_stub SceCtrl_stub SceDisplay_stub SceGxm_stub
    SceHid_stub SceIme_stub SceMotion_stub ScePower_stub SceSysmodule_stub SceTouch_stub SceKernelDmacMgr_stub
    m pthread)
  vita_create_self(eboot.bin slc UNSAFE)
  vita_create_vpk(slops-last-cry.vpk ${VITA_TITLEID} eboot.bin
    VERSION ${VITA_VERSION}
    NAME ${VITA_APP_NAME}
    FILE js/game.js game.js
    FILE fonts/LibreBaskerville-Regular.ttf fonts/LibreBaskerville-Regular.ttf
    FILE fonts/LibreBaskerville-Bold.ttf fonts/LibreBaskerville-Bold.ttf
    FILE fonts/LibreBaskerville-Italic.ttf fonts/LibreBaskerville-Italic.ttf
    FILE fonts/LibreBaskerville-BoldItalic.ttf fonts/LibreBaskerville-BoldItalic.ttf
    FILE fonts/Lato-Regular.ttf fonts/Lato-Regular.ttf
    FILE fonts/Lato-Bold.ttf fonts/Lato-Bold.ttf
    FILE fonts/Lato-Italic.ttf fonts/Lato-Italic.ttf
    FILE fonts/Lato-BoldItalic.ttf fonts/Lato-BoldItalic.ttf
    FILE fonts/LibreBaskerville-OFL.txt fonts/LibreBaskerville-OFL.txt
    FILE fonts/Lato-OFL.txt fonts/Lato-OFL.txt
    FILE sce_sys/icon0.png sce_sys/icon0.png
    FILE sce_sys/livearea/contents/bg.png sce_sys/livearea/contents/bg.png
    FILE sce_sys/livearea/contents/startup.png sce_sys/livearea/contents/startup.png
    FILE sce_sys/livearea/contents/template.xml sce_sys/livearea/contents/template.xml
  )
else()
  # desktop test build: static SDL2/SDL2_ttf/SDL2_image/opus/quickjs from CMAKE_PREFIX_PATH
  find_path(SDL_INC SDL.h PATH_SUFFIXES SDL2 REQUIRED)
  find_path(OPUS_INC opus.h PATH_SUFFIXES opus REQUIRED)
  find_path(QJS_INC quickjs.h REQUIRED)
  find_library(L_SDL2 SDL2 REQUIRED)
  find_library(L_TTF SDL2_ttf REQUIRED)
  find_library(L_IMG SDL2_image REQUIRED)
  find_library(L_OPUS opus REQUIRED)
  find_library(L_QJS qjs REQUIRED)
  find_package(Freetype REQUIRED)
  add_executable(slc src/host.c)
  target_include_directories(slc PRIVATE ${SDL_INC} ${OPUS_INC} ${QJS_INC})
  target_compile_options(slc PRIVATE -O1 -g -Wall)
  target_link_libraries(slc ${L_TTF} ${L_IMG} ${L_SDL2} ${L_OPUS} ${L_QJS} Freetype::Freetype m pthread dl)
endif()
