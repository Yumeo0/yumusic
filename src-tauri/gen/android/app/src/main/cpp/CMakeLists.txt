cmake_minimum_required(VERSION 3.22.1)
project(yumusic_discord LANGUAGES CXX)

if(NOT DEFINED DISCORD_SDK_DIR)
    message(FATAL_ERROR "DISCORD_SDK_DIR must point to the extracted Discord Android AAR")
endif()
add_library(yumusic_discord SHARED discord_presence.cpp)
target_compile_features(yumusic_discord PRIVATE cxx_std_17)
target_include_directories(yumusic_discord PRIVATE "${DISCORD_SDK_DIR}/prefab/modules/discord_partner_sdk/include")
# The AAR packages the SDK library in the APK; only our bridge is built here.
target_link_libraries(yumusic_discord PRIVATE "${DISCORD_SDK_DIR}/jni/${ANDROID_ABI}/libdiscord_partner_sdk.so" android log)

# Android 15+ devices may use 16 KiB memory pages (also supported by the SDK).
target_link_options(yumusic_discord PRIVATE "-Wl,-z,max-page-size=16384")
