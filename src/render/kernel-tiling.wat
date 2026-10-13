(module
;; The tiling pattern sampler (render.js tiling()), one row span at a time: the same IEEE operations in the same order as
;; the JS closure, so the composited pixels are byte-identical. JS copies pixels, coverage and clip in, and the cell,
;; the column table and the parameter block pb (f64 slots, byte offsets in wasm-tiling.js) live in kernel memory.
;; Exports: tile_fmod (x % y as JS), tile_aligned (axis-aligned, column table), tile_affine (rotated or skewed: the
;; stateful walk, its state kept in pb slots 24..27).

;; ToUint8Clamp: NaN and <= 0 → 0, >= 255 → 255, else round half to even
(func $c8 (param $v f64) (result i32)
  (if (result i32) (f64.gt (local.get $v) (f64.const 0))
    (then
      (if (result i32) (f64.ge (local.get $v) (f64.const 255))
        (then (i32.const 255))
        (else (i32.trunc_f64_u (f64.nearest (local.get $v))))))
    (else (i32.const 0))))

;; a Uint8ClampedArray element: d += (o - d) * a
(func $blend (param $q i32) (param $o f64) (param $a f64)
  (local $d f64)
  (local.set $d (f64.convert_i32_u (i32.load8_u (local.get $q))))
  (i32.store8 (local.get $q)
    (call $c8 (f64.add (local.get $d) (f64.mul (f64.sub (local.get $o) (local.get $d)) (local.get $a))))))

;; one pixel at p (4 bytes), with a = coverage × alpha × clip × (sample alpha / 255), as paintWith composites it
(func $comp (param $p i32) (param $a f64) (param $o0 f64) (param $o1 f64) (param $o2 f64)
  (local $d3 f64)
  (if (f64.ge (local.get $a) (f64.const 1))
    (then
      (i32.store8 (local.get $p) (call $c8 (local.get $o0)))
      (i32.store8 offset=1 (local.get $p) (call $c8 (local.get $o1)))
      (i32.store8 offset=2 (local.get $p) (call $c8 (local.get $o2)))
      (i32.store8 offset=3 (local.get $p) (i32.const 255)))
    (else
      (call $blend (local.get $p) (local.get $o0) (local.get $a))
      (call $blend (i32.add (local.get $p) (i32.const 1)) (local.get $o1) (local.get $a))
      (call $blend (i32.add (local.get $p) (i32.const 2)) (local.get $o2) (local.get $a))
      (local.set $d3 (f64.convert_i32_u (i32.load8_u offset=3 (local.get $p))))
      (if (f64.lt (local.get $d3) (f64.const 255))
        (then
          (i32.store8 offset=3 (local.get $p)
            (call $c8 (f64.add (local.get $d3)
                               (f64.mul (f64.sub (f64.const 255) (local.get $d3)) (local.get $a))))))))))

;; exact x % y as JS does it (musl's fmod: long division on the mantissas). Non-finite x or zero y → NaN.
(func $fmod (export "tile_fmod") (param $x f64) (param $y f64) (result f64)
  (local $ux i64) (local $uy i64) (local $ex i64) (local $ey i64) (local $sx i64) (local $i i64)
  (local.set $ux (i64.reinterpret_f64 (local.get $x)))
  (local.set $uy (i64.reinterpret_f64 (local.get $y)))
  (local.set $ex (i64.and (i64.shr_u (local.get $ux) (i64.const 52)) (i64.const 0x7ff)))
  (local.set $ey (i64.and (i64.shr_u (local.get $uy) (i64.const 52)) (i64.const 0x7ff)))
  (local.set $sx (i64.shr_u (local.get $ux) (i64.const 63)))
  (if (i32.or (i32.or (i64.eqz (i64.shl (local.get $uy) (i64.const 1)))
                      (i64.eq (local.get $ey) (i64.const 0x7ff)))
              (i64.eq (local.get $ex) (i64.const 0x7ff)))
    (then (return (f64.const nan))))
  ;; |x| <= |y|: x itself, or a signed zero when they are equal
  (if (i64.le_u (i64.shl (local.get $ux) (i64.const 1)) (i64.shl (local.get $uy) (i64.const 1)))
    (then
      (if (i64.eq (i64.shl (local.get $ux) (i64.const 1)) (i64.shl (local.get $uy) (i64.const 1)))
        (then (return (f64.reinterpret_i64 (i64.shl (local.get $sx) (i64.const 63))))))
      (return (local.get $x))))
  ;; normalize x (a subnormal: mantissa shifted up, exponent lowered)
  (if (i64.eqz (local.get $ex))
    (then
      (local.set $i (i64.shl (local.get $ux) (i64.const 12)))
      (block $dx (loop $lx
        (br_if $dx (i64.ne (i64.shr_u (local.get $i) (i64.const 63)) (i64.const 0)))
        (local.set $ex (i64.sub (local.get $ex) (i64.const 1)))
        (local.set $i (i64.shl (local.get $i) (i64.const 1)))
        (br $lx)))
      (local.set $ux (i64.shl (local.get $ux) (i64.sub (i64.const 1) (local.get $ex)))))
    (else
      (local.set $ux (i64.or (i64.and (local.get $ux) (i64.const 0x000fffffffffffff))
                             (i64.const 0x0010000000000000)))))
  (if (i64.eqz (local.get $ey))
    (then
      (local.set $i (i64.shl (local.get $uy) (i64.const 12)))
      (block $dy (loop $ly
        (br_if $dy (i64.ne (i64.shr_u (local.get $i) (i64.const 63)) (i64.const 0)))
        (local.set $ey (i64.sub (local.get $ey) (i64.const 1)))
        (local.set $i (i64.shl (local.get $i) (i64.const 1)))
        (br $ly)))
      (local.set $uy (i64.shl (local.get $uy) (i64.sub (i64.const 1) (local.get $ey)))))
    (else
      (local.set $uy (i64.or (i64.and (local.get $uy) (i64.const 0x000fffffffffffff))
                             (i64.const 0x0010000000000000)))))
  ;; x mod y, one bit at a time
  (block $dm (loop $lm
    (br_if $dm (i64.le_s (local.get $ex) (local.get $ey)))
    (local.set $i (i64.sub (local.get $ux) (local.get $uy)))
    (if (i64.eqz (i64.shr_u (local.get $i) (i64.const 63)))
      (then
        (if (i64.eqz (local.get $i))
          (then (return (f64.reinterpret_i64 (i64.shl (local.get $sx) (i64.const 63))))))
        (local.set $ux (local.get $i))))
    (local.set $ux (i64.shl (local.get $ux) (i64.const 1)))
    (local.set $ex (i64.sub (local.get $ex) (i64.const 1)))
    (br $lm)))
  (local.set $i (i64.sub (local.get $ux) (local.get $uy)))
  (if (i64.eqz (i64.shr_u (local.get $i) (i64.const 63)))
    (then
      (if (i64.eqz (local.get $i))
        (then (return (f64.reinterpret_i64 (i64.shl (local.get $sx) (i64.const 63))))))
      (local.set $ux (local.get $i))))
  (block $dn (loop $ln
    (br_if $dn (i64.ne (i64.shr_u (local.get $ux) (i64.const 52)) (i64.const 0)))
    (local.set $ux (i64.shl (local.get $ux) (i64.const 1)))
    (local.set $ex (i64.sub (local.get $ex) (i64.const 1)))
    (br $ln)))
  ;; scale the result back
  (if (i64.gt_s (local.get $ex) (i64.const 0))
    (then
      (local.set $ux (i64.sub (local.get $ux) (i64.const 0x0010000000000000)))
      (local.set $ux (i64.or (local.get $ux) (i64.shl (local.get $ex) (i64.const 52)))))
    (else
      (local.set $ux (i64.shr_u (local.get $ux) (i64.sub (i64.const 1) (local.get $ex))))))
  (f64.reinterpret_i64 (i64.or (local.get $ux) (i64.shl (local.get $sx) (i64.const 63)))))

;; JS: u %= step; if (u < 0) u += step; f = u * k - 0.5; if (f >= n - 0.5) f -= n
(func $wrapc (param $u f64) (param $step f64) (param $k f64) (param $n f64) (result f64)
  (local $f f64)
  (local.set $u (call $fmod (local.get $u) (local.get $step)))
  (if (f64.lt (local.get $u) (f64.const 0))
    (then (local.set $u (f64.add (local.get $u) (local.get $step)))))
  (local.set $f (f64.sub (f64.mul (local.get $u) (local.get $k)) (f64.const 0.5)))
  (if (f64.ge (local.get $f) (f64.sub (local.get $n) (f64.const 0.5)))
    (then (local.set $f (f64.sub (local.get $f) (local.get $n)))))
  (local.get $f))

;; ((c00·w00 + c10·w10) + c01·w01) + c11·w11, the bytes at the four addresses (as JS sums them)
(func $dot (param $a00 i32) (param $a10 i32) (param $a01 i32) (param $a11 i32)
  (param $w00 f64) (param $w10 f64) (param $w01 f64) (param $w11 f64) (result f64)
  (f64.add
    (f64.add
      (f64.add
        (f64.mul (f64.convert_i32_u (i32.load8_u (local.get $a00))) (local.get $w00))
        (f64.mul (f64.convert_i32_u (i32.load8_u (local.get $a10))) (local.get $w10)))
      (f64.mul (f64.convert_i32_u (i32.load8_u (local.get $a01))) (local.get $w01)))
    (f64.mul (f64.convert_i32_u (i32.load8_u (local.get $a11))) (local.get $w11))))

;; the bilinear sample of the cell at (X0, X1) × (Y0, Y1) (cell row offsets, already times cw) with weights tx, ty.
;; Writes pb[28..31] = r, g, b, alpha / 255 and returns 1; returns 0 when the alpha is under 0.5 (not painted).
(func $samp (param $X0 f64) (param $X1 f64) (param $tx f64) (param $Y0 f64) (param $Y1 f64) (param $ty f64)
  (param $cell i32) (param $pb i32) (result i32)
  (local $i00 i32) (local $i10 i32) (local $i01 i32) (local $i11 i32)
  (local $w00 f64) (local $w10 f64) (local $w01 f64) (local $w11 f64) (local $sa f64) (local $k f64)
  (local.set $i00 (i32.add (local.get $cell) (i32.shl (i32.trunc_f64_s (f64.add (local.get $Y0) (local.get $X0))) (i32.const 2))))
  (local.set $i10 (i32.add (local.get $cell) (i32.shl (i32.trunc_f64_s (f64.add (local.get $Y0) (local.get $X1))) (i32.const 2))))
  (local.set $i01 (i32.add (local.get $cell) (i32.shl (i32.trunc_f64_s (f64.add (local.get $Y1) (local.get $X0))) (i32.const 2))))
  (local.set $i11 (i32.add (local.get $cell) (i32.shl (i32.trunc_f64_s (f64.add (local.get $Y1) (local.get $X1))) (i32.const 2))))
  (local.set $w00 (f64.mul (f64.sub (f64.const 1) (local.get $tx)) (f64.sub (f64.const 1) (local.get $ty))))
  (local.set $w10 (f64.mul (local.get $tx) (f64.sub (f64.const 1) (local.get $ty))))
  (local.set $w01 (f64.mul (f64.sub (f64.const 1) (local.get $tx)) (local.get $ty)))
  (local.set $w11 (f64.mul (local.get $tx) (local.get $ty)))
  (local.set $sa (call $dot
    (i32.add (local.get $i00) (i32.const 3)) (i32.add (local.get $i10) (i32.const 3))
    (i32.add (local.get $i01) (i32.const 3)) (i32.add (local.get $i11) (i32.const 3))
    (local.get $w00) (local.get $w10) (local.get $w01) (local.get $w11)))
  (if (f64.lt (local.get $sa) (f64.const 0.5)) (then (return (i32.const 0))))
  (if (f64.ne (f64.load offset=24 (local.get $pb)) (f64.const 0))
    (then
      ;; uncoloured: the pattern's colour (slots 4..6)
      (f64.store offset=224 (local.get $pb) (f64.load offset=32 (local.get $pb)))
      (f64.store offset=232 (local.get $pb) (f64.load offset=40 (local.get $pb)))
      (f64.store offset=240 (local.get $pb) (f64.load offset=48 (local.get $pb))))
    (else
      ;; coloured: the cell's premultiplied colour over its alpha
      (local.set $k (f64.div (f64.const 255) (local.get $sa)))
      (f64.store offset=224 (local.get $pb)
        (f64.mul (call $dot (local.get $i00) (local.get $i10) (local.get $i01) (local.get $i11)
                   (local.get $w00) (local.get $w10) (local.get $w01) (local.get $w11)) (local.get $k)))
      (f64.store offset=232 (local.get $pb)
        (f64.mul (call $dot (i32.add (local.get $i00) (i32.const 1)) (i32.add (local.get $i10) (i32.const 1))
                   (i32.add (local.get $i01) (i32.const 1)) (i32.add (local.get $i11) (i32.const 1))
                   (local.get $w00) (local.get $w10) (local.get $w01) (local.get $w11)) (local.get $k)))
      (f64.store offset=240 (local.get $pb)
        (f64.mul (call $dot (i32.add (local.get $i00) (i32.const 2)) (i32.add (local.get $i10) (i32.const 2))
                   (i32.add (local.get $i01) (i32.const 2)) (i32.add (local.get $i11) (i32.const 2))
                   (local.get $w00) (local.get $w10) (local.get $w01) (local.get $w11)) (local.get $k)))))
  (f64.store offset=248 (local.get $pb) (f64.div (local.get $sa) (f64.const 255)))
  (i32.const 1))

;; axis-aligned: per pixel i of the span (device column xa + i), the column table cols[x] = (X0, X1, tx) (24 bytes each),
;; and the row's Y0, Y1, ty in pb slots 7..9. dst: 4 bytes per pixel; cov: f32 per pixel; clip: u8 per pixel or 0.
(func (export "tile_aligned")
  (param $dst i32) (param $n i32) (param $cov i32) (param $clip i32) (param $cols i32) (param $cell i32)
  (param $pb i32) (param $xa i32)
  (local $i i32) (local $a f64) (local $cp i32)
  (block $done (loop $L
    (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
    (block $next
      (local.set $a (f64.mul (f64.promote_f32 (f32.load (i32.add (local.get $cov) (i32.shl (local.get $i) (i32.const 2)))))
                             (f64.load (local.get $pb))))
      (if (local.get $clip)
        (then (local.set $a (f64.mul (local.get $a)
                (f64.div (f64.convert_i32_u (i32.load8_u (i32.add (local.get $clip) (local.get $i)))) (f64.const 255))))))
      (br_if $next (f64.le (local.get $a) (f64.const 0)))
      (local.set $cp (i32.add (local.get $cols) (i32.mul (i32.add (local.get $xa) (local.get $i)) (i32.const 24))))
      (br_if $next (i32.eqz (call $samp
        (f64.load (local.get $cp)) (f64.load offset=8 (local.get $cp)) (f64.load offset=16 (local.get $cp))
        (f64.load offset=56 (local.get $pb)) (f64.load offset=64 (local.get $pb)) (f64.load offset=72 (local.get $pb))
        (local.get $cell) (local.get $pb))))
      (local.set $a (f64.mul (local.get $a) (f64.load offset=248 (local.get $pb))))
      (br_if $next (f64.le (local.get $a) (f64.const 0)))
      (call $comp (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 2))) (local.get $a)
        (f64.load offset=224 (local.get $pb)) (f64.load offset=232 (local.get $pb)) (f64.load offset=240 (local.get $pb))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $L))))

;; rotated or skewed: the walk of the JS closure. The cell position (FX, FY) steps by (dFX, dFY) while the pixel is the
;; next one on the same row; pb slots 24..27 hold FX, FY, lastX, lastY between calls. A pixel of no coverage does not
;; advance the walk (JS returns before sampling), so this matches it exactly. y: the row (device y + 0.5).
(func (export "tile_affine")
  (param $dst i32) (param $n i32) (param $cov i32) (param $clip i32) (param $cell i32) (param $pb i32)
  (param $xa i32) (param $y f64)
  (local $i i32) (local $a f64) (local $x f64) (local $cw f64) (local $ch f64) (local $FX f64) (local $FY f64)
  (local $x0 f64) (local $y0 f64) (local $tx f64) (local $ty f64) (local $X0 f64) (local $X1 f64)
  (local $Y0 f64) (local $Y1 f64) (local $a2 f64) (local $ok i32)
  (local.set $cw (f64.load offset=8 (local.get $pb)))
  (local.set $ch (f64.load offset=16 (local.get $pb)))
  (block $done (loop $L
    (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
    (block $next
      (local.set $a (f64.mul (f64.promote_f32 (f32.load (i32.add (local.get $cov) (i32.shl (local.get $i) (i32.const 2)))))
                             (f64.load (local.get $pb))))
      (if (local.get $clip)
        (then (local.set $a (f64.mul (local.get $a)
                (f64.div (f64.convert_i32_u (i32.load8_u (i32.add (local.get $clip) (local.get $i)))) (f64.const 255))))))
      (br_if $next (f64.le (local.get $a) (f64.const 0)))
      (local.set $x (f64.add (f64.convert_i32_s (i32.add (local.get $xa) (local.get $i))) (f64.const 0.5)))
      (if (i32.and (f64.eq (local.get $y) (f64.load offset=216 (local.get $pb)))
                   (f64.eq (local.get $x) (f64.add (f64.load offset=208 (local.get $pb)) (f64.const 1))))
        (then
          (local.set $FX (f64.add (f64.load offset=192 (local.get $pb)) (f64.load offset=176 (local.get $pb))))
          (local.set $FY (f64.add (f64.load offset=200 (local.get $pb)) (f64.load offset=184 (local.get $pb))))
          (if (f64.ge (local.get $FX) (f64.sub (local.get $cw) (f64.const 0.5)))
            (then (local.set $FX (f64.sub (local.get $FX) (local.get $cw)))))
          (if (f64.ge (local.get $FY) (f64.sub (local.get $ch) (f64.const 0.5)))
            (then (local.set $FY (f64.sub (local.get $FY) (local.get $ch)))))
          (if (i32.eqz (call $inr (local.get $FX) (local.get $FY) (local.get $cw) (local.get $ch)))
            (then
              (local.set $FX (call $wrap_x (local.get $x) (local.get $y) (local.get $pb)))
              (local.set $FY (call $wrap_y (local.get $x) (local.get $y) (local.get $pb))))))
        (else
          (local.set $FX (call $wrap_x (local.get $x) (local.get $y) (local.get $pb)))
          (local.set $FY (call $wrap_y (local.get $x) (local.get $y) (local.get $pb)))))
      (f64.store offset=208 (local.get $pb) (local.get $x))
      (f64.store offset=216 (local.get $pb) (local.get $y))
      (f64.store offset=192 (local.get $pb) (local.get $FX))
      (f64.store offset=200 (local.get $pb) (local.get $FY))
      (if (i32.eqz (call $inr (local.get $FX) (local.get $FY) (local.get $cw) (local.get $ch)))
        (then
          (f64.store offset=216 (local.get $pb) (f64.const nan))
          (br $next)))
      (local.set $x0 (f64.floor (local.get $FX)))
      (local.set $y0 (f64.floor (local.get $FY)))
      (local.set $tx (f64.sub (local.get $FX) (local.get $x0)))
      (local.set $ty (f64.sub (local.get $FY) (local.get $y0)))
      (local.set $X0 (if (result f64) (f64.lt (local.get $x0) (f64.const 0))
        (then (f64.sub (local.get $cw) (f64.const 1))) (else (local.get $x0))))
      (local.set $X1 (if (result f64) (f64.ge (f64.add (local.get $x0) (f64.const 1)) (local.get $cw))
        (then (f64.const 0)) (else (f64.add (local.get $x0) (f64.const 1)))))
      (local.set $Y0 (f64.mul
        (if (result f64) (f64.lt (local.get $y0) (f64.const 0))
          (then (f64.sub (local.get $ch) (f64.const 1))) (else (local.get $y0)))
        (local.get $cw)))
      (local.set $Y1 (f64.mul
        (if (result f64) (f64.ge (f64.add (local.get $y0) (f64.const 1)) (local.get $ch))
          (then (f64.const 0)) (else (f64.add (local.get $y0) (f64.const 1))))
        (local.get $cw)))
      (br_if $next (i32.eqz (call $samp (local.get $X0) (local.get $X1) (local.get $tx)
        (local.get $Y0) (local.get $Y1) (local.get $ty) (local.get $cell) (local.get $pb))))
      (local.set $a2 (f64.mul (local.get $a) (f64.load offset=248 (local.get $pb))))
      (br_if $next (f64.le (local.get $a2) (f64.const 0)))
      (call $comp (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 2))) (local.get $a2)
        (f64.load offset=224 (local.get $pb)) (f64.load offset=232 (local.get $pb)) (f64.load offset=240 (local.get $pb))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $L))))

;; FX / FY in range: -0.5 <= FX < cw - 0.5 and likewise for FY (NaN is out)
(func $inr (param $FX f64) (param $FY f64) (param $cw f64) (param $ch f64) (result i32)
  (i32.and
    (i32.and (f64.ge (local.get $FX) (f64.const -0.5)) (f64.lt (local.get $FX) (f64.sub (local.get $cw) (f64.const 0.5))))
    (i32.and (f64.ge (local.get $FY) (f64.const -0.5)) (f64.lt (local.get $FY) (f64.sub (local.get $ch) (f64.const 0.5))))))

;; FX computed from the point itself: wrapc(im0·x + im2·y + im4 − bx0, xs, kx, cw)
(func $wrap_x (param $x f64) (param $y f64) (param $pb i32) (result f64)
  (call $wrapc
    (f64.sub (f64.add (f64.add (f64.mul (f64.load offset=80 (local.get $pb)) (local.get $x))
                               (f64.mul (f64.load offset=96 (local.get $pb)) (local.get $y)))
                      (f64.load offset=112 (local.get $pb)))
             (f64.load offset=160 (local.get $pb)))
    (f64.load offset=128 (local.get $pb)) (f64.load offset=144 (local.get $pb)) (f64.load offset=8 (local.get $pb))))

;; FY computed from the point itself: wrapc(im1·x + im3·y + im5 − by0, ys, ky, ch)
(func $wrap_y (param $x f64) (param $y f64) (param $pb i32) (result f64)
  (call $wrapc
    (f64.sub (f64.add (f64.add (f64.mul (f64.load offset=88 (local.get $pb)) (local.get $x))
                               (f64.mul (f64.load offset=104 (local.get $pb)) (local.get $y)))
                      (f64.load offset=120 (local.get $pb)))
             (f64.load offset=168 (local.get $pb)))
    (f64.load offset=136 (local.get $pb)) (f64.load offset=152 (local.get $pb)) (f64.load offset=16 (local.get $pb))))
)
