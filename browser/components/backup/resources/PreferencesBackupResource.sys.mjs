/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BackupResource } from "resource:///modules/backup/BackupResource.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SearchUtils: "resource://gre/modules/SearchUtils.sys.mjs",
});

/**
 * Class representing files that modify preferences and permissions within a user profile.
 */
export class PreferencesBackupResource extends BackupResource {
  static get key() {
    return "preferences";
  }

  static get requiresEncryption() {
    return false;
  }

  async backup(
    stagingPath,
    profilePath = PathUtils.profileDir,
    _isEncrypting = false
  ) {
    // These are files that can be simply copied into the staging folder using
    // IOUtils.copy.
    const simpleCopyFiles = [
      "xulstore.json",
      "containers.json",
      "handlers.json",
      "search.json.mozlz4",
      "user.js",
      "chrome",
    ];
    await BackupResource.copyFiles(profilePath, stagingPath, simpleCopyFiles);

    const sqliteDatabases = ["permissions.sqlite", "content-prefs.sqlite"];
    await BackupResource.copySqliteDatabases(
      profilePath,
      stagingPath,
      sqliteDatabases
    );

    // prefs.js is a special case - we have a helper function to flush the
    // current prefs state to disk off of the main thread.
    let prefsDestPath = PathUtils.join(stagingPath, "prefs.js");
    let prefsDestFile = await IOUtils.getFile(prefsDestPath);
    await Services.prefs.backupPrefFile(prefsDestFile);

    return null;
  }

  async recover(_manifestEntry, recoveryPath, destProfilePath) {
    const SEARCH_PREF_FILENAME = "search.json.mozlz4";
    const RECOVERY_SEARCH_PREF_PATH = PathUtils.join(
      recoveryPath,
      SEARCH_PREF_FILENAME
    );

    if (await IOUtils.exists(RECOVERY_SEARCH_PREF_PATH)) {
      // search.json.mozlz4 may contain hash values that need to be recomputed
      // now that the profile directory has changed.
      let searchPrefs = await IOUtils.readJSON(RECOVERY_SEARCH_PREF_PATH, {
        decompress: true,
      });

      searchPrefs.engines = searchPrefs.engines.map(engine => {
        if (engine._metaData.loadPathHash) {
          let loadPath = engine._loadPath;
          engine._metaData.loadPathHash = lazy.SearchUtils.getVerificationHash(
            loadPath,
            destProfilePath
          );
        }
        return engine;
      });

      searchPrefs.metaData.defaultEngineIdHash =
        lazy.SearchUtils.getVerificationHash(
          searchPrefs.metaData.defaultEngineId,
          destProfilePath
        );

      searchPrefs.metaData.privateDefaultEngineIdHash =
        lazy.SearchUtils.getVerificationHash(
          searchPrefs.metaData.privateDefaultEngineId,
          destProfilePath
        );

      await IOUtils.writeJSON(
        PathUtils.join(destProfilePath, SEARCH_PREF_FILENAME),
        searchPrefs,
        { compress: true }
      );
    }

    const simpleCopyFiles = [
      "prefs.js",
      "xulstore.json",
      "permissions.sqlite",
      "content-prefs.sqlite",
      "containers.json",
      "handlers.json",
      "user.js",
      "chrome",
    ];
    await BackupResource.copyFiles(
      recoveryPath,
      destProfilePath,
      simpleCopyFiles
    );

    return null;
  }

  async measure(profilePath = PathUtils.profileDir) {
    const files = [
      "prefs.js",
      "xulstore.json",
      "permissions.sqlite",
      "content-prefs.sqlite",
      "containers.json",
      "handlers.json",
      "search.json.mozlz4",
      "user.js",
    ];
    let fullSize = 0;

    for (let filePath of files) {
      let resourcePath = PathUtils.join(profilePath, filePath);
      let resourceSize = await BackupResource.getFileSize(resourcePath);
      if (Number.isInteger(resourceSize)) {
        fullSize += resourceSize;
      }
    }

    const chromeDirectoryPath = PathUtils.join(profilePath, "chrome");
    let chromeDirectorySize = await BackupResource.getDirectorySize(
      chromeDirectoryPath
    );
    if (Number.isInteger(chromeDirectorySize)) {
      fullSize += chromeDirectorySize;
    }

    Glean.browserBackup.preferencesSize.set(fullSize);
  }
}
