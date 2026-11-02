#include <jni.h>
#include <android/log.h>
#include <chrono>
#include <algorithm>
#include <cstdint>
#include <cmath>
#include <memory>
#include <string>
#define DISCORDPP_IMPLEMENTATION
#include <discordpp.h>

namespace {
std::unique_ptr<discordpp::Client> client;
uint64_t applicationId = 0;

// Java strings use UTF-16; GetStringUTFChars uses modified UTF-8, which
// corrupts supplementary artist/title characters. Convert through UTF-8 bytes.
std::string utf8(JNIEnv* env, jstring value) {
    if (!value) return {};
    auto stringClass = env->FindClass("java/lang/String");
    auto getBytes = env->GetMethodID(stringClass, "getBytes", "(Ljava/lang/String;)[B");
    auto charset = env->NewStringUTF("UTF-8");
    auto bytes = static_cast<jbyteArray>(env->CallObjectMethod(value, getBytes, charset));
    auto size = env->GetArrayLength(bytes);
    std::string text(size, '\0');
    env->GetByteArrayRegion(bytes, 0, size, reinterpret_cast<jbyte*>(text.data()));
    env->DeleteLocalRef(bytes);
    env->DeleteLocalRef(charset);
    env->DeleteLocalRef(stringClass);
    return text;
}

std::string clipped(std::string text) {
    if (text.size() <= 128) return text;
    size_t end = 128;
    while (end > 0 && (static_cast<unsigned char>(text[end]) & 0xc0) == 0x80) --end;
    text.resize(end);
    return text;
}
}

extern "C" JNIEXPORT void JNICALL
Java_dev_yumeo_yumusic_DiscordPresence_nativeUpdate(JNIEnv* env, jobject,
    jlong appId, jstring title, jstring artist, jstring album, jstring cover,
    jstring songUrl, jstring artistUrl, jstring albumUrl,
    jboolean playing, jdouble elapsed, jdouble duration) {
    if (!client || applicationId != static_cast<uint64_t>(appId)) {
        client = std::make_unique<discordpp::Client>();
        applicationId = static_cast<uint64_t>(appId);
        client->SetApplicationId(applicationId);
    }
    discordpp::Activity activity;
    activity.SetName("YuMusic");
    activity.SetStatusDisplayType(discordpp::StatusDisplayTypes::Name);
    activity.SetType(discordpp::ActivityTypes::Listening);
    activity.SetDetails(clipped(utf8(env, title)));
    activity.SetState(clipped(utf8(env, artist)));
    activity.SetDetailsUrl(utf8(env, songUrl));
    auto artistLink = utf8(env, artistUrl);
    if (!artistLink.empty()) activity.SetStateUrl(artistLink);

    discordpp::ActivityAssets assets;
    auto artwork = utf8(env, cover);
    auto albumLink = utf8(env, albumUrl);
    if (!artwork.empty()) {
        assets.SetLargeImage(artwork);
        auto albumName = utf8(env, album);
        assets.SetLargeText(playing ? clipped(albumName.empty() ? utf8(env, title) : albumName) : "Paused");
        if (!albumLink.empty()) assets.SetLargeUrl(albumLink);
    }
    activity.SetAssets(assets);

    discordpp::ActivityButton songButton;
    songButton.SetLabel("Open song");
    songButton.SetUrl(utf8(env, songUrl));
    activity.AddButton(songButton);
    if (!albumLink.empty() || !artistLink.empty()) {
        discordpp::ActivityButton secondary;
        secondary.SetLabel(albumLink.empty() ? "View artist" : "View album");
        secondary.SetUrl(albumLink.empty() ? artistLink : albumLink);
        activity.AddButton(secondary);
    }

    if (playing) {
        auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        auto elapsedMs = std::isfinite(elapsed) ? static_cast<int64_t>(std::max(0.0, elapsed) * 1000) : 0;
        discordpp::ActivityTimestamps timestamps;
        timestamps.SetStart(now - elapsedMs);
        if (std::isfinite(duration) && duration > 0)
            timestamps.SetEnd(now - elapsedMs + static_cast<int64_t>(duration * 1000));
        activity.SetTimestamps(timestamps);
    }
    client->UpdateRichPresence(activity, [](discordpp::ClientResult result) {
        if (!result.Successful())
            __android_log_print(ANDROID_LOG_WARN, "YuMusicDiscord", "Presence update failed: %s", result.Error().c_str());
    });
}

extern "C" JNIEXPORT void JNICALL
Java_dev_yumeo_yumusic_DiscordPresence_nativeClear(JNIEnv*, jobject) {
    if (client) client->ClearRichPresence();
}

extern "C" JNIEXPORT void JNICALL
Java_dev_yumeo_yumusic_DiscordPresence_nativeRunCallbacks(JNIEnv*, jobject) {
    discordpp::RunCallbacks();
}

extern "C" JNIEXPORT void JNICALL
Java_dev_yumeo_yumusic_DiscordPresence_nativeShutdown(JNIEnv*, jobject) {
    client.reset();
    applicationId = 0;
}
