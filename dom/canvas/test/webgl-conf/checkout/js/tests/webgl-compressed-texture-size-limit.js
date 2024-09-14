/*
Copyright (c) 2019 The Khronos Group Inc.
Use of this source code is governed by an MIT-style license that can be
found in the LICENSE.txt file.
*/

'use strict';

var runCompressedTextureSizeLimitTest = function(maxArrayBufferSizeBytes, positiveCubeMapMaxSize) {

  function numLevelsFromSize(size) {
    var levels = 0;
    while ((size >> levels) > 0) {
      ++levels;
    }
    return levels;
  }

  // More formats can be added here when more texture compression extensions are enabled in WebGL.
  var validFormats = {
      COMPRESSED_RGB_S3TC_DXT1_EXT        : 0x83F0,
      COMPRESSED_RGBA_S3TC_DXT1_EXT       : 0x83F1,
      COMPRESSED_RGBA_S3TC_DXT3_EXT       : 0x83F2,
      COMPRESSED_RGBA_S3TC_DXT5_EXT       : 0x83F3,
  };

  // format specific restrictions for COMPRESSED_RGB_S3TC_DXT1_EXT and COMPRESSED_RGBA_S3TC_DXT1_EXT
  // on the byteLength of the ArrayBufferView, pixels
  function func1 (width, height)
  {
      return Math.floor((width + 3) / 4) * Math.floor((height + 3) / 4) * 8;
  }

  // format specific restrictions for COMPRESSED_RGBA_S3TC_DXT3_EXT and COMPRESSED_RGBA_S3TC_DXT5_EXT
  // on the byteLength of the ArrayBufferView, pixels
  function func2 (width, height)
  {
      return Math.floor((width + 3) / 4) * Math.floor((height + 3) / 4) * 16;
  }

  var wtu = WebGLTestUtils;
  var gl = wtu.create3DContext("example");
  var tests = [
    // More tests can be added here when more texture compression extensions are enabled in WebGL.
    // Level 0 image width and height must be a multiple of the sizeStep.
    { extension: "WEBGL_compressed_texture_s3tc", format: validFormats.COMPRESSED_RGB_S3TC_DXT1_EXT, dataType: Uint8Array, func: func1, sizeStep: 4},
    { extension: "WEBGL_compressed_texture_s3tc", format: validFormats.COMPRESSED_RGBA_S3TC_DXT1_EXT, dataType: Uint8Array, func: func1, sizeStep: 4},
    { extension: "WEBGL_compressed_texture_s3tc", format: validFormats.COMPRESSED_RGBA_S3TC_DXT3_EXT, dataType: Uint8Array, func: func2, sizeStep: 4},
    { extension: "WEBGL_compressed_texture_s3tc", format: validFormats.COMPRESSED_RGBA_S3TC_DXT5_EXT, dataType: Uint8Array, func: func2, sizeStep: 4},
  ];

  // Note: We expressly only use 2 textures because first a texture will be defined
  // using all mip levels of 1 format, then for a moment it will have mixed formats which
  // may uncover bugs.
  var targets = [
    { target: gl.TEXTURE_2D,
      maxSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      tex: gl.createTexture(),
      targets: [gl.TEXTURE_2D]
    },
    { target: gl.TEXTURE_CUBE_MAP,
      maxSize: gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE),
      tex: gl.createTexture(),
      targets: [
        gl.TEXTURE_CUBE_MAP_POSITIVE_X,
        gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
        gl.TEXTURE_CUBE_MAP_POSITIVE_Y,
        gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
        gl.TEXTURE_CUBE_MAP_POSITIVE_Z,
        gl.TEXTURE_CUBE_MAP_NEGATIVE_Z
      ]
    }
  ];

  function getSharedArrayBufferSize() {
    var sharedArrayBufferSize = 0;
    for (var tt = 0; tt < tests.length; ++tt) {
      var test = tests[tt];
      for (var trg = 0; trg < targets.length; ++trg) {
        var t = targets[trg];
        var bufferSizeNeeded;
        if (t.target === gl.TEXTURE_CUBE_MAP) {
          var positiveTestSize = Math.min(2048, t.maxSize);
          bufferSizeNeeded = test.func(positiveTestSize, positiveTestSize);
        } else {
          bufferSizeNeeded = test.func(t.maxSize, test.sizeStep);
        }
        if (bufferSizeNeeded > sharedArrayBufferSize) {
          sharedArrayBufferSize = bufferSizeNeeded;
        }
        bufferSizeNeeded = test.func(t.maxSize + test.sizeStep, t.maxSize + test.sizeStep);
        // ArrayBuffers can be at most 4GB (minus 1 byte).
        if (bufferSizeNeeded > sharedArrayBufferSize && bufferSizeNeeded <= maxArrayBufferSizeBytes) {
          sharedArrayBufferSize = bufferSizeNeeded;
        }
      }
    }
    return sharedArrayBufferSize;
  }

  // Share an ArrayBuffer among tests to avoid too many large allocations
  var sharedArrayBuffer = new ArrayBuffer(getSharedArrayBufferSize());

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  var trg = 0;
  var tt = 0;
  runNextTest();

  function runNextTest() {
    var t = targets[trg];

    if (tt == 0) {
      var tex = t.tex;
      gl.bindTexture(t.target, tex);

      debug("");
      debug("max size for " + wtu.glEnumToString(gl, t.target) + ": " + t.maxSize);
    }

    var test = tests[tt];
    testFormatType(t, test);
    ++tt;
    if (tt == tests.length) {
      tt = 0;
      ++trg;
      if (trg == targets.length) {
        finishTest();
        return;
      }
    }
    wtu.dispatchPromise(runNextTest);
  }

  function testFormatType(t, test) {
    var positiveTestSize = t.maxSize;
    var positiveTestOtherDimension = test.sizeStep;
    if (t.target === gl.TEXTURE_CUBE_MAP) {
      // Can't always test the maximum size since that can cause OOM:
      positiveTestSize = Math.min(positiveCubeMapMaxSize, t.maxSize);
      // Cube map textures need to be square:
      positiveTestOtherDimension = positiveTestSize;
    }
    var positiveTestLevels = numLevelsFromSize(positiveTestSize);
    var numLevels = numLevelsFromSize(t.maxSize);
    debug("");
    debug("num levels: " + numLevels + ", levels used in positive test: " + positiveTestLevels);

    debug("");

    // Query the extension and store globally so shouldBe can access it
    var ext = wtu.getExtensionWithKnownPrefixes(gl, test.extension);
    if (ext) {

      testPassed("Successfully enabled " + test.extension + " extension");

      for (var j = 0; j < t.targets.length; ++j) {
        var target = t.targets[j];
        debug("");
        debug(wtu.glEnumToString(gl, target) + " " + wtu.glEnumToString(ext, test.format));

        // positive test
        var size = positiveTestSize;
        var otherDimension = positiveTestOtherDimension;
        for (var i = 0; i < positiveTestLevels; i++) {
          var pixels = new test.dataType(sharedArrayBuffer, 0, test.func(size, otherDimension));
          gl.compressedTexImage2D(target, i, test.format, size, otherDimension, 0, pixels);
          wtu.glErrorShouldBe(gl, gl.NO_ERROR, "uploading compressed texture should generate NO_ERROR."
              + "level is " + i + ", size is " + size + "x" + otherDimension);
          size /= 2;
          otherDimension /= 2;
          if (otherDimension < 1) {
              otherDimension = 1;
          }
        }

        var numLevels = numLevelsFromSize(t.maxSize);

        // out of bounds tests

        // width or height out of bounds
        if (t.target != gl.TEXTURE_CUBE_MAP) {
            // only width out of bounds
            var wideAndShortDataSize = test.func(t.maxSize + test.sizeStep, test.sizeStep);
            var pixelsNegativeTest1 = new test.dataType(sharedArrayBuffer, 0, wideAndShortDataSize);
            gl.compressedTexImage2D(target, 0, test.format, t.maxSize + test.sizeStep, test.sizeStep, 0, pixelsNegativeTest1);
            wtu.glErrorShouldBe(gl, gl.INVALID_VALUE, "width out of bounds: should generate INVALID_VALUE."
                + " level is 0, size is " + (t.maxSize + test.sizeStep) + "x" + (test.sizeStep));

            // only height out of bounds
            var narrowAndTallDataSize = test.func(test.sizeStep, t.maxSize + test.sizeStep);
            var pixelsNegativeTest1 = new test.dataType(sharedArrayBuffer, 0, narrowAndTallDataSize);
            gl.compressedTexImage2D(target, 0, test.format, test.sizeStep, t.maxSize + test.sizeStep, 0, pixelsNegativeTest1);
            wtu.glErrorShouldBe(gl, gl.INVALID_VALUE, "height out of bounds: should generate INVALID_VALUE."
                + " level is 0, size is " + (test.sizeStep) + "x" + (t.maxSize + test.sizeStep));
        }

        // both width and height out of the maximum bounds simultaneously
        var squareDataSize = test.func(t.maxSize + test.sizeStep, t.maxSize + test.sizeStep);
        // this check assumes that each element is 1 byte
        if (squareDataSize > sharedArrayBuffer.byteLength) {
          testPassed("Unable to test square texture larger than maximum size due to ArrayBuffer size limitations -- this is legal");
        } else {
          var pixelsNegativeTest1 = new test.dataType(sharedArrayBuffer, 0, squareDataSize);
          gl.compressedTexImage2D(target, 0, test.format, t.maxSize + test.sizeStep, t.maxSize + test.sizeStep, 0, pixelsNegativeTest1);
          wtu.glErrorShouldBe(gl, gl.INVALID_VALUE, "width and height out of bounds: should generate INVALID_VALUE."
              + " level is 0, size is " + (t.maxSize + test.sizeStep) + "x" + (t.maxSize + test.sizeStep));
        }

        // level out of bounds
        var pixelsNegativeTest2 = new test.dataType(sharedArrayBuffer, 0, test.func(256, 256));
        gl.compressedTexImage2D(target, numLevels, test.format, 256, 256, 0, pixelsNegativeTest2);
        wtu.glErrorShouldBe(gl, gl.INVALID_VALUE, "level out of bounds: should generate INVALID_VALUE."
            + " level is " + numLevels + ", size is 256x256");
        //width and height out of bounds for specified level
        gl.compressedTexImage2D(target, numLevels - 1, test.format, 256, 256, 0, pixelsNegativeTest2);
        wtu.glErrorShouldBe(gl, gl.INVALID_VALUE, "width or height out of bounds for specified level: should generate INVALID_VALUE."
            + " level is " + (numLevels - 1) + ", size is 256x256");
      }
    }
    else {
      testPassed("No " + test.extension + " extension support -- this is legal");
    }
  }

};
