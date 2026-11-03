//! `Math.exp`, `Math.log`, `Math.log1p`, `Math.round`, `Math.min` and `Math.max` as V8 computes
//! them. V8 implements the first three with its port of fdlibm (`src/base/ieee754.cc`, from
//! FreeBSD msun); the platform libm (glibc, wasi-libc) may differ in the last bit, so the same
//! algorithms are reproduced here operation by operation. `tests/parity.rs` checks them against
//! the `math` section of the fixtures.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::unreadable_literal,
    clippy::excessive_precision,
    clippy::float_cmp,
    clippy::many_single_char_names, // the fdlibm names
    clippy::approx_constant // fdlibm's constants spelled as in its source
)]

const LN2_HI: f64 = 6.93147180369123816490e-01; // 0x3fe62e42 fee00000
const LN2_LO: f64 = 1.90821492927058770002e-10; // 0x3dea39ef 35793c76
const TWO54: f64 = 1.80143985094819840000e+16;
const LG1: f64 = 6.666666666666735130e-01;
const LG2: f64 = 3.999999999940941908e-01;
const LG3: f64 = 2.857142874366239149e-01;
const LG4: f64 = 2.222219843214978396e-01;
const LG5: f64 = 1.818357216161805012e-01;
const LG6: f64 = 1.531383769920937332e-01;
const LG7: f64 = 1.479819860511658591e-01;

fn high_word(x: f64) -> u32 {
    (x.to_bits() >> 32) as u32
}

fn low_word(x: f64) -> u32 {
    x.to_bits() as u32
}

fn with_high_word(x: f64, high: u32) -> f64 {
    f64::from_bits((u64::from(high) << 32) | u64::from(low_word(x)))
}

fn from_words(high: u32, low: u32) -> f64 {
    f64::from_bits((u64::from(high) << 32) | u64::from(low))
}

/// `Math.exp` (fdlibm `e_exp.c` as ported by V8, with its exact `exp(1) = E`).
#[must_use]
pub fn exp(x: f64) -> f64 {
    const HALF: [f64; 2] = [0.5, -0.5];
    const O_THRESHOLD: f64 = 7.09782712893383973096e+02;
    const U_THRESHOLD: f64 = -7.45133219101941108420e+02;
    const LN2HI: [f64; 2] = [6.93147180369123816490e-01, -6.93147180369123816490e-01];
    const LN2LO: [f64; 2] = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
    const INVLN2: f64 = 1.44269504088896338700e+00;
    const P1: f64 = 1.66666666666666019037e-01;
    const P2: f64 = -2.77777777770155933842e-03;
    const P3: f64 = 6.61375632143793436117e-05;
    const P4: f64 = -1.65339022054652515390e-06;
    const P5: f64 = 4.13813679705723846039e-08;
    const E: f64 = std::f64::consts::E;
    const HUGE: f64 = 1.0e+300;
    const TWOM1000: f64 = 9.33263618503218878990e-302;
    const TWO1023: f64 = 8.988465674311579539e307;

    let mut x = x;
    let mut hi = 0.0;
    let mut lo = 0.0;
    let mut k: i32 = 0;
    let mut hx = high_word(x);
    let xsb = ((hx >> 31) & 1) as usize;
    hx &= 0x7fff_ffff;
    let pick = |pair: [f64; 2]| if xsb == 0 { pair[0] } else { pair[1] };

    if hx >= 0x4086_2E42 {
        if hx >= 0x7ff0_0000 {
            if ((hx & 0xfffff) | low_word(x)) != 0 {
                return x + x;
            }
            return if xsb == 0 { x } else { 0.0 };
        }
        if x > O_THRESHOLD {
            return f64::INFINITY;
        }
        if x < U_THRESHOLD {
            return TWOM1000 * TWOM1000;
        }
    }

    if hx > 0x3fd6_2e42 {
        if hx < 0x3FF0_A2B2 {
            if x == 1.0 {
                return E;
            }
            hi = x - pick(LN2HI);
            lo = pick(LN2LO);
            k = 1 - (xsb as i32) - (xsb as i32);
        } else {
            k = (INVLN2 * x + pick(HALF)) as i32;
            let t = f64::from(k);
            hi = x - t * LN2HI[0];
            lo = t * LN2LO[0];
        }
        x = hi - lo;
    } else if hx < 0x3e30_0000 {
        if HUGE + x > 1.0 {
            return 1.0 + x;
        }
    } else {
        k = 0;
    }

    let t = x * x;
    let twopk = if k >= -1021 {
        from_words((0x3ff0_0000_i32 + (k << 20)) as u32, 0)
    } else {
        from_words((0x3ff0_0000_i32 + ((k + 1000) << 20)) as u32, 0)
    };
    let c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if k == 0 {
        return 1.0 - ((x * c) / (c - 2.0) - x);
    }
    let y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
    if k >= -1021 {
        if k == 1024 {
            return y * 2.0 * TWO1023;
        }
        return y * twopk;
    }
    y * twopk * TWOM1000
}

/// `Math.log` (fdlibm `e_log.c`).
#[must_use]
pub fn log(x: f64) -> f64 {
    let mut x = x;
    let mut hx = high_word(x) as i32;
    let lx = low_word(x);
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        if ((hx & 0x7fff_ffff) as u32 | lx) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = high_word(x) as i32;
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000f_ffff;
    let i = (hx + 0x95f64) & 0x0010_0000;
    x = with_high_word(x, (hx | (i ^ 0x3ff0_0000)) as u32);
    k += i >> 20;
    let f = x - 1.0;
    if (0x000f_ffff & (2 + hx)) < 3 {
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            let dk = f64::from(k);
            return dk * LN2_HI + dk * LN2_LO;
        }
        let r = f * f * (0.5 - 0.333_333_333_333_333_33 * f);
        if k == 0 {
            return f - r;
        }
        let dk = f64::from(k);
        return dk * LN2_HI - ((r - dk * LN2_LO) - f);
    }
    let s = f / (2.0 + f);
    let dk = f64::from(k);
    let z = s * s;
    let mut i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f)
        }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
    }
}

/// `Math.log1p` (fdlibm `s_log1p.c`).
#[must_use]
pub fn log1p(x: f64) -> f64 {
    let hx = high_word(x) as i32;
    let ax = hx & 0x7fff_ffff;
    let mut k: i32 = 1;
    let mut f = 0.0;
    let mut c = 0.0;
    let mut hu: i32 = 0;
    if hx < 0x3FDA_827A {
        if ax >= 0x3ff0_0000 {
            return if x == -1.0 {
                f64::NEG_INFINITY
            } else {
                f64::NAN
            };
        }
        if ax < 0x3e20_0000 {
            if TWO54 + x > 0.0 && ax < 0x3c90_0000 {
                return x;
            }
            return x - x * x * 0.5;
        }
        if hx > 0 || hx <= 0xbfd2_bec4_u32 as i32 {
            k = 0;
            f = x;
            hu = 1;
        }
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    if k != 0 {
        let mut u;
        if hx < 0x4340_0000 {
            u = 1.0 + x;
            hu = high_word(u) as i32;
            k = (hu >> 20) - 1023;
            c = if k > 0 { 1.0 - (u - x) } else { x - (u - 1.0) };
            c /= u;
        } else {
            u = x;
            hu = high_word(u) as i32;
            k = (hu >> 20) - 1023;
            c = 0.0;
        }
        hu &= 0x000f_ffff;
        if hu < 0x6a09e {
            u = with_high_word(u, (hu | 0x3ff0_0000) as u32);
        } else {
            k += 1;
            u = with_high_word(u, (hu | 0x3fe0_0000) as u32);
            hu = (0x0010_0000 - hu) >> 2;
        }
        f = u - 1.0;
    }
    let hfsq = 0.5 * f * f;
    let dk = f64::from(k);
    if hu == 0 {
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            c += dk * LN2_LO;
            return dk * LN2_HI + c;
        }
        let r = hfsq * (1.0 - 0.666_666_666_666_666_66 * f);
        if k == 0 {
            return f - r;
        }
        return dk * LN2_HI - ((r - (dk * LN2_LO + c)) - f);
    }
    let s = f / (2.0 + f);
    let z = s * s;
    let r = z * (LG1 + z * (LG2 + z * (LG3 + z * (LG4 + z * (LG5 + z * (LG6 + z * LG7))))));
    if k == 0 {
        f - (hfsq - s * (hfsq + r))
    } else {
        dk * LN2_HI - ((hfsq - (s * (hfsq + r) + (dk * LN2_LO + c))) - f)
    }
}

/// `Math.round`: nearest integer, ties toward +∞, `-0` for `(-0.5, -0]`.
#[must_use]
pub fn round(x: f64) -> f64 {
    let up = x.ceil();
    if up - 0.5 > x { up - 1.0 } else { up }
}

/// `Math.min(a, b)`: `NaN` when either is `NaN`; `-0` below `+0`.
#[must_use]
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)`: `NaN` when either is `NaN`; `+0` above `-0`.
#[must_use]
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && a.is_sign_positive()) {
        a
    } else {
        b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_matches_javascript() {
        assert_eq!(round(0.5), 1.0);
        assert_eq!(round(-0.5), 0.0);
        assert!(round(-0.4).is_sign_negative());
        assert_eq!(round(-0.6), -1.0);
        assert_eq!(round(0.499_999_999_999_999_94), 0.0);
        assert_eq!(round(2.5), 3.0);
        assert!(round(f64::INFINITY).is_infinite());
    }

    #[test]
    fn special_values() {
        assert_eq!(exp(1.0), std::f64::consts::E);
        assert_eq!(exp(0.0), 1.0);
        assert_eq!(log(1.0), 0.0);
        assert_eq!(log1p(0.0), 0.0);
        assert!(log(-1.0).is_nan());
        assert!(log1p(-2.0).is_nan());
        assert_eq!(min(0.0, -0.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(max(-0.0, 0.0).to_bits(), 0.0f64.to_bits());
        assert!(max(0.0, f64::NAN).is_nan());
    }
}
