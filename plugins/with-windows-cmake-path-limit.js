const { withAppBuildGradle } = require("expo/config-plugins");

const marker = "// lingban: keep generated CMake paths within Windows MAX_PATH";

function withWindowsCmakePathLimit(config) {
  if (process.platform !== "win32") return config;

  return withAppBuildGradle(config, (modConfig) => {
    const { contents } = modConfig.modResults;
    if (contents.includes(marker)) return modConfig;

    const updated = contents.replace(
      /(defaultConfig\s*\{)/,
      `$1\n        ${marker}\n        externalNativeBuild {\n            cmake {\n                arguments "-DCMAKE_OBJECT_PATH_MAX=240"\n            }\n        }`,
    );

    if (updated === contents) {
      throw new Error("Could not find defaultConfig in android/app/build.gradle");
    }

    modConfig.modResults.contents = updated;
    return modConfig;
  });
}

module.exports = withWindowsCmakePathLimit;
