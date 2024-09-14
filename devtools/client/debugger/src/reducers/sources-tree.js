/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

/**
 * Sources tree reducer
 *
 * A Source Tree is composed of:
 *
 *  - Thread Items To designate targets/threads.
 *    These are the roots of the Tree if no project directory is selected.
 *
 *  - Group Items To designates the different domains used in the website.
 *    These are direct children of threads and may contain directory or source items.
 *
 *  - Directory Items To designate all the folders.
 *    Note that each every folder has an items. The Source Tree React component is doing the magic to coallesce folders made of only one sub folder.
 *
 *  - Source Items To designate sources.
 *    They are the leaves of the Tree. (we should not have empty directories.)
 */

const IGNORED_URLS = ["debugger eval code", "XStringBundle"];
const IGNORED_EXTENSIONS = ["css", "svg", "png"];
import { isPretty, getRawSourceURL } from "../utils/source";
import { prefs } from "../utils/prefs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BinarySearch: "resource://gre/modules/BinarySearch.sys.mjs",
});

export function initialSourcesTreeState() {
  return {
    // List of all Thread Tree Items.
    // All other item types are children of these and aren't store in
    // the reducer as top level objects.
    threadItems: [],

    // List of `uniquePath` of Tree Items that are expanded.
    // This should be all but Source Tree Items.
    expanded: new Set(),

    // Reference to the currently focused Tree Item.
    // It can be any type of Tree Item.
    focusedItem: null,

    // Project root set from the Source Tree.
    // This focuses the source tree on a subset of sources.
    // This is a `uniquePath`, where ${thread} is replaced by "top-level"
    // when we picked an item from the main thread. This allows to preserve
    // the root selection on page reload.
    projectDirectoryRoot: prefs.projectDirectoryRoot,

    // The name is displayed in Source Tree header
    projectDirectoryRootName: prefs.projectDirectoryRootName,

    // Reports if the top level target is a web extension.
    // If so, we should display all web extension sources.
    isWebExtension: false,

    /**
     * Boolean, to be set to true in order to display WebExtension's content scripts
     * that are applied to the current page we are debugging.
     *
     * Covered by: browser_dbg-content-script-sources.js
     * Bound to: devtools.chrome.enabled
     *
     */
    chromeAndExtensionsEnabled: prefs.chromeAndExtensionsEnabled,
  };
}

// eslint-disable-next-line complexity
export default function update(state = initialSourcesTreeState(), action) {
  switch (action.type) {
    case "ADD_ORIGINAL_SOURCES": {
      const { generatedSourceActor } = action;
      const validOriginalSources = action.originalSources.filter(source =>
        isSourceVisibleInSourceTree(
          source,
          state.chromeAndExtensionsEnabled,
          state.isWebExtension
        )
      );
      if (!validOriginalSources.length) {
        return state;
      }
      let changed = false;
      // Fork the array only once for all the sources
      const threadItems = [...state.threadItems];
      for (const source of validOriginalSources) {
        changed |= addSource(threadItems, source, generatedSourceActor);
      }
      if (changed) {
        return {
          ...state,
          threadItems,
        };
      }
      return state;
    }
    case "INSERT_SOURCE_ACTORS": {
      // With this action, we only cover generated sources.
      // (i.e. we need something else for sourcemapped/original sources)
      // But we do want to process source actors in order to be able to display
      // distinct Source Tree Items for sources with the same URL loaded in distinct thread.
      // (And may be also later be able to highlight the many sources with the same URL loaded in a given thread)
      const newSourceActors = action.sourceActors.filter(sourceActor =>
        isSourceVisibleInSourceTree(
          sourceActor.sourceObject,
          state.chromeAndExtensionsEnabled,
          state.isWebExtension
        )
      );
      if (!newSourceActors.length) {
        return state;
      }
      let changed = false;
      // Fork the array only once for all the sources
      const threadItems = [...state.threadItems];
      for (const sourceActor of newSourceActors) {
        // We mostly wanted to read the thread of the SourceActor,
        // most of the interesting attributes are on the Source Object.
        changed |= addSource(
          threadItems,
          sourceActor.sourceObject,
          sourceActor
        );
      }
      if (changed) {
        return {
          ...state,
          threadItems,
        };
      }
      return state;
    }

    case "INSERT_THREAD":
      state = { ...state };
      addThread(state, action.newThread);
      return state;

    case "REMOVE_THREAD": {
      const { threadActorID } = action;
      const index = state.threadItems.findIndex(item => {
        return item.threadActorID == threadActorID;
      });

      if (index == -1) {
        return state;
      }

      // Also clear focusedItem and expanded items related
      // to this thread. These fields store uniquePath which starts
      // with the thread actor ID.
      let { focusedItem } = state;
      if (focusedItem && focusedItem.uniquePath.startsWith(threadActorID)) {
        focusedItem = null;
      }
      const expanded = new Set();
      for (const path of state.expanded) {
        if (!path.startsWith(threadActorID)) {
          expanded.add(path);
        }
      }

      const threadItems = [...state.threadItems];
      threadItems.splice(index, 1);
      return {
        ...state,
        threadItems,
        focusedItem,
        expanded,
      };
    }

    case "SET_EXPANDED_STATE":
      return updateExpanded(state, action);

    case "SET_FOCUSED_SOURCE_ITEM":
      return { ...state, focusedItem: action.item };

    case "SET_SELECTED_LOCATION":
      return updateSelectedLocation(state, action.location);

    case "SET_PROJECT_DIRECTORY_ROOT":
      const { uniquePath, name } = action;
      return updateProjectDirectoryRoot(state, uniquePath, name);

    case "BLACKBOX_WHOLE_SOURCES":
    case "BLACKBOX_SOURCE_RANGES": {
      const sources = action.sources || [action.source];
      return updateBlackbox(state, sources, true);
    }

    case "UNBLACKBOX_WHOLE_SOURCES": {
      const sources = action.sources || [action.source];
      return updateBlackbox(state, sources, false);
    }
  }
  return state;
}

function addThread(state, thread) {
  const threadActorID = thread.actor;
  // When processing the top level target,
  // see if we are debugging an extension.
  if (thread.isTopLevel) {
    state.isWebExtension = thread.isWebExtension;
  }
  let threadItem = state.threadItems.find(item => {
    return item.threadActorID == threadActorID;
  });
  if (!threadItem) {
    threadItem = createThreadTreeItem(threadActorID);
    state.threadItems = [...state.threadItems];
    threadItem.thread = thread;
    addSortedItem(state.threadItems, threadItem, sortThreadItems);
  } else {
    // We force updating the list to trigger mapStateToProps
    // as the getSourcesTreeSources selector is awaiting for the `thread` attribute
    // which we will set here.
    state.threadItems = [...state.threadItems];

    // Inject the reducer thread object on Thread Tree Items
    // (this is handy shortcut to have access to from React components)
    // (this is also used by sortThreadItems to sort the thread as a Tree in the Browser Toolbox)
    threadItem.thread = thread;

    // We have to remove and re-insert the thread as its order will be based on the newly set `thread` attribute
    state.threadItems = [...state.threadItems];
    state.threadItems.splice(state.threadItems.indexOf(threadItem), 1);
    addSortedItem(state.threadItems, threadItem, sortThreadItems);
  }
}

function updateBlackbox(state, sources, shouldBlackBox) {
  const threadItems = [...state.threadItems];

  for (const source of sources) {
    for (const threadItem of threadItems) {
      const sourceTreeItem = findSourceInThreadItem(source, threadItem);
      if (sourceTreeItem && sourceTreeItem.isBlackBoxed != shouldBlackBox) {
        // Replace the Item with a clone so that we get the expected React updates
        const { children } = sourceTreeItem.parent;
        children.splice(children.indexOf(sourceTreeItem), 1, {
          ...sourceTreeItem,
          isBlackBoxed: shouldBlackBox,
        });
      }
    }
  }
  return { ...state, threadItems };
}

function updateExpanded(state, action) {
  // We receive the full list of all expanded items
  // (not only the one added/removed)
  // Also assume that this action is called only if the Set changed.
  return {
    ...state,
    // Consider that the action already cloned the Set
    expanded: action.expanded,
  };
}

/**
 * Update the project directory root
 */
function updateProjectDirectoryRoot(state, uniquePath, name) {
  // Only persists root within the top level target.
  // Otherwise the thread actor ID will change on page reload and we won't match anything
  if (!uniquePath || uniquePath.startsWith("top-level")) {
    prefs.projectDirectoryRoot = uniquePath;
    prefs.projectDirectoryRootName = name;
  }

  return {
    ...state,
    projectDirectoryRoot: uniquePath,
    projectDirectoryRootName: name,
  };
}

function isSourceVisibleInSourceTree(
  source,
  chromeAndExtensionsEnabled,
  debuggeeIsWebExtension
) {
  return (
    !!source.url &&
    !IGNORED_EXTENSIONS.includes(source.displayURL.fileExtension) &&
    !IGNORED_URLS.includes(source.url) &&
    !isPretty(source) &&
    // Only accept web extension sources when the chrome pref is enabled (to allows showing content scripts),
    // or when we are debugging an extension
    (!source.isExtension ||
      chromeAndExtensionsEnabled ||
      debuggeeIsWebExtension)
  );
}

/**
 * Generic Array helper to add a new value at the right position
 * given that the array is already sorted.
 *
 * @param {Array} array
 *        The already sorted into which a value should be added.
 * @param {any} newValue
 *        The value to add in the array while keeping the array sorted.
 * @param {Function} comparator
 *        A function to compare two array values and their ordering.
 *        Follow same behavior as Array sorting function.
 */
function addSortedItem(array, newValue, comparator) {
  const index = lazy.BinarySearch.insertionIndexOf(comparator, array, newValue);
  array.splice(index, 0, newValue);
}

function addSource(threadItems, source, sourceActor) {
  // Ensure creating or fetching the related Thread Item
  let threadItem = threadItems.find(item => {
    return item.threadActorID == sourceActor.thread;
  });
  if (!threadItem) {
    threadItem = createThreadTreeItem(sourceActor.thread);
    // Note that threadItems will be cloned once to force a state update
    // by the callsite of `addSourceActor`
    addSortedItem(threadItems, threadItem, sortThreadItems);
  }

  // Then ensure creating or fetching the related Group Item
  // About `source` versus `sourceActor`:
  const { displayURL } = source;
  const { group } = displayURL;

  let groupItem = threadItem.children.find(item => {
    return item.groupName == group;
  });

  if (!groupItem) {
    groupItem = createGroupTreeItem(group, threadItem, source);
    // Copy children in order to force updating react in case we picked
    // this directory as a project root
    threadItem.children = [...threadItem.children];

    addSortedItem(threadItem.children, groupItem, sortItems);
  }

  // Then ensure creating or fetching all possibly nested Directory Item(s)
  const { path } = displayURL;
  const parentPath = path.substring(0, path.lastIndexOf("/"));
  const directoryItem = addOrGetParentDirectory(groupItem, parentPath);

  // Check if a previous source actor registered this source.
  // It happens if we load the same url multiple times, or,
  // for inline sources (=HTML pages with inline scripts).
  const existing = directoryItem.children.find(item => {
    return item.type == "source" && item.source == source;
  });
  if (existing) {
    return false;
  }

  // Finaly, create the Source Item and register it in its parent Directory Item
  const sourceItem = createSourceTreeItem(source, sourceActor, directoryItem);
  // Copy children in order to force updating react in case we picked
  // this directory as a project root
  directoryItem.children = [...directoryItem.children];
  addSortedItem(directoryItem.children, sourceItem, sortItems);

  return true;
}
/**
 * Find all the source items in tree
 * @param {Object} item - Current item node in the tree
 * @param {Function} callback
 */
function findSourceInThreadItem(source, threadItem) {
  const { displayURL } = source;
  const { group, path } = displayURL;
  const groupItem = threadItem.children.find(item => {
    return item.groupName == group;
  });
  if (!groupItem) return null;

  const parentPath = path.substring(0, path.lastIndexOf("/"));
  const directoryItem = groupItem._allGroupDirectoryItems.find(item => {
    return item.type == "directory" && item.path == parentPath;
  });
  if (!directoryItem) return null;

  return directoryItem.children.find(item => {
    return item.type == "source" && item.source == source;
  });
}

function sortItems(a, b) {
  if (a.type == "directory" && b.type == "source") {
    return -1;
  } else if (b.type == "directory" && a.type == "source") {
    return 1;
  } else if (a.type == "group" && b.type == "group") {
    return a.groupName.localeCompare(b.groupName);
  } else if (a.type == "directory" && b.type == "directory") {
    return a.path.localeCompare(b.path);
  } else if (a.type == "source" && b.type == "source") {
    return a.source.longName.localeCompare(b.source.longName);
  }
  return 0;
}

function sortThreadItems(a, b) {
  // Jest tests aren't emitting the necessary actions to populate the thread attributes.
  // Ignore sorting for them.
  if (!a.thread || !b.thread) {
    return 0;
  }

  // Top level target is always listed first
  if (a.thread.isTopLevel) {
    return -1;
  } else if (b.thread.isTopLevel) {
    return 1;
  }

  // Process targets should come next and after that frame targets
  if (a.thread.targetType == "process" && b.thread.targetType == "frame") {
    return -1;
  } else if (
    a.thread.targetType == "frame" &&
    b.thread.targetType == "process"
  ) {
    return 1;
  }

  // And we display the worker targets last.
  if (
    a.thread.targetType.endsWith("worker") &&
    !b.thread.targetType.endsWith("worker")
  ) {
    return 1;
  } else if (
    !a.thread.targetType.endsWith("worker") &&
    b.thread.targetType.endsWith("worker")
  ) {
    return -1;
  }

  // Order the process targets by their process ids
  if (a.thread.processID > b.thread.processID) {
    return 1;
  } else if (a.thread.processID < b.thread.processID) {
    return -1;
  }

  // Order the frame targets and the worker targets by their target name
  if (a.thread.targetType == "frame" && b.thread.targetType == "frame") {
    return a.thread.name.localeCompare(b.thread.name);
  } else if (
    a.thread.targetType.endsWith("worker") &&
    b.thread.targetType.endsWith("worker")
  ) {
    return a.thread.name.localeCompare(b.thread.name);
  }

  return 0;
}

/**
 * For a given URL's path, in the given group (i.e. typically a given scheme+domain),
 * return the already existing parent directory item, or create it if it doesn't exists.
 * Note that it will create all ancestors up to the Group Item.
 *
 * @param {GroupItem} groupItem
 *        The Group Item for the group where the path should be displayed.
 * @param {String} path
 *        Path of the directory for which we want a Directory Item.
 * @return {GroupItem|DirectoryItem}
 *        The parent Item where this path should be inserted.
 *        Note that it may be displayed right under the Group Item if the path is empty.
 */
function addOrGetParentDirectory(groupItem, path) {
  // We reached the top of the Tree, so return the Group Item.
  if (!path) {
    return groupItem;
  }
  // See if we have this directory already registered by a previous source
  const existing = groupItem._allGroupDirectoryItems.find(item => {
    return item.type == "directory" && item.path == path;
  });
  if (existing) {
    return existing;
  }
  // It doesn't exists, so we will create a new Directory Item.
  // But now, lookup recursively for the parent Item for this to-be-create Directory Item
  const parentPath = path.substring(0, path.lastIndexOf("/"));
  const parentDirectory = addOrGetParentDirectory(groupItem, parentPath);

  // We can now create the new Directory Item and register it in its parent Item.
  const directory = createDirectoryTreeItem(path, parentDirectory);
  // Copy children in order to force updating react in case we picked
  // this directory as a project root
  parentDirectory.children = [...parentDirectory.children];

  addSortedItem(parentDirectory.children, directory, sortItems);

  // Also maintain the list of all group items,
  // Which helps speedup querying for existing items.
  groupItem._allGroupDirectoryItems.push(directory);

  return directory;
}

/**
 * Definition of all Items of a SourceTree
 */
// Highlights the attributes that all Source Tree Item should expose
function createBaseTreeItem({ type, parent, uniquePath, children }) {
  return {
    // Can be: thread, group, directory or source
    type,
    // Reference to the parent TreeItem
    parent,
    // This attribute is used for two things:
    // * as a string key identified in the React Tree
    // * for project root in order to find the root in the tree
    // It is of the form:
    // `${ThreadActorID}|${GroupName}|${DirectoryPath}|${SourceID}`
    // Group and path/ID are optional.
    // `|` is used as separator in order to avoid having this character being used in name/path/IDs.
    uniquePath,
    // Array of TreeItem, children of this item.
    // Will be null for Source Tree Item
    children,
  };
}
function createThreadTreeItem(thread) {
  return {
    ...createBaseTreeItem({
      type: "thread",
      // Each thread is considered as an independant root item
      parent: null,
      uniquePath: thread,
      // Children of threads will only be Group Items
      children: [],
    }),

    // This will be used to set the reducer's thread object.
    // This threadActorID attribute isn't meant to be used outside of this selector.
    // A `thread` attribute will be exposed from INSERT_THREAD action.
    threadActorID: thread,
  };
}
function createGroupTreeItem(groupName, parent, source) {
  return {
    ...createBaseTreeItem({
      type: "group",
      parent,
      uniquePath: `${parent.uniquePath}|${groupName}`,
      // Children of Group can be Directory and Source items
      children: [],
    }),

    groupName,

    // When a content script appear in a web page,
    // a dedicated group is created for it and should
    // be having an extension icon.
    isForExtensionSource: source.isExtension,

    // List of all nested items for this group.
    // This helps find any nested directory in a given group without having to walk the tree.
    // This is meant to be used only by the reducer.
    _allGroupDirectoryItems: [],
  };
}
function createDirectoryTreeItem(path, parent) {
  // If the parent is a group we want to use '/' as separator
  const pathSeparator = parent.type == "directory" ? "/" : "|";

  // `path` will be the absolute path from the group/domain,
  // while we want to append only the directory name in uniquePath.
  // Also, we need to strip '/' prefix.
  const relativePath =
    parent.type == "directory"
      ? path.replace(parent.path, "").replace(/^\//, "")
      : path;

  return {
    ...createBaseTreeItem({
      type: "directory",
      parent,
      uniquePath: `${parent.uniquePath}${pathSeparator}${relativePath}`,
      // Children can be nested Directory or Source items
      children: [],
    }),

    // This is the absolute path from the "group"
    // i.e. the path from the domain name
    // For http://mozilla.org/foo/bar folder,
    // path will be:
    //   foo/bar
    path,
  };
}
function createSourceTreeItem(source, sourceActor, parent) {
  return {
    ...createBaseTreeItem({
      type: "source",
      parent,
      uniquePath: `${parent.uniquePath}|${source.id}`,
      // Sources items are leaves of the SourceTree
      children: null,
    }),

    source,
    sourceActor,
  };
}

/**
 * Update `expanded` and `focusedItem` so that we show and focus
 * the new selected source.
 *
 * @param {Object} state
 * @param {Object} selectedLocation
 *        The new location being selected.
 */
function updateSelectedLocation(state, selectedLocation) {
  const sourceItem = getSourceItemForSelectedLocation(state, selectedLocation);
  if (sourceItem) {
    // Walk up the tree to expand all ancestor items up to the root of the tree.
    const expanded = new Set(state.expanded);
    let parentDirectory = sourceItem;
    while (parentDirectory) {
      expanded.add(parentDirectory.uniquePath);
      parentDirectory = parentDirectory.parent;
    }

    return {
      ...state,
      expanded,
      focusedItem: sourceItem,
    };
  }
  return state;
}

/**
 * Get the SourceItem displayed in the SourceTree for the currently selected location.
 *
 * @param {Object} state
 * @param {Object} selectedLocation
 * @return {SourceItem}
 *        The directory source item where the given source is displayed.
 */
function getSourceItemForSelectedLocation(state, selectedLocation) {
  const { source, sourceActor } = selectedLocation;

  // Sources without URLs are not visible in the SourceTree
  if (!source.url) {
    return null;
  }

  // In the SourceTree, we never show the pretty printed sources and only
  // the minified version, so if we are selecting a pretty file, fake selecting
  // the minified version by looking up for the minified URL instead of the pretty one.
  const sourceUrl = getRawSourceURL(source.url);

  const { displayURL } = source;
  function findSourceInItem(item, path) {
    if (item.type == "source") {
      if (item.source.url == sourceUrl) {
        return item;
      }
      return null;
    }
    // Bail out if the current item doesn't match the source
    if (item.type == "thread" && item.threadActorID != sourceActor?.thread) {
      return null;
    }
    if (item.type == "group" && displayURL.group != item.groupName) {
      return null;
    }
    if (item.type == "directory" && !path.startsWith(item.path)) {
      return null;
    }
    // Otherwise, walk down the tree if this ancestor item seems to match
    for (const child of item.children) {
      const match = findSourceInItem(child, path);
      if (match) {
        return match;
      }
    }

    return null;
  }
  for (const rootItem of state.threadItems) {
    // Note that when we are setting a project root, rootItem
    // may no longer be only Thread Item, but also be Group, Directory or Source Items.
    const item = findSourceInItem(rootItem, displayURL.path);
    if (item) {
      return item;
    }
  }
  return null;
}
