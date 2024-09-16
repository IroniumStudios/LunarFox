# ![Logo](browser/branding/nightly/default64.png) LunarFox

a sleak and modern web browser that uses the FireFox source code as its base, as of now this project aims to improve the web development of many users who think that web browsers are too complex and require too much space to work

If you found a bug, please file it at https://damonicproducts.wixsite.com/smithcloud/support.

## Building -- Windows
+ as of now i only support windows build guids, if you wish to build on linux you can follow the original FireFox build guid since this browser uses that source code

## 1. Downloading the needed tools and running commands

+ make sure to download the MozillaBuild tools [`here`](https://ftp.mozilla.org/pub/mozilla/libraries/win32/MozillaBuildSetup-Latest.exe).

+ after downloading the mozillabuild files, and completing the setup process, open the mozilla-build folder in your C:\ directory and right click on the start-shell.bat and run it as admin, then cd into the repo {Wherever you may have it stored.}

+ downloading python is an important factor, which you can get [`here`](https://www.python.org/ftp/python/3.12.6/python-3.12.6-amd64.exe).

## 2. To start the build process run the following command.

```bash
./mach build
```

## 3. to Start the project run the following command.

```bash
python3 runconfig.py
```