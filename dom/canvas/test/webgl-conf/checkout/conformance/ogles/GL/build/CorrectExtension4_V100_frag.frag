
/*
Copyright (c) 2019 The Khronos Group Inc.
Use of this source code is governed by an MIT-style license that can be
found in the LICENSE.txt file.
*/


#extension extensionfoo : enable  // warning extension not supported
#extension extensionfoo : disable  // warning extension not supported
#extension extensionfoo : warn  // warning extension not supported
#ifdef GL_ES
precision mediump float;
#endif

void main()
{
}
