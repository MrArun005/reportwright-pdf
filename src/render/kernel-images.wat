;; Image sampling for render.js drawImage (nearest neighbour, not /Interpolate), one destination span at a time: the
;; same IEEE operations in the same order as the JS, so the pixels are byte-identical. JS (wasm-images.js) validates
;; every offset, width and step before calling in and owns the memory: the image's RGBA bytes at 0, then the span's
;; pixels, coverage (floats) and clip. Parts of build-kernel.mjs's one module: its own functions only, no memory line.
(module
  ;; ToInt32 of a double, as the JS's |0: NaN and the infinities give 0; a value past 2^31 wraps modulo 2^32
  (func $toi32 (param $t f64) (result i32)
    (local $r f64)
    (if (f64.ne (f64.sub (local.get $t) (local.get $t)) (f64.const 0)) (then (return (i32.const 0))))
    (local.set $t (f64.trunc (local.get $t)))
    (local.set $r (f64.sub (local.get $t)
      (f64.mul (f64.floor (f64.div (local.get $t) (f64.const 4294967296))) (f64.const 4294967296))))
    (if (result i32) (f64.ge (local.get $r) (f64.const 2147483648))
      (then (i32.trunc_sat_f64_s (f64.sub (local.get $r) (f64.const 4294967296))))
      (else (i32.trunc_sat_f64_s (local.get $r)))))

  ;; a double stored in a Uint8ClampedArray: NaN and below 0 → 0, 255 and above → 255, else round half to even
  (func $cl8 (param $x f64) (result i32)
    (if (result i32) (f64.gt (local.get $x) (f64.const 0))
      (then (if (result i32) (f64.ge (local.get $x) (f64.const 255))
        (then (i32.const 255))
        (else (i32.trunc_sat_f64_u (f64.nearest (local.get $x))))))
      (else (i32.const 0))))

  ;; a sample index as the JS clamps it: below 0 → 0, n or more → n - 1
  (func $clampi (param $i i32) (param $n i32) (result i32)
    (if (result i32) (i32.lt_s (local.get $i) (i32.const 0)) (then (i32.const 0))
      (else (if (result i32) (i32.ge_s (local.get $i) (local.get $n))
        (then (i32.sub (local.get $n) (i32.const 1)))
        (else (local.get $i))))))

  ;; one channel of a translucent pixel: d += (s - d) * a, as a Uint8ClampedArray element
  (func $mixc (param $q i32) (param $s f64) (param $a f64)
    (local $d f64)
    (local.set $d (f64.convert_i32_u (i32.load8_u (local.get $q))))
    (i32.store8 (local.get $q)
      (call $cl8 (f64.add (local.get $d) (f64.mul (f64.sub (local.get $s) (local.get $d)) (local.get $a))))))

  ;; the span's translucent pixel at q (RGB as mixed by a; alpha as the JS does: only below 255)
  (func $mixpx (param $q i32) (param $p i32) (param $a f64)
    (local $da f64)
    (call $mixc (local.get $q) (f64.convert_i32_u (i32.load8_u (local.get $p))) (local.get $a))
    (call $mixc (i32.add (local.get $q) (i32.const 1)) (f64.convert_i32_u (i32.load8_u offset=1 (local.get $p))) (local.get $a))
    (call $mixc (i32.add (local.get $q) (i32.const 2)) (f64.convert_i32_u (i32.load8_u offset=2 (local.get $p))) (local.get $a))
    (local.set $da (f64.convert_i32_u (i32.load8_u offset=3 (local.get $q))))
    (if (f64.lt (local.get $da) (f64.const 255))
      (then (i32.store8 offset=3 (local.get $q)
        (call $cl8 (f64.add (local.get $da) (f64.mul (f64.sub (f64.const 255) (local.get $da)) (local.get $a))))))))

  ;; an upright, unclipped span of n pixels: D (RGBA bytes, the page's), C (coverage floats), the source row of w
  ;; pixels at S, sampled at fx, fx + sx0, … (horizontal only). An opaque source pixel under full coverage is copied
  ;; as a word; the rest is mixed, as the JS's upright branch does
  (func (export "imgUpright")
    (param $D i32) (param $C i32) (param $S i32) (param $n i32) (param $w i32) (param $fx f64) (param $sx0 f64)
    (local $i i32) (local $p i32) (local $q i32) (local $cov f64) (local $sa i32) (local $a f64)
    (block $done (loop $px
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      (block $nx
        (local.set $p (i32.add (local.get $S) (i32.shl
          (call $clampi (call $toi32 (f64.add (local.get $fx) (f64.const 0.5))) (local.get $w)) (i32.const 2))))
        (local.set $q (i32.add (local.get $D) (i32.shl (local.get $i) (i32.const 2))))
        (local.set $cov (f64.promote_f32 (f32.load (i32.add (local.get $C) (i32.shl (local.get $i) (i32.const 2))))))
        (local.set $sa (i32.load8_u offset=3 (local.get $p)))
        (if (i32.and (f64.ge (local.get $cov) (f64.const 1)) (i32.eq (local.get $sa) (i32.const 255)))
          (then (i32.store (local.get $q) (i32.load (local.get $p))) (br $nx)))
        (local.set $a (f64.mul (local.get $cov) (f64.convert_i32_u (local.get $sa))))
        (local.set $a (f64.div (local.get $a) (f64.const 255)))
        (br_if $nx (f64.le (local.get $a) (f64.const 0)))
        (call $mixpx (local.get $q) (local.get $p) (local.get $a)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $fx (f64.add (local.get $fx) (local.get $sx0)))
      (br $px))))

  ;; a general span of n pixels (the JS's per-pixel loop): D, C, the clip row CL (0: none), the image RGBA at S with
  ;; w × h pixels, sampled at (fx, fy) stepping by (sx0, sy0); alpha; the fill colour (fr, fg, fb) when stencil != 0
  (func (export "imgAffine")
    (param $D i32) (param $C i32) (param $CL i32) (param $S i32) (param $w i32) (param $h i32) (param $n i32)
    (param $fx f64) (param $fy f64) (param $sx0 f64) (param $sy0 f64) (param $alpha f64)
    (param $fr f64) (param $fg f64) (param $fb f64) (param $stencil i32)
    (local $i i32) (local $p i32) (local $q i32) (local $a f64) (local $sa i32) (local $cl i32)
    (local $sr f64) (local $sg f64) (local $sb f64) (local $da f64)
    (block $done (loop $px
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      (block $nx
        (local.set $a (f64.mul (f64.promote_f32 (f32.load (i32.add (local.get $C) (i32.shl (local.get $i) (i32.const 2)))))
          (local.get $alpha)))
        (if (local.get $CL)
          (then
            (local.set $cl (i32.load8_u (i32.add (local.get $CL) (local.get $i))))
            (local.set $a (f64.mul (local.get $a) (f64.div (f64.convert_i32_u (local.get $cl)) (f64.const 255))))))
        (br_if $nx (f64.le (local.get $a) (f64.const 0)))
        (local.set $p (i32.add (local.get $S) (i32.shl (i32.add
          (i32.mul (call $clampi (call $toi32 (f64.add (local.get $fy) (f64.const 0.5))) (local.get $h)) (local.get $w))
          (call $clampi (call $toi32 (f64.add (local.get $fx) (f64.const 0.5))) (local.get $w)))
          (i32.const 2))))
        (local.set $sa (i32.load8_u offset=3 (local.get $p)))
        (br_if $nx (i32.eqz (local.get $sa)))
        (local.set $q (i32.add (local.get $D) (i32.shl (local.get $i) (i32.const 2))))
        (if (local.get $stencil)
          (then
            (local.set $sr (local.get $fr))
            (local.set $sg (local.get $fg))
            (local.set $sb (local.get $fb)))
          (else
            (local.set $sr (f64.convert_i32_u (i32.load8_u (local.get $p))))
            (local.set $sg (f64.convert_i32_u (i32.load8_u offset=1 (local.get $p))))
            (local.set $sb (f64.convert_i32_u (i32.load8_u offset=2 (local.get $p))))))
        (if (i32.and (f64.ge (local.get $a) (f64.const 1)) (i32.eq (local.get $sa) (i32.const 255)))
          (then
            (i32.store8 (local.get $q) (call $cl8 (local.get $sr)))
            (i32.store8 offset=1 (local.get $q) (call $cl8 (local.get $sg)))
            (i32.store8 offset=2 (local.get $q) (call $cl8 (local.get $sb)))
            (i32.store8 offset=3 (local.get $q) (i32.const 255))
            (br $nx)))
        ;; a *= sa / 255, then the mix (the JS's order of operations)
        (local.set $a (f64.mul (local.get $a) (f64.div (f64.convert_i32_u (local.get $sa)) (f64.const 255))))
        (call $mixc (local.get $q) (local.get $sr) (local.get $a))
        (call $mixc (i32.add (local.get $q) (i32.const 1)) (local.get $sg) (local.get $a))
        (call $mixc (i32.add (local.get $q) (i32.const 2)) (local.get $sb) (local.get $a))
        (local.set $da (f64.convert_i32_u (i32.load8_u offset=3 (local.get $q))))
        (if (f64.lt (local.get $da) (f64.const 255))
          (then (i32.store8 offset=3 (local.get $q)
            (call $cl8 (f64.add (local.get $da) (f64.mul (f64.sub (f64.const 255) (local.get $da)) (local.get $a)))))))
      )
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $fx (f64.add (local.get $fx) (local.get $sx0)))
      (local.set $fy (f64.add (local.get $fy) (local.get $sy0)))
      (br $px))))
)
