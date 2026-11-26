cmake_minimum_required(VERSION 3.16)
# Desktop test build of the 3DS version (the console build uses the Makefile):
#   cmake -S n3ds -B build -DCMAKE_PREFIX_PATH=<SDL2 and QuickJS> -DSTB_DIR=<stb checkout>
project(slc3ds_desktop C)
set(CMAKE_C_STANDARD 11)
find_path(SDL_INC SDL.h PATH_SUFFIXES SDL2 REQUIRED)
find_path(QJS_INC quickjs.h REQUIRED)
find_library(L_SDL2 SDL2 REQUIRED)
find_library(L_QJS qjs REQUIRED)
add_executable(slc3ds src/core.c src/plat_sdl.c)
target_include_directories(slc3ds PRIVATE ${SDL_INC} ${QJS_INC} ${STB_DIR})
target_compile_options(slc3ds PRIVATE -O1 -g -Wall -Wextra -Wno-unused-parameter)
target_link_libraries(slc3ds ${L_SDL2} ${L_QJS} m pthread dl)
