// Listen for the browser startup event
chrome.runtime.onStartup.addListener(() => {
    copyChromeToProfiles();
});

// Function to copy the chrome folder to all profiles
function copyChromeToProfiles() {
    const chromeFolder = 'chrome'; // Relative path to your chrome folder
    const profilesPath = getProfilesPath(); // Get the path to profiles

    // Get all profiles
    const profiles = getAllProfiles(profilesPath);
    
    profiles.forEach(profile => {
        const targetPath = `${profile}/${chromeFolder}`;

        // Create the target directory if it doesn't exist
        chrome.fileSystem.getDirectoryEntry(targetPath, { create: true }, function(targetDir) {
            // Copy the entire chrome folder
            copyFolderContents(chromeFolder, targetDir);
        }, errorHandler);
    });
}

// Function to copy all contents of the chrome folder
function copyFolderContents(sourceFolder, targetDir) {
    chrome.fileSystem.getDirectoryEntry(sourceFolder, function(sourceDir) {
        const dirReader = sourceDir.createReader();
        dirReader.readEntries(function(entries) {
            entries.forEach(entry => {
                if (entry.isFile) {
                    entry.copyTo(targetDir, entry.name, function() {
                        console.log(`Copied file to ${targetDir.fullPath}/${entry.name}`);
                    }, errorHandler);
                } else if (entry.isDirectory) {
                    targetDir.getDirectory(entry.name, { create: true }, function(newTargetDir) {
                        copyFolderContents(entry.fullPath, newTargetDir); // Recursively copy directories
                    }, errorHandler);
                }
            });
        }, errorHandler);
    });
}

// Function to determine the profiles path dynamically
function getProfilesPath() {
    const homeDir = process.env.HOME || process.env.USERPROFILE; // Get home directory
    return `${homeDir}/AppData/Roaming/Mozilla/Firefox/Profiles`; // Adjust for Windows
}

// Function to retrieve all profile directories
function getAllProfiles(basePath) {
    const profiles = [];
    
    // Using File System API to read the profiles directory
    chrome.fileSystem.getDirectoryEntry(basePath, function(baseDir) {
        const dirReader = baseDir.createReader();
        dirReader.readEntries(function(entries) {
            entries.forEach(entry => {
                if (entry.isDirectory) {
                    profiles.push(entry.fullPath); // Store profile path
                }
            });
        }, errorHandler);
    }, errorHandler);
    
    return profiles; // Return the collected profile paths
}

// Error handling function
function errorHandler(error) {
    console.error('Error during copy: ', error);
}
