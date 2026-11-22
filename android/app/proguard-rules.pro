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

# ── CloudStream extension API ─────────────────────────────────────────────────
# A .cs3 is Dalvik bytecode compiled elsewhere. It references the CloudStream
# classes by name and is loaded through its own PathClassLoader at runtime, so
# the shrinker can see no reference to them from PRAHA's own code and would strip
# them. minifyEnabled is currently false, which is the only reason this has not
# broken a release; these rules keep that true if it is ever turned on.
-keep class com.lagradost.** { *; }
-keep interface com.lagradost.** { *; }
-dontwarn com.lagradost.**

# Extensions are deserialized into these records by field name.
-keepclassmembers class com.lagradost.** {
    <fields>;
    <init>(...);
}

# The host layer is reached reflectively too (Kotlin objects via INSTANCE).
-keep class com.praha.stream.cloudstream.** { *; }
-keep class com.praha.stream.PrahaApplication { *; }

# CloudStream's library uses kotlinx.serialization and Jackson; both rely on
# generated serializers looked up by name.
-keepattributes *Annotation*, InnerClasses, Signature, Exceptions
-keepclassmembers class **$$serializer { *; }
-keepclasseswithmembers class * {
    @kotlinx.serialization.* <methods>;
}
