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
        targetSdk = 37
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_25
        targetCompatibility = JavaVersion.VERSION_25
    }
    // Bouncy Castle and sshj each ship the same license files; the app's notices cover them.
    packaging {
        resources.excludes += setOf("META-INF/LICENSE.md", "META-INF/NOTICE.md", "META-INF/versions/*/OSGI-INF/MANIFEST.MF")
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
// What's new reads CHANGELOG.md; Settings → Open-source notices reads the
// notices assembled from licenses/.
val copyAppDocs by tasks.registering {
    val changelog = rootProject.file("CHANGELOG.md")
    val licenses = rootProject.file("licenses")
    val out = layout.buildDirectory.dir("generated/graphAssets")
    inputs.file(changelog); inputs.dir(licenses); outputs.dir(out)
    doLast {
        val dir = out.get().asFile.apply { mkdirs() }
        changelog.copyTo(File(dir, "CHANGELOG.md"), overwrite = true)
        val notices = StringBuilder("Open-source notices for phren for Android\n\n")
        licenses.listFiles()!!.sortedBy { it.name }.forEach { notices.append("${it.nameWithoutExtension}\n\n").append(it.readText()).append("\n\n") }
        File(dir, "ThirdPartyNotices.txt").writeText(notices.toString())
    }
}
tasks.named("preBuild") { dependsOn(copyGraphAssets, copyAppDocs) }

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
    testImplementation(kotlin("test"))
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}
