// CloudStream's extension API, compiled from the sources real .cs3 plugins were
// built against (see scripts/fetch-cloudstream-upstream.sh for the pinned refs).
//
// This module exists because a .cs3 file is Dalvik bytecode that links against
// `com.lagradost.cloudstream3.*` at runtime: the classes it references must be
// present in *our* APK, with the same names and signatures as in the official
// CloudStream app. Re-implementing that API by hand would drift and break
// extensions, so upstream's library is compiled verbatim.
plugins {
    kotlin("multiplatform")
    id("com.android.kotlin.multiplatform.library")
    kotlin("plugin.serialization")
}

val upstream = rootProject.file("upstream/cloudstream/library/src")
val niceHttp = rootProject.file("upstream/nicehttp/library/src/main/java")
check(upstream.isDirectory) {
    "Missing $upstream.\nRun scripts/fetch-cloudstream-upstream.sh in the repository root first."
}

// variables.gradle is applied from the Groovy root build, so the values live in
// the root project's extra properties. Kotlin DSL has no typed `ext` accessor.
val sdkCompile = rootProject.extra["compileSdkVersion"] as Int
val sdkMin = rootProject.extra["minSdkVersion"] as Int

kotlin {
    androidLibrary {
        namespace = "com.lagradost.api"
        compileSdk = sdkCompile
        minSdk = sdkMin
        compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11) }
    }

    compilerOptions {
        // expect/actual classes are upstream's style; -nowarn because the vendored
        // tree carries hundreds of deprecation notes that would bury our own.
        freeCompilerArgs.addAll("-Xexpect-actual-classes", "-nowarn")
    }

    sourceSets {
        all {
            languageSettings {
                optIn("com.lagradost.cloudstream3.InternalAPI")
                optIn("com.lagradost.cloudstream3.Prerelease")
            }
        }
        commonMain {
            kotlin.srcDir(upstream.resolve("commonMain/kotlin"))
            kotlin.srcDir(niceHttp)
            // Replaces the buildkonfig-generated object upstream uses.
            kotlin.srcDir("src/shim/kotlin")
            dependencies {
                api("androidx.annotation:annotation:1.10.0")
                api("com.fasterxml.jackson.module:jackson-module-kotlin:2.13.1")
                api("org.jsoup:jsoup:1.22.1")
                api("org.jetbrains.kotlinx:atomicfu:0.33.0")
                api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
                api("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
                api("org.jetbrains.kotlinx:kotlinx-datetime:0.8.0")
                api("org.jetbrains.kotlinx:kotlinx-io-core:0.9.1")
                api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
                api("com.fleeksoft.ksoup:ksoup:0.2.6")
                api("io.ktor:ktor-http:3.5.0")
                api("org.mozilla:rhino:1.8.1")
                api("dev.whyoleg.cryptography:cryptography-core:0.6.0")
                api("dev.whyoleg.cryptography:cryptography-provider-optimal:0.6.0")
                api("com.squareup.okhttp3:okhttp:5.3.2")
                api("com.squareup.okhttp3:okhttp-dnsoverhttps:5.3.2")
                api("org.jetbrains.kotlin:kotlin-reflect:2.4.0")
            }
        }
        androidMain {
            kotlin.srcDir(upstream.resolve("androidMain/kotlin"))
            kotlin.srcDir(upstream.resolve("jvmCommonMain/kotlin"))
            // Upstream's YouTube extractor needs NewPipeExtractor, which is JitPack-only.
            // Our replacement hands the URL to the player instead (src/androidShim).
            kotlin.exclude("**/YoutubeExtractor.jvmCommon.kt")
            kotlin.srcDir("src/androidShim/kotlin")
        }
    }
}
