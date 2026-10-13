(module
  ;; one row span of an axial shading's table indices (shading.js span, type 2): t steps by dt per pixel, the same
  ;; double adds in the same order as the JS loop, so the indices are identical. JS validates every argument.
  ;; The radial span is kernel.wat's `radial` (the same quadratic, sqrt and circle checks); it is not repeated here.
  (func (export "axial")
    (param $I i32) (param $m i32) (param $t f64) (param $dt f64) (param $e0 i32) (param $e1 i32)
    (param $n f64) (param $out i32)
    (local $i i32) (local $v i32) (local $ni i32)
    (local.set $ni (i32.trunc_sat_f64_s (local.get $n)))
    (block $done (loop $px
      (br_if $done (i32.ge_s (local.get $i) (local.get $m)))
      (local.set $v
        (if (result i32) (f64.lt (local.get $t) (f64.const 0))
          (then (select (i32.const 0) (local.get $out) (local.get $e0)))
          (else (if (result i32) (f64.gt (local.get $t) (f64.const 1))
            (then (select (local.get $ni) (local.get $out) (local.get $e1)))
            (else (i32.trunc_sat_f64_s (f64.add (f64.mul (local.get $t) (local.get $n)) (f64.const 0.5))))))))
      (i32.store (i32.add (local.get $I) (i32.shl (local.get $i) (i32.const 2))) (local.get $v))
      (local.set $t (f64.add (local.get $t) (local.get $dt)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $px))))
)
