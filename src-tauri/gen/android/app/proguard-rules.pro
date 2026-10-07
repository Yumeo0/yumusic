# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# The Rust side resolves the app's Kotlin classes and some of their methods
# by name over JNI (e.g. RustWebView.getCookies when the sign-in webview
# loads). R8 cannot see those lookups, so without this rule release builds
# rename/strip them and the app crashes with NoSuchMethodError.
-keep class dev.yumeo.yumusic.** { *; }