/* This test is a a mash up of
     https://searchfox.org/mozilla-central/rev/559b25eb41c1cbffcb90a34e008b8288312fcd25/gfx/layers/apz/test/mochitest/browser_test_group_fission.js
     https://searchfox.org/mozilla-central/rev/559b25eb41c1cbffcb90a34e008b8288312fcd25/gfx/layers/apz/test/mochitest/helper_basic_zoom.html
     https://searchfox.org/mozilla-central/rev/559b25eb41c1cbffcb90a34e008b8288312fcd25/browser/base/content/test/forms/browser_selectpopup.js
*/

/* import-globals-from helper_browser_test_utils.js */
Services.scriptloader.loadSubScript(
  new URL("helper_browser_test_utils.js", gTestPath).href,
  this
);

async function runPopupPositionTest(parentDocumentFileName) {
  function httpURL(filename) {
    let chromeURL = getRootDirectory(gTestPath) + filename;
    return chromeURL.replace(
      "chrome://mochitests/content/",
      "http://mochi.test:8888/"
    );
  }

  function httpCrossOriginURL(filename) {
    let chromeURL = getRootDirectory(gTestPath) + filename;
    return chromeURL.replace(
      "chrome://mochitests/content/",
      "http://example.com/"
    );
  }

  const pageUrl = httpURL(parentDocumentFileName);
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, pageUrl);

  // Load the OOP iframe.
  const iframeUrl = httpCrossOriginURL(
    "helper_test_select_popup_position.html"
  );
  const iframe = await SpecialPowers.spawn(
    tab.linkedBrowser,
    [iframeUrl],
    async url => {
      const target = content.document.querySelector("iframe");
      target.src = url;
      await new Promise(resolve => {
        target.addEventListener("load", resolve, { once: true });
      });
      return target.browsingContext;
    }
  );

  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await content.wrappedJSObject.promiseApzFlushedRepaints();
    await content.wrappedJSObject.waitUntilApzStable();
  });

  const selectRect = await SpecialPowers.spawn(iframe, [], () => {
    return content.document.querySelector("select").getBoundingClientRect();
  });

  // Get focus on the select element.
  await SpecialPowers.spawn(iframe, [], async () => {
    const select = content.document.querySelector("select");
    const focusPromise = new Promise(resolve => {
      select.addEventListener("focus", resolve, { once: true });
    });
    select.focus();
    await focusPromise;
  });

  const selectPopup = await openSelectPopup();

  const popupRect = selectPopup.getBoundingClientRect();
  const popupMarginTop = parseFloat(getComputedStyle(selectPopup).marginTop);
  const popupMarginLeft = parseFloat(getComputedStyle(selectPopup).marginLeft);
  let sidebarRevampEnabled = Services.prefs.getBoolPref(
    "sidebar.revamp",
    false
  );
  let sidebarWidth;
  if (sidebarRevampEnabled) {
    const sidebar = document.querySelector("sidebar-main");
    sidebarWidth = sidebar.getBoundingClientRect().width;
  }

  info(
    `popup rect: (${popupRect.x}, ${popupRect.y}) ${popupRect.width}x${popupRect.height}`
  );
  info(`popup margins: ${popupMarginTop} / ${popupMarginLeft}`);
  info(
    `select rect: (${selectRect.x}, ${selectRect.y}) ${selectRect.width}x${selectRect.height}`
  );

  is(
    !sidebarRevampEnabled
      ? popupRect.left - popupMarginLeft
      : popupRect.left - popupMarginLeft - sidebarWidth,
    selectRect.x * 2.0,
    "select popup position x should be scaled by the desktop zoom"
  );

  // On platforms other than MaxOSX the popup menu is positioned below the
  // option element.
  if (!navigator.platform.includes("Mac")) {
    is(
      popupRect.top - popupMarginTop,
      tab.linkedBrowser.getBoundingClientRect().top +
        (selectRect.y + selectRect.height) * 2.0,
      "select popup position y should be scaled by the desktop zoom"
    );
  } else {
    // On mac it's aligned to the selected menulist option.
    const offsetToSelectedItem =
      selectPopup.querySelector("menuitem[selected]").getBoundingClientRect()
        .top - popupRect.top;
    is(
      popupRect.top - popupMarginTop + offsetToSelectedItem,
      tab.linkedBrowser.getBoundingClientRect().top + selectRect.y * 2.0,
      "select popup position y should be scaled by the desktop zoom"
    );
  }

  await hideSelectPopup();

  BrowserTestUtils.removeTab(tab);
}

add_task(async function () {
  if (!SpecialPowers.useRemoteSubframes) {
    ok(
      true,
      "popup window position in non OOP iframe will be fixed by bug 1691346"
    );
    return;
  }
  await runPopupPositionTest(
    "helper_test_select_popup_position_transformed_in_parent.html"
  );
});

add_task(async function () {
  await runPopupPositionTest("helper_test_select_popup_position_zoomed.html");
});
