// META: title=validation tests for WebNN API linear operation
// META: global=window,dedicatedworker
// META: variant=?cpu
// META: variant=?gpu
// META: variant=?npu
// META: script=../resources/utils_validation.js

'use strict';

validateInputFromAnotherBuilder('linear');

validateUnaryOperation('linear', floatingPointTypes);

promise_test(async t => {
  const builder = new MLGraphBuilder(context);
  const options = {alpha: 1.5, beta: 0.3};
  const input =
      builder.input('input', {dataType: 'float32', dimensions: [1, 2, 3]});
  const output = builder.linear(input, options);
  assert_equals(output.dataType(), 'float32');
  assert_array_equals(output.shape(), [1, 2, 3]);
}, '[linear] Build with options');

promise_test(async t => {
  const builder = new MLGraphBuilder(context);
  const options = {beta: -Infinity};
  const input = builder.input('input', {dataType: 'float16', dimensions: []});
  assert_throws_js(TypeError, () => builder.linear(input, options));
}, '[linear] Throw if options.beta is -Infinity');

promise_test(async t => {
  const builder = new MLGraphBuilder(context);
  const options = {alpha: NaN};
  const input = builder.input('input', {dataType: 'float32', dimensions: [1]});
  assert_throws_js(TypeError, () => builder.linear(input, options));
}, '[linear] Throw if options.alpha is NaN');
