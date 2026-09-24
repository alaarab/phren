plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.phren.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.phren.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    sourceSets {
        getByName("main") { assets.srcDir(file("build/generated/graphAssets")) }
    }
}

// The memory graph is the shared renderer the iOS app, web UI and VS Code
// webview run (packages/cli/browser/graph): the iOS bundler builds it, and the
// app ships the same page and script, never a transcription.
val iosGraph = rootProject.file("../ios/Phren/Resources/graph")
val bundleGraph by tasks.registering(Exec::class) {
    onlyIf { !File(iosGraph, "phren-graph.js").exists() }
    workingDir = rootProject.file("../ios")
    commandLine("node", "scripts/bundle-graph.mjs")
}
val copyGraphAssets by tasks.registering(Copy::class) {
    dependsOn(bundleGraph)
    from(iosGraph) { include("index.html", "phren-graph.js") }
    into(layout.buildDirectory.dir("generated/graphAssets/graph"))
}
tasks.named("preBuild") { dependsOn(copyGraphAssets) }

dependencies {
    implementation(project(":phrenkit"))
    implementation(libs.coroutines.android)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.activity.compose)
    implementation(libs.navigation.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.process)
    implementation(libs.glance.appwidget)
    implementation(libs.glance.material3)
    implementation(libs.work.runtime)
    testImplementation(libs.junit)
}
