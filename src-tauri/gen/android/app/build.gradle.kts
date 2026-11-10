import java.util.Properties
import java.util.zip.ZipFile
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing reads `keystore.properties` (gitignored, machine-local).
// Without the file the release build falls back to an unsigned APK instead of
// failing, so fresh clones and CI can still run assembleRelease.
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}

// Discord distributes its SDK through the Developer Portal, not Maven.
// Keep the imported dependency outside the disposable project build cache.
val discordSdkVersion = "1.10.19337"
val repositoryRoot = rootProject.projectDir.resolve("../../..").canonicalFile
val discordSdkHome = File(gradle.gradleUserHomeDir, "yumusic/discord-social-sdk/$discordSdkVersion")
val discordSdkAar = File(discordSdkHome, "discord_partner_sdk.aar")
val discordSdkNotices = File(discordSdkHome, "assets/discord-sdk/License-Notices.txt")
val discordSdkZipPath = providers.gradleProperty("discordSocialSdkZip")
    .orElse(providers.environmentVariable("DISCORD_SOCIAL_SDK_ZIP"))
    .getOrElse(".cache/DiscordSocialSdk-$discordSdkVersion.zip")
val discordSdkZip = File(discordSdkZipPath).let { if (it.isAbsolute) it else File(repositoryRoot, discordSdkZipPath) }
// Migrate an existing import even if its original download has been removed.
val legacyDiscordSdkHome = File(repositoryRoot, ".cache/discord-social-sdk")
val legacyDiscordSdkAar = File(legacyDiscordSdkHome, "discord_partner_sdk.aar")
val legacyDiscordSdkNotices = File(legacyDiscordSdkHome, "assets/discord-sdk/License-Notices.txt")
if (!discordSdkAar.exists() && legacyDiscordSdkAar.isFile && legacyDiscordSdkNotices.isFile) {
    discordSdkHome.mkdirs()
    discordSdkNotices.parentFile.mkdirs()
    legacyDiscordSdkAar.copyTo(discordSdkAar)
    legacyDiscordSdkNotices.copyTo(discordSdkNotices)
}
if (!discordSdkAar.isFile || !discordSdkNotices.isFile || (discordSdkZip.isFile && discordSdkZip.lastModified() > discordSdkAar.lastModified())) {
    check(discordSdkZip.isFile) {
        "Discord Social SDK $discordSdkVersion is not imported at $discordSdkHome. Download the C++ SDK to $discordSdkZip, or set DISCORD_SOCIAL_SDK_ZIP. See docs/android-discord.md."
    }
    ZipFile(discordSdkZip).use { archive ->
        discordSdkAar.parentFile.mkdirs()
        archive.getInputStream(archive.getEntry("discord_social_sdk/lib/release/discord_partner_sdk.aar")
            ?: error("The Discord SDK archive does not contain the Android AAR")).use { input ->
            discordSdkAar.outputStream().use { input.copyTo(it) }
        }
        archive.getInputStream(archive.getEntry("discord_social_sdk/License-Notices.txt")).use { input ->
            discordSdkNotices.parentFile.mkdirs()
            discordSdkNotices.outputStream().use { input.copyTo(it) }
        }
    }
}

// Use the AAR's headers/libraries directly: AGP's Prefab CLI treats Java 25's
// native-access warning on stderr as a fatal error.
val discordSdkNative = File(discordSdkAar.parentFile, "android")
val discordSdkStamp = File(discordSdkNative, ".extracted")
if (!discordSdkStamp.exists() || discordSdkStamp.readText() != discordSdkAar.lastModified().toString()) {
    ZipFile(discordSdkAar).use { archive ->
        archive.entries().asSequence().filter { !it.isDirectory &&
            (it.name.startsWith("jni/") || it.name.startsWith("prefab/modules/discord_partner_sdk/include/"))
        }.forEach { entry ->
            val target = File(discordSdkNative, entry.name).canonicalFile
            check(target.toPath().startsWith(discordSdkNative.canonicalFile.toPath())) { "Invalid SDK archive path" }
            target.parentFile.mkdirs()
            archive.getInputStream(entry).use { input -> target.outputStream().use { input.copyTo(it) } }
        }
    }
    discordSdkStamp.writeText(discordSdkAar.lastModified().toString())
}

android {
    compileSdk = 36
    // CI pins the NDK installed by sdkmanager; local builds keep AGP's default.
    providers.environmentVariable("NDK_VERSION").orNull?.let { ndkVersion = it }
    namespace = "dev.yumeo.yumusic"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "dev.yumeo.yumusic"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (keystorePropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    buildFeatures {
        buildConfig = true
    }
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }
    defaultConfig.externalNativeBuild.cmake.arguments += listOf(
        "-DANDROID_STL=c++_shared",
        "-DDISCORD_SDK_DIR=${discordSdkNative.invariantSeparatorsPath}"
    )
    sourceSets.getByName("main").assets.srcDir(File(discordSdkAar.parentFile, "assets"))
    testOptions.unitTests.isIncludeAndroidResources = true
}

kotlin {
    compilerOptions.jvmTarget.set(JvmTarget.JVM_1_8)
}

rust {
    rootDirRel = "../../../"
}

// The Tauri CLI rewrites generated/*.kt template files during the build,
// restoring a buggy RustWebView.getCookies that crashes the whole app with
// a NullPointerException when a URL has no cookies yet (breaks the Google
// login flow). The culprit: every rustBuild* task shells out to
// `tauri android android-studio-script`, which regenerates the Kotlin
// templates mid-build. Re-apply the null-safe fix as late as possible:
// once the task graph is ready, before each rust build task executes, and
// immediately before each Kotlin compile task runs (this last hook is the
// one that actually guarantees the fixed source reaches the compiler).
// Also give the producer our audio-aware WebView base: onResume alone does not
// prevent Chromium from suspending a hidden window between native tracks.
// Keep in sync if the generated class changes upstream.
val webviewKt = file("src/main/java/dev/yumeo/yumusic/generated/RustWebView.kt")
fun patchRustWebView() {
    if (!webviewKt.exists()) return
    val buggy = "return cookieManager.getCookie(url)"
    val fixed = "return cookieManager.getCookie(url) ?: \"\""
    val original = webviewKt.readText()
    val base = ": WebView(context)"
    val audioBase = ": dev.yumeo.yumusic.audio.BackgroundAudioWebView(context)"
    check(base in original || audioBase in original) {
        "RustWebView's generated superclass changed; update the background-audio patch"
    }
    val cookiesPatched = if (fixed in original) original else original.replace(buggy, fixed)
    val patched = cookiesPatched.replace(base, audioBase)
    if (patched == original) return
    webviewKt.writeText(patched)
    println("[patch-android] null-safe cookies and background-audio WebView applied")
}

gradle.taskGraph.whenReady { patchRustWebView() }
tasks.matching { it.name.startsWith("rustBuild") }.configureEach {
    doFirst { patchRustWebView() }
}
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    doFirst { patchRustWebView() }
}

dependencies {
    implementation(files(discordSdkAar))
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    implementation("androidx.media3:media3-session:1.11.1")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16.1")
    testImplementation("androidx.media3:media3-test-utils:1.11.1")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
