import java.util.Properties
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

android {
    compileSdk = 36
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
// Keep in sync if the generated class changes upstream.
val webviewKt = file("src/main/java/dev/yumeo/yumusic/generated/RustWebView.kt")
fun patchRustWebView() {
    if (!webviewKt.exists()) return
    val buggy = "return cookieManager.getCookie(url)"
    val fixed = "return cookieManager.getCookie(url) ?: \"\""
    val text = webviewKt.readText()
    if (fixed in text || buggy !in text) return
    webviewKt.writeText(text.replace(buggy, fixed))
    println("[patch-android] null-safe RustWebView.getCookies applied")
}

gradle.taskGraph.whenReady { patchRustWebView() }
tasks.matching { it.name.startsWith("rustBuild") }.configureEach {
    doFirst { patchRustWebView() }
}
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    doFirst { patchRustWebView() }
}

dependencies {
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
