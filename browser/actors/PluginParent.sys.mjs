/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  CrashSubmit: "resource://gre/modules/CrashSubmit.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "gNavigatorBundle", function () {
  const url = "chrome://browser/locale/browser.properties";
  return Services.strings.createBundle(url);
});

export const PluginManager = {
  gmpCrashes: new Map(),

  observe(subject, topic) {
    switch (topic) {
      case "gmp-plugin-crash":
        this._registerGMPCrash(subject);
        break;
    }
  },

  _registerGMPCrash(subject) {
    let propertyBag = subject;
    if (
      !(propertyBag instanceof Ci.nsIWritablePropertyBag2) ||
      !propertyBag.hasKey("pluginID") ||
      !propertyBag.hasKey("pluginDumpID") ||
      !propertyBag.hasKey("pluginName")
    ) {
      console.error("PluginManager can not read plugin information.");
      return;
    }

    let pluginID = propertyBag.getPropertyAsUint32("pluginID");
    let pluginDumpID = propertyBag.getPropertyAsAString("pluginDumpID");
    let pluginName = propertyBag.getPropertyAsACString("pluginName");
    if (pluginDumpID) {
      this.gmpCrashes.set(pluginID, { pluginDumpID, pluginID, pluginName });
    }

    // Only the parent process gets the gmp-plugin-crash observer
    // notification, so we need to inform any content processes that
    // the GMP has crashed. This then fires PluginCrashed events in
    // all the relevant windows, which will trigger child actors being
    // created, which will contact us again, when we'll use the
    // gmpCrashes collection to respond.
    if (Services.ppmm) {
      Services.ppmm.broadcastAsyncMessage("gmp-plugin-crash", {
        pluginName,
        pluginID,
      });
    }
  },

  /**
   * Submit a crash report for a crashed plugin.
   *
   * @param pluginCrashID
   *        An object with a pluginID.
   * @param keyVals
   *        An object whose key-value pairs will be merged
   *        with the ".extra" file submitted with the report.
   *        The properties of htis object will override properties
   *        of the same name in the .extra file.
   */
  submitCrashReport(pluginCrashID, keyVals = {}) {
    let report = this.getCrashReport(pluginCrashID);
    if (!report) {
      console.error(
        `Could not find plugin dump IDs for ${JSON.stringify(pluginCrashID)}.` +
          `It is possible that a report was already submitted.`
      );
      return;
    }

    let { pluginDumpID } = report;
    lazy.CrashSubmit.submit(
      pluginDumpID,
      lazy.CrashSubmit.SUBMITTED_FROM_CRASH_TAB,
      {
        recordSubmission: true,
        extraExtraKeyVals: keyVals,
      }
    );

    this.gmpCrashes.delete(pluginCrashID.pluginID);
  },

  getCrashReport(pluginCrashID) {
    return this.gmpCrashes.get(pluginCrashID.pluginID);
  },
};

export class PluginParent extends JSWindowActorParent {
  receiveMessage(msg) {
    let browser = this.manager.rootFrameLoader.ownerElement;
    switch (msg.name) {
      case "PluginContent:ShowPluginCrashedNotification":
        this.showPluginCrashedNotification(browser, msg.data.pluginCrashID);
        break;

      default:
        console.error(
          "PluginParent did not expect to handle message ",
          msg.name
        );
        break;
    }

    return null;
  }

  /**
   * Shows a plugin-crashed notification bar for a browser that has had a
   * GMP plugin crash.
   *
   * @param browser
   *        The browser to show the notification for.
   * @param pluginCrashID
   *        The unique-per-process identifier for GMP.
   */
  showPluginCrashedNotification(browser, pluginCrashID) {
    // If there's already an existing notification bar, don't do anything.
    let notificationBox = browser.getTabBrowser().getNotificationBox(browser);
    let notification =
      notificationBox.getNotificationWithValue("plugin-crashed");

    let report = PluginManager.getCrashReport(pluginCrashID);
    if (notification || !report) {
      return;
    }

    // Configure the notification bar
    let priority = notificationBox.PRIORITY_WARNING_MEDIUM;
    let iconURL = "chrome://global/skin/icons/plugin.svg";
    let reloadLabel = lazy.gNavigatorBundle.GetStringFromName(
      "crashedpluginsMessage.reloadButton.label"
    );
    let reloadKey = lazy.gNavigatorBundle.GetStringFromName(
      "crashedpluginsMessage.reloadButton.accesskey"
    );

    let buttons = [
      {
        label: reloadLabel,
        accessKey: reloadKey,
        popup: null,
        callback() {
          browser.reload();
        },
      },
    ];

    if (AppConstants.MOZ_CRASHREPORTER) {
      let submitLabel = lazy.gNavigatorBundle.GetStringFromName(
        "crashedpluginsMessage.submitButton.label"
      );
      let submitKey = lazy.gNavigatorBundle.GetStringFromName(
        "crashedpluginsMessage.submitButton.accesskey"
      );
      let submitButton = {
        label: submitLabel,
        accessKey: submitKey,
        popup: null,
        callback: () => {
          PluginManager.submitCrashReport(pluginCrashID);
        },
      };

      buttons.push(submitButton);
    }

    // Add the "learn more" link.
    let learnMoreLink = {
      supportPage: "plugin-crashed-notificationbar",
      label: lazy.gNavigatorBundle.GetStringFromName(
        "crashedpluginsMessage.learnMore"
      ),
    };
    buttons.push(learnMoreLink);

    let messageString = lazy.gNavigatorBundle.formatStringFromName(
      "crashedpluginsMessage.title",
      [report.pluginName]
    );
    notificationBox.appendNotification(
      "plugin-crashed",
      {
        label: messageString,
        image: iconURL,
        priority,
      },
      buttons
    );
  }
}
