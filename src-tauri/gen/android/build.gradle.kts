buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.13.2")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.3.21")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

subprojects {
    // Tauri includes Kotlin sources from Cargo's cache. Kotlin's incremental
    // cache cannot relativize their paths when that cache is on another drive.
    if (projectDir.toPath().root != rootProject.projectDir.toPath().root) {
        // Set the property before Kotlin configures its compiler tasks.
        extensions.extraProperties["kotlin.incremental"] = false
    }
}

tasks.register("clean").configure {
    delete("build")
}

