
/*
Copyright (c) 2019 The Khronos Group Inc.
Use of this source code is governed by an MIT-style license that can be
found in the LICENSE.txt file.
*/


void main()
{
    int i, j, k;
    float f;
    i = j, k, f;
    i = (j, k, f);   // float cannot be assigned to int
    gl_Position = vec4(1);
}
